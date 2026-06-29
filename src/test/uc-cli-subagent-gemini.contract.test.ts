// UC-CLI subagent-gemini 어댑터 계약(SPEC-010 확장, 2026-06-29) — gemini stream-json NDJSON → SubAgentEvent.
// ⚠️ gemini 파서는 **runtime-unverified**(auth IneligibleTierError 로 live 캡처 불가). 본 테스트는
// docs@0.47.0 기반 schema(init/message/tool_use/tool_result) 로 파서 로직 + 표준 어댑터 계약(args·
// honest-unsupported·cancel) 을 검증. auth 복원 시 runtime smoke 보강 필요.
import { describe, it, expect } from "vitest";
import type { ChildProcess } from "node:child_process";
import { makeGeminiSubAgent, geminiLineToEvent, type SpawnFn, type ResolvedBin } from "../main/adapters/subagent-gemini.js";
import type { SubAgentEvent } from "../main/domain/orchestration.js";

const fixedBin = (): ResolvedBin => ({ command: "gemini", prefixArgs: [] });

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

describe("subagent-gemini 어댑터 계약 (SPEC-010 확장, fake child, ⚠️파서 runtime-unverified)", () => {
  it("gemini JSONL → SubAgentEvent 시퀀스 (planning→tool_use_start→tool_use_end→text_delta→session_end)", async () => {
    const f = fakeNdjson();
    const port = makeGeminiSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "X 함수 추가해", workdir: "/tmp/w" });
    f.line('{"type":"init","session":"s1","model":"gemini-2.5"}');
    f.line('{"type":"tool_use","tool_name":"edit_file"}');
    f.line('{"type":"tool_result","tool_name":"edit_file","is_error":false}');
    f.line('{"type":"message","text":"작업 완료"}');
    f.close(0);
    const events = await drain(session.events);

    expect(events.map((e) => e.kind)).toEqual(["planning", "tool_use_start", "tool_use_end", "text_delta", "session_end"]);
    expect((events[1] as Extract<SubAgentEvent, { kind: "tool_use_start" }>).tool).toBe("edit_file");
    expect((events[2] as Extract<SubAgentEvent, { kind: "tool_use_end" }>).ok).toBe(true);
    expect((events[3] as Extract<SubAgentEvent, { kind: "text_delta" }>).text).toBe("작업 완료");
    expect((events[4] as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(true);
  });

  it("args 정합: -p <prompt> --output-format stream-json --skip-trust [+yolo/model]", () => {
    const f = fakeNdjson();
    const port = makeGeminiSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn, yolo: true, model: "gemini-2.5-pro" });
    port.spawn({ prompt: "hi", workdir: "/tmp/w" });
    expect(f.spawnArgs.command).toBe("gemini");
    expect(f.spawnArgs.args).toEqual(["-p", "hi", "--output-format", "stream-json", "--skip-trust", "--yolo", "--model", "gemini-2.5-pro"]);
    expect(f.spawnArgs.cwd).toBe("/tmp/w");
  });

  it("tool_call_response(tool_result 변종) 수용 + is_error=true → tool_use_end{ok:false}", async () => {
    const f = fakeNdjson();
    const port = makeGeminiSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    f.line('{"type":"tool_call_response","tool_name":"shell","error":"boom"}');
    f.close(0);
    const events = await drain(session.events);
    const end = events.find((e) => e.kind === "tool_use_end") as Extract<SubAgentEvent, { kind: "tool_use_end" }>;
    expect(end).toBeDefined();
    expect(end.ok).toBe(false);
    expect(end.tool).toBe("shell");
  });

  it("malformed NDJSON 관용 (crash 없이 드롭) + result/error = 무시(terminal=close)", async () => {
    const f = fakeNdjson();
    const port = makeGeminiSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    f.line("{ not json");                       // malformed → 드롭
    f.line('{"type":"error","message":"warn"}'); // 비치명 → 무시
    f.line('{"type":"result","stats":{}}');      // terminal=close → 무시
    f.line('{"type":"message","content":"hi"}'); // → text_delta
    f.close(0);
    const events = await drain(session.events);
    expect(events.map((e) => e.kind)).toEqual(["text_delta", "session_end"]);
    expect((events[0] as Extract<SubAgentEvent, { kind: "text_delta" }>).text).toBe("hi");
  });

  it("비정상 종료: exit code≠0 → session_end{ok:false}", async () => {
    const f = fakeNdjson();
    const port = makeGeminiSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    f.close(1);
    const [end] = await drain(session.events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(end.ok).toBe(false);
    expect(end.reason).toContain("exit code 1");
  });

  it("honest-unsupported: spawn 'error' → session_end{ok:false, 'gemini unavailable'} (throw 아님)", async () => {
    const f = fakeNdjson();
    const port = makeGeminiSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    f.emitError("spawn gemini ENOENT");
    const [end] = await drain(session.events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(end.ok).toBe(false);
    expect(end.reason).toContain("gemini unavailable");
  });

  it("honest-unsupported: resolveBin throw → 즉시 session_end{ok:false} (spawn 미호출)", async () => {
    const f = fakeNdjson();
    const port = makeGeminiSubAgent({ resolveBin: () => { throw new Error("GEMINI_BIN must be an absolute path"); }, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    const [end] = await drain(session.events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(end.ok).toBe(false);
    expect(end.reason).toContain("gemini unavailable");
  });

  it("AC1 — cancel(): SIGTERM 무시 → 유예 후 SIGKILL → session_end 1회", async () => {
    const f = fakeNdjson();
    const port = makeGeminiSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn, hardKillDeadlineMs: 60 });
    const session = port.spawn({ prompt: "long", workdir: "/tmp/w" });
    const events: SubAgentEvent[] = [];
    const drained = (async () => { for await (const e of session.events) events.push(e); })();
    await session.cancel("stop");
    await drained;
    expect(f.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    const ends = events.filter((e) => e.kind === "session_end");
    expect(ends).toHaveLength(1);
    expect((ends[0] as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(false);
  });

  // stub-detector: geminiLineToEvent 가 실 매핑 + 방어 파싱(runtime-unverified 변형 수용).
  it("stub-detector — geminiLineToEvent type별 매핑 + 변형 키 수용(빈/무관=null)", () => {
    expect(geminiLineToEvent('{"type":"init"}')).toEqual({ kind: "planning" });
    expect(geminiLineToEvent('{"type":"message","text":"hi"}')).toEqual({ kind: "text_delta", text: "hi" });
    expect(geminiLineToEvent('{"type":"message","content":"alt"}')).toEqual({ kind: "text_delta", text: "alt" }); // content 키 변형
    expect(geminiLineToEvent('{"type":"tool_use","name":"web"}')).toEqual({ kind: "tool_use_start", tool: "web" }); // name 키 변형
    expect(geminiLineToEvent('{"type":"tool_result"}')).toEqual({ kind: "tool_use_end", tool: "gemini-tool", ok: true }); // 이름 누락 폴백
    expect(geminiLineToEvent("")).toBeNull();
    expect(geminiLineToEvent('{"type":"result","stats":{}}')).toBeNull(); // terminal=close → 무시
    expect(geminiLineToEvent('{"type":"unknown_future_type"}')).toBeNull(); // 무관 type 드롭
  });
});
