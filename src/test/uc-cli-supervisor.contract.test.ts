// UC-CLI Supervisor 직교 계약(2a) — sub-agent supervisor 를 FAKE 포트로만 구동해 결정론 검증.
// 직교 3축: subAgent(이벤트 스트림) ⊥ verifier(검증 리포트) ⊥ egress(forward/report). spawn(실프로세스) 없이 fake 로.
// AC3(순서/terminal 1회) · AC4(실패세션도 verify) · AC2(verifier never-throws 흡수) · AC5(직교/결정론).
// 패턴: memory-orthogonality.contract.test.ts 거울(fake 포트 harness + 결정론 assert + stub-detector).
import { describe, it, expect, vi } from "vitest";
import { Supervisor, mergeStreams, type SupervisorDeps } from "../main/app/supervisor.js";
import type { SubAgentEvent, VerificationReport, SupervisorReport, TaskSpec } from "../main/domain/orchestration.js";
import type { SubAgentPort, VerifierPort, WorkspacePort, SupervisorEgressPort } from "../main/ports/orchestration.js";

/** 고정 이벤트 배열을 그대로 흘리는 fake SubAgentPort. cancel 호출 기록. */
function scriptedSubAgent(events: readonly SubAgentEvent[]) {
  const cancels: string[] = [];
  const port: SubAgentPort = {
    spawn() {
      return {
        events: (async function* () { for (const e of events) yield e; })(),
        cancel: async (reason: string) => { cancels.push(reason); },
      };
    },
  };
  return { port, cancels };
}

/** egress 캡처 — forward 된 이벤트 + report 를 순서대로 기록. */
function captureEgress() {
  const events: SubAgentEvent[] = [];
  const reports: SupervisorReport[] = [];
  const egress: SupervisorEgressPort = { event: (e) => events.push(e), report: (r) => reports.push(r) };
  return { egress, events, reports };
}

function harness(o: { subAgent: SubAgentPort; verifier?: VerifierPort; workspace?: WorkspacePort }) {
  const { egress, events, reports } = captureEgress();
  const logs: string[] = [];
  const deps: SupervisorDeps = {
    subAgent: o.subAgent,
    egress,
    diag: { log: (m) => logs.push(String(m)) },
    ...(o.verifier ? { verifier: o.verifier } : {}),
    ...(o.workspace ? { workspace: o.workspace } : {}),
  };
  return { deps, events, reports, logs };
}

const task: TaskSpec = { prompt: "X 함수 추가해", workdir: "/tmp/work" };
const okReport: VerificationReport = { ok: true, checks: [{ name: "test", pass: true }] };

describe("UC-CLI Supervisor 직교 계약 (2a, fake 포트)", () => {
  it("AC3 — sub-agent 이벤트가 인과 순서로 forward + report 정확히 1회(terminal)", async () => {
    const events: SubAgentEvent[] = [
      { kind: "planning", note: "plan" },
      { kind: "tool_use_start", tool: "edit_file" },
      { kind: "text_delta", text: "작업 중" },
      { kind: "tool_use_end", tool: "edit_file", ok: true },
      { kind: "session_end", ok: true },
    ];
    const { port } = scriptedSubAgent(events);
    const verifier: VerifierPort = { verify: async () => okReport };
    const { deps, events: fwd, reports } = harness({ subAgent: port, verifier });
    await new Supervisor(deps).run(task, new AbortController().signal);

    // forward 된 이벤트가 입력 순서 그대로(인과 보존). terminal=session_end.
    expect(fwd.map((e) => e.kind)).toEqual(["planning", "tool_use_start", "text_delta", "tool_use_end", "session_end"]);
    expect(reports).toHaveLength(1); // terminal report 정확히 1회(드롭/중복 0)
    expect(reports[0].sessionOk).toBe(true);
    expect(reports[0].verification.ok).toBe(true);
  });

  it("AC4 — sub-agent session_end ok=false(실패/중단)에도 verifier 가 실행된다", async () => {
    const { port } = scriptedSubAgent([
      { kind: "text_delta", text: "부분 작업" },
      { kind: "session_end", ok: false, reason: "interrupted" },
    ]);
    let verifyCalls = 0;
    const verifier: VerifierPort = { verify: async () => { verifyCalls++; return { ok: false, checks: [{ name: "build", pass: false, details: "tsc 2 errors" }] }; } };
    const { deps, reports } = harness({ subAgent: port, verifier });
    await new Supervisor(deps).run(task, new AbortController().signal);

    expect(verifyCalls).toBe(1);            // 실패 세션에도 verify 1회(AC4)
    expect(reports).toHaveLength(1);
    expect(reports[0].sessionOk).toBe(false); // 세션 실패 보존
    expect(reports[0].verification.ok).toBe(false); // 검증도 실패 — 둘은 독립 수치
    expect(reports[0].verification.checks[0].name).toBe("build");
  });

  it("AC2 — verifier 가 throw 해도 supervisor 는 throw 하지 않고 ok:false 리포트로 흡수(never-throws)", async () => {
    const { port } = scriptedSubAgent([{ kind: "session_end", ok: true }]);
    const verifier: VerifierPort = { verify: async () => { throw new Error("runner crashed"); } };
    const { deps, reports, logs } = harness({ subAgent: port, verifier });

    // supervisor.run 자체가 reject 하지 않음(throw 흡수).
    await expect(new Supervisor(deps).run(task, new AbortController().signal)).resolves.toBeUndefined();
    expect(reports).toHaveLength(1);                    // 리포트는 여전히 방출
    expect(reports[0].sessionOk).toBe(true);            // 세션은 성공
    expect(reports[0].verification.ok).toBe(false);     // 검증은 흡수된 실패
    expect(reports[0].verification.checks[0].details).toContain("runner crashed");
    expect(logs.some((l) => l.includes("verifier throw"))).toBe(true); // 진단 로그 흔적
  });

  it("AC2 — verifier 가 hang(영구 미응답) 해도 deadline 으로 풀려 ok:false 리포트(타임아웃 흡수)", async () => {
    vi.useFakeTimers();
    try {
      const { port } = scriptedSubAgent([{ kind: "session_end", ok: true }]);
      // 절대 resolve 안 하는 verify — supervisor 의 VERIFY_DEADLINE 가드가 풀어야 함(영구 정지 금지).
      const verifier: VerifierPort = { verify: () => new Promise<VerificationReport>(() => { /* never */ }) };
      const { deps, reports, logs } = harness({ subAgent: port, verifier });
      const done = new Supervisor(deps).run(task, new AbortController().signal);
      // session_end forward + verify 시작(microtask) 까지 진행 후 가짜 시간을 deadline(60s) 너머로 전진.
      await vi.advanceTimersByTimeAsync(61_000);
      await expect(done).resolves.toBeUndefined(); // hang 이 run 을 영구 정지시키지 않음
      expect(reports).toHaveLength(1);
      expect(reports[0].verification.ok).toBe(false);
      expect(reports[0].verification.checks[0].details).toContain("timeout");
      expect(logs.some((l) => l.includes("시간초과"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("AC5 — verifier 미주입 = 검증 생략(ok:true 중립), 결정론 리포트, crash 없음", async () => {
    const { port } = scriptedSubAgent([
      { kind: "text_delta", text: "완료" },
      { kind: "session_end", ok: true },
    ]);
    const { deps, reports } = harness({ subAgent: port }); // verifier/workspace 미주입
    await new Supervisor(deps).run(task, new AbortController().signal);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({ filesChanged: 0, additions: 0, deletions: 0, verification: { ok: true, checks: [] }, sessionOk: true });
  });

  it("AC5 — workspace 포트 주입 시 변경 수치가 리포트에 집계된다(직교: subAgent ⊥ workspace)", async () => {
    const { port } = scriptedSubAgent([
      { kind: "text_delta", text: "edit" },
      { kind: "session_end", ok: true },
    ]);
    const workspace: WorkspacePort = {
      changes: (async function* () {
        yield { added: ["a.ts"], modified: ["b.ts", "c.ts"], deleted: ["d.ts"] };
      }) as WorkspacePort["changes"],
    };
    const { deps, reports } = harness({ subAgent: port, workspace });
    await new Supervisor(deps).run(task, new AbortController().signal);
    expect(reports).toHaveLength(1);
    expect(reports[0].filesChanged).toBe(4);  // 1 add + 2 modify + 1 delete
    expect(reports[0].additions).toBe(3);     // added + modified
    expect(reports[0].deletions).toBe(1);
  });

  it("AC3 안전망 — adapter 가 session_end 없이 스트림을 끝내도 합성 session_end(ok:false) + report 1회", async () => {
    const { port } = scriptedSubAgent([{ kind: "text_delta", text: "no end" }]); // session_end 누락
    const { deps, events: fwd, reports } = harness({ subAgent: port });
    await new Supervisor(deps).run(task, new AbortController().signal);
    expect(fwd.at(-1)?.kind).toBe("session_end"); // 합성 terminal forward
    expect((fwd.at(-1) as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0].sessionOk).toBe(false);
  });

  it("P1(적대리뷰 2026-06-23) — sub-agent 이벤트 스트림이 iteration 중 reject 해도 run() 미throw + 합성 session_end + report 1회", async () => {
    // 2b(pi/opencode transport 에러)·2c(chokidar/git 권한 에러)가 실제로 칠 경로. 구판은 여기서 run() 크래시 + 리포트 0회였음.
    const port: SubAgentPort = {
      spawn() {
        return {
          events: (async function* () {
            yield { kind: "text_delta", text: "작업 중" } as SubAgentEvent;
            throw new Error("transport reset");
          })(),
          cancel: async () => {},
        };
      },
    };
    let verifyCalls = 0;
    const verifier: VerifierPort = { verify: async () => { verifyCalls++; return okReport; } };
    const { deps, events: fwd, reports } = harness({ subAgent: port, verifier });
    await expect(new Supervisor(deps).run(task, new AbortController().signal)).resolves.toBeUndefined(); // 크래시 안 함
    const term = fwd.at(-1) as Extract<SubAgentEvent, { kind: "session_end" }>;
    expect(term.kind).toBe("session_end");
    expect(term.ok).toBe(false);
    expect(term.reason).toContain("transport reset"); // 합성 terminal 이 원인 보존
    expect(verifyCalls).toBe(1);   // 스트림 에러에도 검증 수행(AC4)
    expect(reports).toHaveLength(1); // I1 — 정확히 1회(드롭 0)
    expect(reports[0].sessionOk).toBe(false);
  });

  it("P1(적대리뷰 2026-06-23) — workspace 스트림이 reject 해도 run() 미throw + report 1회(I1)", async () => {
    // sub-agent 빈 스트림(즉시 done) + workspace 가 throw → merge 가 ws reject 를 전파, supervisor 흡수.
    const port: SubAgentPort = { spawn() { return { events: (async function* () { /* 빈 */ })(), cancel: async () => {} }; } };
    const workspace: WorkspacePort = {
      changes: (async function* () { throw new Error("EACCES watch"); }) as WorkspacePort["changes"],
    };
    const { deps, reports } = harness({ subAgent: port, workspace });
    await expect(new Supervisor(deps).run(task, new AbortController().signal)).resolves.toBeUndefined();
    expect(reports).toHaveLength(1); // 크래시/드롭 없이 정확히 1회
    expect(reports[0].sessionOk).toBe(false);
  });

  it("P2(적대리뷰 2026-06-23) — 정상 완료 후 abort 리스너 해제(공유 signal 누수/stale-cancel 방지)", async () => {
    const { port, cancels } = scriptedSubAgent([{ kind: "session_end", ok: true }]);
    const ac = new AbortController();
    const { deps } = harness({ subAgent: port });
    await new Supervisor(deps).run(task, ac.signal); // 정상 완료(abort 없음)
    ac.abort(); // 완료 *후* abort — 리스너가 해제됐으면 cancel 안 불림
    await Promise.resolve();
    expect(cancels).toEqual([]); // 완료된 세션에 stale-cancel 없음(리스너 해제 증명)
  });

  it("P3(적대리뷰 round2/codex) — terminal 이후 verify 중 abort 해도 stale-cancel 없음(terminal 즉시 리스너 해제)", async () => {
    const { port, cancels } = scriptedSubAgent([{ kind: "session_end", ok: true }]);
    const ac = new AbortController();
    let releaseVerify!: () => void;
    // verify 를 수동 제어 — supervisor 가 terminal 통과 후 verify 에 park 된 사이 abort 를 끼워넣는다.
    const verifier: VerifierPort = { verify: () => new Promise<VerificationReport>((res) => { releaseVerify = () => res(okReport); }) };
    const { deps, reports } = harness({ subAgent: port, verifier });
    const done = new Supervisor(deps).run(task, ac.signal);
    await new Promise((r) => setTimeout(r, 0)); // session_end 관측 → 리스너 해제 → verify 진입까지 flush
    ac.abort();          // terminal 이후 abort — 리스너 해제됐으면 cancel 미발생
    releaseVerify();     // verify 풀어 정상 종결
    await done;
    expect(cancels).toEqual([]); // verify 창 abort 가 stale-cancel 안 걸음
    expect(reports).toHaveLength(1);
  });

  it("외부 abort → sub-agent.cancel(semantic) 호출(SIGTERM/SIGKILL 메커니즘은 adapter)", async () => {
    const cancelled: string[] = [];
    const port: SubAgentPort = {
      spawn() {
        return {
          // abort 후에도 스트림은 결국 종결(여기선 즉시 session_end ok:false 로 협조).
          events: (async function* () { yield { kind: "session_end", ok: false, reason: "cancelled" } as SubAgentEvent; })(),
          cancel: async (reason: string) => { cancelled.push(reason); },
        };
      },
    };
    const { deps, reports } = harness({ subAgent: port });
    const ac = new AbortController();
    ac.abort(); // spawn 전 이미 abort — supervisor 가 즉시 cancel 트리거
    await new Supervisor(deps).run(task, ac.signal);
    expect(cancelled.length).toBeGreaterThanOrEqual(1); // cancel(semantic) 호출됨
    expect(reports).toHaveLength(1);
    expect(reports[0].sessionOk).toBe(false);
  });

  // ── stub-detector: fake 가 실제로 supervisor 를 구동했는지(빈 통과/항상참 방지) ──
  it("stub-detector — verifier 미호출이면 검증 수치가 fake 의 그것이 아님(테스트가 vacuous 아님)", async () => {
    const { port } = scriptedSubAgent([{ kind: "session_end", ok: true }]);
    const SENTINEL = "VERIFY_SENTINEL_ZZZ";
    let called = false;
    const verifier: VerifierPort = { verify: async () => { called = true; return { ok: true, checks: [{ name: SENTINEL, pass: true }] }; } };
    const { deps, reports } = harness({ subAgent: port, verifier });
    await new Supervisor(deps).run(task, new AbortController().signal);
    expect(called).toBe(true); // verify 가 실제로 호출됨(배선 증명)
    expect(reports[0].verification.checks[0].name).toBe(SENTINEL); // fake 결과가 리포트로 관통(seam 살아있음)
  });
});

describe("mergeStreams 순서 보존 계약 (AC3 — terminal 드롭 0)", () => {
  async function collect<T>(it: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const v of it) out.push(v); return out; }

  it("단일 소스 내부 순서 엄격 보존", async () => {
    const src = (async function* () { yield 1; yield 2; yield 3; })();
    expect(await collect(mergeStreams(src))).toEqual([1, 2, 3]);
  });

  it("N 소스 모든 원소 보존(드롭 0) + 각 소스 내부 인과순서 보존", async () => {
    const a = (async function* () { yield "a1"; yield "a2"; })();
    const b = (async function* () { yield "b1"; yield "b2"; yield "b3"; })();
    const out = await collect(mergeStreams(a, b));
    expect(out.sort()).toEqual(["a1", "a2", "b1", "b2", "b3"]); // 드롭 0
    // 소스 내부 상대순서 보존(a1<a2, b1<b2<b3).
    expect(out.indexOf("a1")).toBeLessThan(out.indexOf("a2"));
    expect(out.indexOf("b1")).toBeLessThan(out.indexOf("b2"));
    expect(out.indexOf("b2")).toBeLessThan(out.indexOf("b3"));
  });

  it("빈 소스 목록 = 빈 스트림(crash 없음)", async () => {
    expect(await collect(mergeStreams<number>())).toEqual([]);
  });
});
