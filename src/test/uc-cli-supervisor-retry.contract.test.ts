// T1 — verify-on-stop nudge (hermes-derived). Supervisor 가 검증 실패 시 sub-agent 를 bounded 재spawn
// (실패 체크를 prompt 에 덧붙여 "고쳐라"). exactly-one-report(I1) 보존. 기본 maxVerifyRetries=0 → 단발(무회귀).
// fake 포트로만 결정론 검증(spawn 횟수·verify 횟수·report 1회·prompt 증강·narrow 재시도 조건).
import { describe, it, expect } from "vitest";
import { Supervisor, type SupervisorDeps } from "../main/app/supervisor.js";
import type { SubAgentEvent, VerificationReport, SupervisorReport, TaskSpec } from "../main/domain/orchestration.js";
import type { SubAgentPort, VerifierPort, SupervisorEgressPort } from "../main/ports/orchestration.js";

const task: TaskSpec = { prompt: "X 함수 추가해", workdir: "/tmp/work" };
const endOk: readonly SubAgentEvent[] = [{ kind: "session_end", ok: true }];
const failRep: VerificationReport = { ok: false, checks: [{ name: "build", pass: false, details: "tsc 2 errors" }] };
const okRep: VerificationReport = { ok: true, checks: [{ name: "build", pass: true }] };

/** spawn 마다 (spawnIndex 기반) 스크립트를 흘리고, 받은 prompt 를 기록하는 fake SubAgentPort. */
function countingSubAgent(scriptFor: (spawnIndex: number) => readonly SubAgentEvent[]) {
  const prompts: string[] = [];
  const port: SubAgentPort = {
    spawn(t: TaskSpec) {
      const n = prompts.length;
      prompts.push(t.prompt);
      const evs = scriptFor(n);
      return { events: (async function* () { for (const e of evs) yield e; })(), cancel: async () => {} };
    },
  };
  return { port, prompts };
}

/** 호출 순서대로 결과를 내는 fake verifier(마지막 값 반복). 호출 횟수 기록. */
function seqVerifier(seq: readonly VerificationReport[]) {
  const calls = { n: 0 };
  const verifier: VerifierPort = {
    verify: async () => { const r = seq[Math.min(calls.n, seq.length - 1)]; calls.n++; return r; },
  };
  return { verifier, calls };
}

function makeDeps(o: { subAgent: SubAgentPort; verifier?: VerifierPort; maxVerifyRetries?: number }) {
  const events: SubAgentEvent[] = [];
  const reports: SupervisorReport[] = [];
  const egress: SupervisorEgressPort = { event: (e) => events.push(e), report: (r) => reports.push(r) };
  const deps: SupervisorDeps = {
    subAgent: o.subAgent,
    egress,
    diag: { log: () => {} },
    ...(o.verifier ? { verifier: o.verifier } : {}),
    ...(o.maxVerifyRetries !== undefined ? { maxVerifyRetries: o.maxVerifyRetries } : {}),
  };
  return { deps, events, reports };
}

const hasRetryNote = (events: readonly SubAgentEvent[]): boolean =>
  events.some((e) => e.kind === "planning" && typeof e.note === "string" && e.note.includes("재시도"));

describe("UC-CLI Supervisor T1 — verify-on-stop nudge (재시도)", () => {
  it("검증 실패 → 재시도 → 통과: spawn 2회·verify 2회·report 1회(ok)·재시도 알림 forward", async () => {
    const { port, prompts } = countingSubAgent(() => endOk);
    const { verifier, calls } = seqVerifier([failRep, okRep]);
    const { deps, events, reports } = makeDeps({ subAgent: port, verifier, maxVerifyRetries: 1 });
    await new Supervisor(deps).run(task, new AbortController().signal);
    expect(prompts).toHaveLength(2);          // 1 + 1 retry
    expect(calls.n).toBe(2);                  // verify 매 시도
    expect(reports).toHaveLength(1);          // I1 — 정확히 1회
    expect(reports[0].verification.ok).toBe(true); // 최종(2차) 통과
    expect(hasRetryNote(events)).toBe(true);  // 투명성 알림
  });

  it("재시도 task 는 원본 prompt + 실패 체크(이름·details)를 덧붙인다", async () => {
    const { port, prompts } = countingSubAgent(() => endOk);
    const { verifier } = seqVerifier([failRep, okRep]);
    const { deps } = makeDeps({ subAgent: port, verifier, maxVerifyRetries: 1 });
    await new Supervisor(deps).run(task, new AbortController().signal);
    expect(prompts[0]).toBe(task.prompt);        // 1차 = 원본 그대로
    expect(prompts[1]).toContain(task.prompt);   // 2차 = 원본 포함
    expect(prompts[1]).toContain("build");       // 실패 체크 이름
    expect(prompts[1]).toContain("tsc 2 errors"); // 실패 details
  });

  it("bounded: 계속 실패해도 maxVerifyRetries 까지만(spawn 1+N), report 1회(ok=false)", async () => {
    const { port, prompts } = countingSubAgent(() => endOk);
    const { verifier, calls } = seqVerifier([failRep]); // 항상 실패
    const { deps, reports } = makeDeps({ subAgent: port, verifier, maxVerifyRetries: 2 });
    await new Supervisor(deps).run(task, new AbortController().signal);
    expect(prompts).toHaveLength(3); // 1 + 2 retries 로 상한
    expect(calls.n).toBe(3);
    expect(reports).toHaveLength(1);
    expect(reports[0].verification.ok).toBe(false);
  });

  it("검증 통과면 재시도 안 함(spawn 1회)", async () => {
    const { port, prompts } = countingSubAgent(() => endOk);
    const { verifier } = seqVerifier([okRep]);
    const { deps, reports } = makeDeps({ subAgent: port, verifier, maxVerifyRetries: 2 });
    await new Supervisor(deps).run(task, new AbortController().signal);
    expect(prompts).toHaveLength(1);
    expect(reports[0].verification.ok).toBe(true);
  });

  it("verifier 미주입이면 재시도 안 함(검증 자체 없음)", async () => {
    const { port, prompts } = countingSubAgent(() => endOk);
    const { deps, reports } = makeDeps({ subAgent: port, maxVerifyRetries: 2 }); // verifier 없음
    await new Supervisor(deps).run(task, new AbortController().signal);
    expect(prompts).toHaveLength(1);
    expect(reports[0].verification).toEqual({ ok: true, checks: [] });
  });

  it("합성 session_end(real 아님)면 검증 실패해도 재시도 안 함", async () => {
    // session_end 없이 스트림 종료 → 합성 session_end(ok:false), realSessionEnd=false
    const { port, prompts } = countingSubAgent(() => [{ kind: "text_delta", text: "no end" }]);
    const { verifier, calls } = seqVerifier([failRep]);
    const { deps, reports } = makeDeps({ subAgent: port, verifier, maxVerifyRetries: 2 });
    await new Supervisor(deps).run(task, new AbortController().signal);
    expect(prompts).toHaveLength(1); // 합성 종료엔 재시도 안 함
    expect(calls.n).toBe(1);
    expect(reports[0].sessionOk).toBe(false);
  });

  it("취소(abort) 중이면 재시도 안 함", async () => {
    const { port, prompts } = countingSubAgent(() => endOk);
    const { verifier } = seqVerifier([failRep, okRep]);
    const ac = new AbortController();
    ac.abort();
    const { deps, reports } = makeDeps({ subAgent: port, verifier, maxVerifyRetries: 2 });
    await new Supervisor(deps).run(task, ac.signal);
    expect(prompts).toHaveLength(1); // aborted → 재시도 차단
    expect(reports).toHaveLength(1);
  });

  it("기본(maxVerifyRetries 미설정=0): 검증 실패해도 단발(무회귀)", async () => {
    const { port, prompts } = countingSubAgent(() => endOk);
    const { verifier, calls } = seqVerifier([failRep]);
    const { deps, events, reports } = makeDeps({ subAgent: port, verifier }); // maxVerifyRetries 미설정
    await new Supervisor(deps).run(task, new AbortController().signal);
    expect(prompts).toHaveLength(1);
    expect(calls.n).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0].verification.ok).toBe(false);
    expect(hasRetryNote(events)).toBe(false); // 재시도 알림 없음
  });

  it("인프라 실패(verify timeout/throw = name 'verify')만이면 재시도 안 함(sub-agent 가 못 고침)", async () => {
    const { port, prompts } = countingSubAgent(() => endOk);
    const infraFail: VerificationReport = { ok: false, checks: [{ name: "verify", pass: false, details: "timeout >60000ms" }] };
    const { verifier, calls } = seqVerifier([infraFail]);
    const { deps, reports } = makeDeps({ subAgent: port, verifier, maxVerifyRetries: 2 });
    await new Supervisor(deps).run(task, new AbortController().signal);
    expect(prompts).toHaveLength(1); // 인프라 실패엔 재시도 안 함
    expect(calls.n).toBe(1);
    expect(reports[0].verification.ok).toBe(false);
  });

  it("재시도해도 session_end 는 최종 1회만 forward(중간 attempt 억제, I1b)", async () => {
    const { port } = countingSubAgent(() => endOk);
    const { verifier } = seqVerifier([failRep, okRep]); // 1차 실패 → 재시도 → 2차 통과
    const { deps, events, reports } = makeDeps({ subAgent: port, verifier, maxVerifyRetries: 1 });
    await new Supervisor(deps).run(task, new AbortController().signal);
    const endCount = events.filter((e) => e.kind === "session_end").length;
    expect(endCount).toBe(1);        // 2 attempts 지만 session_end forward 는 1회만(조기종료 방지)
    expect(reports).toHaveLength(1); // I1
  });
});
