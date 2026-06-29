// UC-CLI subagent-claude-code 어댑터 계약(SPEC-010 확장, 2026-06-29) — claude stream-json NDJSON → SubAgentEvent
// 매핑(상태ful tool 페어링 포함) + honest-unsupported + 인터럽트. fake child(spawnFn 주입) 로 실 바이너리 없이
// 결정론 검증. resolveBin 주입으로 PATH 조회(execSync) 회피.
import { describe, it, expect } from "vitest";
import type { ChildProcess } from "node:child_process";
import { makeClaudeCodeSubAgent, createClaudeLineParser, type SpawnFn, type ResolvedBin } from "../main/adapters/subagent-claude-code.js";
import type { SubAgentEvent } from "../main/domain/orchestration.js";

const fixedBin = (): ResolvedBin => ({ command: "claude", prefixArgs: [] });

/** NDJSON 줄을 stdout 으로 흘리고 close/error/kill 을 제어하는 fake child. (pi 테스트와 동형) */
function fakeNdjson() {
  let stdoutCb: ((b: Buffer) => void) | undefined;
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const killSignals: Array<string | number> = [];
  let spawnArgs: { command: string; args: readonly string[]; cwd: string } | undefined;
  const spawnFn: SpawnFn = (command, args, o) => {
    spawnArgs = { command, args, cwd: o.cwd };
    const child = {
      stdout: { on: (_e: string, cb: (b: Buffer) => void) => { stdoutCb = cb; } },
      stderr: { on: () => {} },
      on(ev: string, cb: (...a: unknown[]) => void) { handlers[ev] = cb; return this as unknown; },
      kill(sig?: NodeJS.Signals) { killSignals.push(sig ?? "SIGTERM"); if ((sig ?? "SIGTERM") === "SIGKILL") setTimeout(() => handlers.close?.(null, "SIGKILL"), 0); return true; },
    };
    return child as unknown as ChildProcess;
  };
  return {
    spawnFn,
    line: (s: string) => stdoutCb?.(Buffer.from(s + "\n", "utf8")),
    raw: (s: string) => stdoutCb?.(Buffer.from(s, "utf8")),
    close: (code: number | null, signal: NodeJS.Signals | null = null) => handlers.close?.(code, signal),
    emitError: (msg: string) => handlers.error?.(new Error(msg)),
    get killSignals() { return killSignals; },
    get spawnArgs() { return spawnArgs!; },
  };
}

async function drain(events: AsyncIterable<SubAgentEvent>): Promise<SubAgentEvent[]> {
  const out: SubAgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("subagent-claude-code 어댑터 계약 (SPEC-010 확장, fake child)", () => {
  it("claude stream-json → SubAgentEvent 시퀀스 (planning→tool_use_start→tool_use_end→text_delta→session_end)", async () => {
    const f = fakeNdjson();
    const port = makeClaudeCodeSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "X 함수 추가해", workdir: "/tmp/w" });
    f.line('{"type":"system","subtype":"init","session_id":"s1"}');
    f.line('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_1","name":"Edit","input":{}}]}}');
    f.line('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","is_error":false}]}}');
    f.line('{"type":"assistant","message":{"content":[{"type":"text","text":"작업 완료"}]}}');
    f.close(0);
    const events = await drain(session.events);

    expect(events.map((e) => e.kind)).toEqual(["planning", "tool_use_start", "tool_use_end", "text_delta", "session_end"]);
    expect((events[1] as Extract<SubAgentEvent, { kind: "tool_use_start" }>).tool).toBe("Edit");
    expect((events[2] as Extract<SubAgentEvent, { kind: "tool_use_end" }>).tool).toBe("Edit"); // id→name 복원
    expect((events[2] as Extract<SubAgentEvent, { kind: "tool_use_end" }>).ok).toBe(true);
    expect((events[3] as Extract<SubAgentEvent, { kind: "text_delta" }>).text).toBe("작업 완료");
    expect((events[4] as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(true);
  });

  it("args 정합: claude -p <prompt> --output-format stream-json --verbose (+model/skipPermissions)", () => {
    const f = fakeNdjson();
    const port = makeClaudeCodeSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn, model: "sonnet", skipPermissions: true });
    port.spawn({ prompt: "hi", workdir: "/tmp/w" });
    expect(f.spawnArgs.command).toBe("claude");
    expect(f.spawnArgs.args).toEqual(["-p", "hi", "--output-format", "stream-json", "--verbose", "--model", "sonnet", "--dangerously-skip-permissions"]);
    expect(f.spawnArgs.cwd).toBe("/tmp/w");
  });

  it("tool_result is_error=true → tool_use_end{ok:false}", async () => {
    const f = fakeNdjson();
    const port = makeClaudeCodeSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    f.line('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_9","name":"Bash"}]}}');
    f.line('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_9","is_error":true}]}}');
    f.close(0);
    const events = await drain(session.events);
    const end = events.find((e) => e.kind === "tool_use_end") as Extract<SubAgentEvent, { kind: "tool_use_end" }>;
    expect(end.ok).toBe(false);
    expect(end.tool).toBe("Bash");
  });

  it("malformed/partial NDJSON 관용 (crash 없이 드롭, 정상 줄만 이벤트)", async () => {
    const f = fakeNdjson();
    const port = makeClaudeCodeSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    f.line("{ not json");                                  // malformed → 드롭
    f.line('{"type":"result","is_error":false}');          // result → 무시(terminal=close)
    f.raw('{"type":"assistant","message":{"content":[{"type":"text","text":"부분"');  // partial
    f.line('}]}}');                                        // partial 완성 → text_delta "부분"
    f.close(0);
    const events = await drain(session.events);
    expect(events.map((e) => e.kind)).toEqual(["text_delta", "session_end"]);
    expect((events[0] as Extract<SubAgentEvent, { kind: "text_delta" }>).text).toBe("부분");
  });

  it("비정상 종료: exit code≠0 → session_end{ok:false, reason 'exit code 2'}", async () => {
    const f = fakeNdjson();
    const port = makeClaudeCodeSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    f.close(2);
    const [end] = await drain(session.events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(end.ok).toBe(false);
    expect(end.reason).toContain("exit code 2");
  });

  it("honest-unsupported: spawn 'error'(ENOENT 등) → session_end{ok:false, 'claude-code unavailable'} (throw 아님)", async () => {
    const f = fakeNdjson();
    const port = makeClaudeCodeSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    f.emitError("spawn claude ENOENT");
    const [end] = await drain(session.events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(end.ok).toBe(false);
    expect(end.reason).toContain("claude-code unavailable");
  });

  it("honest-unsupported: resolveBin throw(CLAUDE_BIN 부적합) → 즉시 session_end{ok:false} (spawn 미호출)", async () => {
    const f = fakeNdjson();
    const port = makeClaudeCodeSubAgent({ resolveBin: () => { throw new Error("CLAUDE_BIN must be an absolute path"); }, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    const [end] = await drain(session.events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(end.ok).toBe(false);
    expect(end.reason).toContain("claude-code unavailable");
  });

  it("AC1 — cancel(): SIGTERM 무시 → 유예 후 SIGKILL → session_end 1회 (결정론)", async () => {
    const f = fakeNdjson();
    const port = makeClaudeCodeSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn, hardKillDeadlineMs: 60 });
    const session = port.spawn({ prompt: "long", workdir: "/tmp/w" });
    const events: SubAgentEvent[] = [];
    const drained = (async () => { for await (const e of session.events) events.push(e); })();
    await session.cancel("stop"); // SIGTERM(무시) → 유예 → SIGKILL(close)
    await drained;
    expect(f.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    const ends = events.filter((e) => e.kind === "session_end");
    expect(ends).toHaveLength(1);
    expect((ends[0] as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(false);
  });

  // stub-detector: createClaudeLineParser 가 실 매핑(항상참/no-op 아님) + 상태ful 페어링
  it("stub-detector — createClaudeLineParser type별 매핑 + tool_use_id→name 복원", () => {
    const p = createClaudeLineParser();
    expect(p('{"type":"system","subtype":"init"}')).toEqual({ kind: "planning" });
    expect(p('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}')).toEqual({ kind: "text_delta", text: "hi" });
    // tool_use 등록 → tool_use_start
    expect(p('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read"}]}}')).toEqual({ kind: "tool_use_start", tool: "Read" });
    // tool_result 가 id 로 name 복원(상태)
    expect(p('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":false}]}}')).toEqual({ kind: "tool_use_end", tool: "Read", ok: true });
    expect(p("")).toBeNull();
    expect(p('{"type":"result","is_error":false}')).toBeNull(); // result = 무시
    // 미등록 id tool_result → 폴백 name
    expect(p('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"unknown","is_error":true}]}}')).toEqual({ kind: "tool_use_end", tool: "claude-tool", ok: false });
  });
});
