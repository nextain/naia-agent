// UC-CLI Supervisor × 실 verifier 통합(2c) — supervisor 에 **실 makeCommandVerifier**(fake spawn) 를 주입해
// AC4(session_end → 실제 verify → 정직 리포트 수치)를 끝-끝 증명. 2a 의 supervisor 계약은 fake verifier 였고,
// 여기선 *실 어댑터* 가 supervisor 의 verify(workdir) 호출에 반응해 ok/checks 를 채우는지 확인(배선 정합).
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { Supervisor, type SupervisorDeps } from "../main/app/supervisor.js";
import { makeCommandVerifier, type SpawnFn } from "../main/adapters/verifier-commands.js";
import type { SubAgentEvent, SupervisorReport, TaskSpec } from "../main/domain/orchestration.js";
import type { SubAgentPort, SupervisorEgressPort } from "../main/ports/orchestration.js";

/** args[0] 로 exit code 라우팅하는 fake spawn(테스트 스크립팅). */
const codeBySpawn: SpawnFn = (_command, args) => {
  const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
  (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  (child as unknown as { kill: () => boolean }).kill = () => true;
  const code = args[0] === "fail" ? 1 : 0;
  setTimeout(() => child.emit("close", code), 0);
  return child;
};

function scriptedSubAgent(events: readonly SubAgentEvent[]): SubAgentPort {
  return { spawn: () => ({ events: (async function* () { for (const e of events) yield e; })(), cancel: async () => {} }) };
}

function captureEgress() {
  const reports: SupervisorReport[] = [];
  const egress: SupervisorEgressPort = { event: () => {}, report: (r) => reports.push(r) };
  return { egress, reports };
}

const task: TaskSpec = { prompt: "X 함수 추가해", workdir: "/tmp/work" };

describe("UC-CLI Supervisor × 실 verifier 통합 (2c, AC4)", () => {
  it("AC4 — session_end(ok) → 실 verifier 가 모든 check 통과 → verification.ok:true + check 이름 보존", async () => {
    const { egress, reports } = captureEgress();
    const verifier = makeCommandVerifier({
      checks: [{ name: "test", command: "x", args: ["ok"] }, { name: "build", command: "x", args: ["ok"] }],
      spawnFn: codeBySpawn,
    });
    const deps: SupervisorDeps = { subAgent: scriptedSubAgent([{ kind: "session_end", ok: true }]), verifier, egress, diag: { log: () => {} } };
    await new Supervisor(deps).run(task, new AbortController().signal);

    expect(reports).toHaveLength(1);
    expect(reports[0].sessionOk).toBe(true);
    expect(reports[0].verification.ok).toBe(true);                    // 실 어댑터가 두 check 통과 집계
    expect(reports[0].verification.checks.map((c) => c.name)).toEqual(["test", "build"]); // 실제 수치(이름) 관통
    expect(reports[0].verification.checks.every((c) => c.pass)).toBe(true);
  });

  it("AC4 — session_end(실패/중단)에도 실 verifier 실행 + 실패 check 가 verification.ok:false 로 보고", async () => {
    const { egress, reports } = captureEgress();
    const verifier = makeCommandVerifier({
      checks: [{ name: "test", command: "x", args: ["ok"] }, { name: "build", command: "x", args: ["fail"] }],
      spawnFn: codeBySpawn,
    });
    // 세션은 실패(ok:false)지만 verify 는 항상 돈다(AC4) — 세션과 검증은 독립 수치.
    const deps: SupervisorDeps = { subAgent: scriptedSubAgent([{ kind: "session_end", ok: false, reason: "interrupted" }]), verifier, egress, diag: { log: () => {} } };
    await new Supervisor(deps).run(task, new AbortController().signal);

    expect(reports).toHaveLength(1);
    expect(reports[0].sessionOk).toBe(false);                        // 세션 실패 보존
    expect(reports[0].verification.ok).toBe(false);                  // 실 어댑터가 build 실패 집계
    const build = reports[0].verification.checks.find((c) => c.name === "build");
    expect(build?.pass).toBe(false);
    expect(build?.details).toContain("exit code 1");                 // 실 details 가 리포트로 관통
  });
});
