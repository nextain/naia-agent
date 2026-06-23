// UC-CLI wireSupervisor 합성 계약 — composition root 가 2a(supervisor)+2b(roster)+2c(verifier/workspace)를
// 실행 가능한 supervisor 로 조립하는지 end-to-end 검증. verifier 는 실 node 서브프로세스(AC4 실측).
import { describe, it, expect } from "vitest";
import { wireSupervisor } from "../main/composition/index.js";
import type { SubAgentPort, SupervisorEgressPort } from "../main/ports/orchestration.js";
import type { SubAgentEvent, SupervisorReport, TaskSpec } from "../main/domain/orchestration.js";

const NODE = process.execPath; // 크로스플랫폼 실 서브프로세스.

function scriptedSubAgent(events: readonly SubAgentEvent[]): SubAgentPort {
  return { spawn: () => ({ events: (async function* () { for (const e of events) yield e; })(), cancel: async () => {} }) };
}
function captureEgress() {
  const events: SubAgentEvent[] = [];
  const reports: SupervisorReport[] = [];
  const egress: SupervisorEgressPort = { event: (e) => events.push(e), report: (r) => reports.push(r) };
  return { egress, events, reports };
}
const task: TaskSpec = { prompt: "X 함수 추가", workdir: process.cwd() };

describe("wireSupervisor 합성 계약 (UC-CLI — 2a+2b+2c 조립)", () => {
  it("주입 sub-agent + verifier/workspace 미요청 → 오케스트레이션만(검증 생략 ok:true, 변경 0)", async () => {
    const { egress, events, reports } = captureEgress();
    const orch = wireSupervisor({ subAgent: scriptedSubAgent([{ kind: "text_delta", text: "hi" }, { kind: "session_end", ok: true }]) });
    await orch.run(task, new AbortController().signal, egress);
    expect(events.map((e) => e.kind)).toEqual(["text_delta", "session_end"]); // sub-agent 이벤트 forward
    expect(reports).toHaveLength(1);
    expect(reports[0].verification).toEqual({ ok: true, checks: [] }); // verifier 미주입 = 검증 생략
    expect(reports[0].filesChanged).toBe(0);                            // workspace 미주입 = 변경 0
    expect(reports[0].sessionOk).toBe(true);
  });

  it("verifierChecks 주입 → 실 verifier 가 session_end 후 실행(AC4) — exit 0 → ok", async () => {
    const { egress, reports } = captureEgress();
    const orch = wireSupervisor({
      subAgent: scriptedSubAgent([{ kind: "session_end", ok: true }]),
      verifierChecks: [{ name: "ok-check", command: NODE, args: ["-e", "process.exit(0)"] }],
    });
    await orch.run(task, new AbortController().signal, egress);
    expect(reports).toHaveLength(1);
    expect(reports[0].verification.ok).toBe(true);
    expect(reports[0].verification.checks[0].name).toBe("ok-check"); // 실 check 결과가 리포트로
  }, 15_000);

  it("verifierChecks 실패(exit≠0) → 검증 ok:false(never-throws — 정직보고)", async () => {
    const { egress, reports } = captureEgress();
    const orch = wireSupervisor({
      subAgent: scriptedSubAgent([{ kind: "session_end", ok: true }]),
      verifierChecks: [{ name: "fail-check", command: NODE, args: ["-e", "process.exit(3)"] }],
    });
    await orch.run(task, new AbortController().signal, egress);
    expect(reports[0].verification.ok).toBe(false);
    expect(reports[0].verification.checks[0].pass).toBe(false);
    expect(reports[0].verification.checks[0].details).toContain("exit code 3");
  }, 15_000);

  it("roster 경로 — subAgentName 'shell' + 주입 command(헤드리스 조립 증명)", async () => {
    const { egress, reports } = captureEgress();
    const orch = wireSupervisor({
      subAgentName: "shell",
      subAgentOpts: { shell: { command: NODE, args: () => ["-e", "process.stdout.write('done')"] } },
    });
    await orch.run(task, new AbortController().signal, egress);
    expect(reports).toHaveLength(1);
    expect(reports[0].sessionOk).toBe(true); // shell exit 0 → 세션 성공
  }, 15_000);

  it("roster 미지 이름 → 정직 unsupported(session_end{ok:false}, throw 아님)", async () => {
    const { egress, reports } = captureEgress();
    const orch = wireSupervisor({ subAgentName: "bogus-zzz" });
    await orch.run(task, new AbortController().signal, egress);
    expect(reports).toHaveLength(1);
    expect(reports[0].sessionOk).toBe(false); // unsupported → session_end ok:false
  });
});
