// UC-CLI delegate-agent-skill 계약(2026-06-29) — 메인 LLM 이 sub-agent 를 부리는 도구.
// fake runner 주입으로 supervisor 없이 결정론 검증: args 파싱·포맷·no-throw·agent 화이트리스트.
import { describe, it, expect } from "vitest";
import { makeDelegateAgentSkill, type DelegateRunner } from "../main/adapters/delegate-agent-skill.js";
import type { SubAgentEvent, SupervisorReport, TaskSpec } from "../main/domain/orchestration.js";
import type { ToolCall } from "../main/domain/chat.js";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const fullReport = (over: Partial<SupervisorReport> = {}): SupervisorReport => ({
  filesChanged: 1,
  additions: 1,
  deletions: 0,
  verification: { ok: true, checks: [] },
  sessionOk: true,
  ...over,
});

/** 이벤트 + 리포트를 egress 로 방출하는 fake runner. 호출 인자 캡처. */
function fakeRunner(emit: { events?: SubAgentEvent[]; report?: SupervisorReport } = {}) {
  const calls: { agent: string; task: TaskSpec }[] = [];
  const run: DelegateRunner = async (agent, task, _signal, egress) => {
    calls.push({ agent, task });
    const events = emit.events ?? [];
    for (const e of events) egress.event(e);
    egress.report(emit.report ?? fullReport());
  };
  return { run, calls };
}

const call = (args: Record<string, unknown>): ToolCall => ({ id: "t1", name: "delegate_agent", args });

describe("delegate-agent-skill 계약 (메인 LLM → sub-agent 위임 도구)", () => {
  it("specs: delegate_agent 도구 1개 + agent enum + tier=none", () => {
    const ex = makeDelegateAgentSkill({ run: fakeRunner().run, defaultWorkdir: "/w" });
    const s = ex.specs();
    expect(s).toHaveLength(1);
    expect(s[0].name).toBe("delegate_agent");
    expect(s[0].tier).toBe("none");
    const agentEnum = (s[0].parameters as unknown as { properties: { agent: { enum: readonly string[] } } }).properties.agent.enum;
    for (const a of ["gemini", "opencode", "pi", "claude-code", "codex", "shell"]) expect(agentEnum).toContain(a);
  });

  it("정상: agent+task → runner 호출(workdir 기본값) + 보고 포맷(text 포함)", async () => {
    const fr = fakeRunner({ events: [{ kind: "text_delta", text: "수정 완료" }], report: fullReport({ filesChanged: 2, additions: 3, deletions: 1 }) });
    const ex = makeDelegateAgentSkill({ run: fr.run, defaultWorkdir: "/ws" });
    const r = await ex.execute(call({ agent: "gemini", task: "버그 고쳐" }), {});
    expect(r.isError).toBeUndefined();
    expect(fr.calls[0].agent).toBe("gemini");
    expect(fr.calls[0].task.prompt).toBe("버그 고쳐");
    expect(fr.calls[0].task.workdir).toBe("/ws"); // workdir 미지정 → 기본
    expect(r.output).toContain("agent=gemini sessionOk=true filesChanged=2 (+3/-1) verification=pass");
    expect(r.output).toContain("[sub-agent 출력]");
    expect(r.output).toContain("수정 완료");
  });

  it("workdir 인자 전달 → runner 에 그대로", async () => {
    const fr = fakeRunner();
    const ex = makeDelegateAgentSkill({ run: fr.run, defaultWorkdir: "/ws", allowWorkdirOverride: true });
    await ex.execute(call({ agent: "opencode", task: "x", workdir: "/custom" }), {});
    expect(fr.calls[0].task.workdir).toBe("/custom");
  });

  it("기본은 host가 선택한 단일 workspace로 고정하고 model의 workdir override를 거부한다", async () => {
    const fr = fakeRunner();
    const ex = makeDelegateAgentSkill({ run: fr.run, defaultWorkdir: "/selected/repo" });
    const spec = ex.specs()[0].parameters as { properties: Record<string, unknown> };
    expect(spec.properties).not.toHaveProperty("workdir");
    const result = await ex.execute(call({ agent: "codex", task: "x", workdir: "/selected/other" }), {});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workdir override");
    expect(fr.calls).toHaveLength(0);
  });

  it("검증 실패 보고 → verification=fail(체크명 표시)", async () => {
    const fr = fakeRunner({ report: fullReport({ sessionOk: false, verification: { ok: false, checks: [{ name: "test", pass: false }] } }) });
    const ex = makeDelegateAgentSkill({ run: fr.run, defaultWorkdir: "/ws" });
    const r = await ex.execute(call({ agent: "codex", task: "x" }), {});
    expect(r.output).toContain("sessionOk=false");
    expect(r.output).toContain("verification=fail(test:X)");
  });

  it("no-throw: runner throw → isError:true (루프 안정)", async () => {
    const run: DelegateRunner = async () => { throw new Error("boom"); };
    const ex = makeDelegateAgentSkill({ run, defaultWorkdir: "/ws" });
    const r = await ex.execute(call({ agent: "gemini", task: "x" }), {});
    expect(r.isError).toBe(true);
    expect(r.output).toContain("러너 실패");
    expect(r.output).toContain("boom");
  });

  it("인자 검증: agent 누락/허용 외 → isError (no-throw)", async () => {
    const ex = makeDelegateAgentSkill({ run: fakeRunner().run, defaultWorkdir: "/ws" });
    const r1 = await ex.execute(call({ task: "x" }), {});
    expect(r1.isError).toBe(true);
    expect(r1.output).toContain("'agent'");
    const r2 = await ex.execute(call({ agent: "bogus", task: "x" }), {});
    expect(r2.isError).toBe(true);
    expect(r2.output).toContain("지원 안 하는 agent 'bogus'");
    const r3 = await ex.execute(call({ agent: "gemini" }), {});
    expect(r3.isError).toBe(true);
    expect(r3.output).toContain("'task'");
  });

  it("allowedAgents 화이트리스트 좁히기 → 허용 외 agent 거부", async () => {
    const ex = makeDelegateAgentSkill({ run: fakeRunner().run, defaultWorkdir: "/ws", allowedAgents: ["gemini", "opencode"] });
    const ok = await ex.execute(call({ agent: "opencode", task: "x" }), {});
    expect(ok.isError).toBeUndefined();
    const no = await ex.execute(call({ agent: "codex", task: "x" }), {});
    expect(no.isError).toBe(true);
  });

  it("allowedWorkdirRoot 밖 경로와 symlink 탈출을 거부한다", async () => {
    const base = mkdtempSync(join(tmpdir(), "naia-delegate-"));
    const root = join(base, "workspace");
    const inside = join(root, "project");
    const outside = join(base, "outside");
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(root, "escape"));
    const fr = fakeRunner();
    const ex = makeDelegateAgentSkill({
      run: fr.run, defaultWorkdir: root, allowedWorkdirRoot: root, allowedAgents: ["codex"], allowWorkdirOverride: true,
    });
    expect((await ex.execute(call({ agent: "codex", task: "ok", workdir: inside }), {})).isError).toBeUndefined();
    expect((await ex.execute(call({ agent: "codex", task: "ok", workdir: "project" }), {})).isError).toBeUndefined();
    expect((await ex.execute(call({ agent: "codex", task: "no", workdir: outside }), {})).isError).toBe(true);
    expect((await ex.execute(call({ agent: "codex", task: "no", workdir: join(root, "escape") }), {})).isError).toBe(true);
    expect(fr.calls).toHaveLength(2);
    expect(fr.calls[1]?.task.workdir).toBe(inside);
  });

  it("abort signal → 중단 결과(러너 미호출)", async () => {
    const ac = new AbortController();
    ac.abort();
    const fr = fakeRunner();
    const ex = makeDelegateAgentSkill({ run: fr.run, defaultWorkdir: "/ws" });
    const r = await ex.execute(call({ agent: "gemini", task: "x" }), { signal: ac.signal });
    expect(r.output).toContain("중단됨");
    expect(fr.calls).toHaveLength(0);
  });

  it("stub-detector — runner 가 실제 egress.event/report 호출(항상참 아님) → 출력에 반영", async () => {
    const fr = fakeRunner({ events: [{ kind: "text_delta", text: "ABC" }], report: fullReport({ sessionOk: true }) });
    const ex = makeDelegateAgentSkill({ run: fr.run, defaultWorkdir: "/ws" });
    const r = await ex.execute(call({ agent: "gemini", task: "x" }), {});
    expect(r.output).toContain("ABC");
    expect(r.output).toContain("sessionOk=true");
  });

  it("러너가 report 미방출 → '보고 없음' 안전 폴백(no-throw)", async () => {
    const run: DelegateRunner = async (_a, _t, _s, egress) => { egress.event({ kind: "text_delta", text: "x" }); /* report 생략 */ };
    const ex = makeDelegateAgentSkill({ run, defaultWorkdir: "/ws" });
    const r = await ex.execute(call({ agent: "gemini", task: "x" }), {});
    expect(r.isError).toBeUndefined();
    expect(r.output).toContain("보고 없음");
  });
});
