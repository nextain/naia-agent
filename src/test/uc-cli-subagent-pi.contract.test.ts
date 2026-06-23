// UC-CLI subagent-pi 어댑터 계약(2b) — pi NDJSON → SubAgentEvent 매핑 + honest-unsupported + 인터럽트.
// fake child(spawnFn 주입)로 실 pi 바이너리 없이 결정론 검증. resolveBin 주입으로 PATH 조회(execSync) 회피.
import { describe, it, expect } from "vitest";
import type { ChildProcess } from "node:child_process";
import { makePiSubAgent, piLineToEvent, type SpawnFn, type ResolvedBin } from "../main/adapters/subagent-pi.js";
import type { SubAgentEvent } from "../main/domain/orchestration.js";

const fixedBin = (): ResolvedBin => ({ command: "pi", prefixArgs: [] });

/** NDJSON 줄을 stdout 으로 흘리고 close/error/kill 을 제어하는 fake child. */
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

describe("subagent-pi 어댑터 계약 (2b, fake child)", () => {
  it("pi NDJSON → SubAgentEvent 시퀀스 (planning→tool_use_start→tool_use_end→text_delta→session_end)", async () => {
    const f = fakeNdjson();
    const port = makePiSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "X 함수 추가해", workdir: "/tmp/w" });
    f.line('{"type":"session_start"}');
    f.line('{"type":"tool_call","toolName":"edit_file"}');
    f.line('{"type":"tool_result","toolName":"edit_file","isError":false}');
    f.line('{"type":"message_end","message":{"content":[{"type":"text","text":"작업 완료"}]}}');
    f.close(0);
    const events = await drain(session.events);

    expect(events.map((e) => e.kind)).toEqual(["planning", "tool_use_start", "tool_use_end", "text_delta", "session_end"]);
    expect((events[1] as Extract<SubAgentEvent, { kind: "tool_use_start" }>).tool).toBe("edit_file");
    expect((events[2] as Extract<SubAgentEvent, { kind: "tool_use_end" }>).ok).toBe(true);
    expect((events[3] as Extract<SubAgentEvent, { kind: "text_delta" }>).text).toBe("작업 완료");
    expect((events[4] as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(true);
  });

  it("args 정합: pi -p <prompt> --mode json --no-session (+provider/model)", () => {
    const f = fakeNdjson();
    const port = makePiSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn, provider: "anthropic", model: "claude-sonnet-4-6" });
    port.spawn({ prompt: "hi", workdir: "/tmp/w" });
    expect(f.spawnArgs.command).toBe("pi");
    expect(f.spawnArgs.args).toEqual(["-p", "hi", "--mode", "json", "--no-session", "--provider", "anthropic", "--model", "claude-sonnet-4-6"]);
    expect(f.spawnArgs.cwd).toBe("/tmp/w");
  });

  it("malformed/partial NDJSON 관용 (crash 없이 드롭, 정상 줄만 이벤트)", async () => {
    const f = fakeNdjson();
    const port = makePiSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    f.line("{ not json");                                  // malformed → 드롭
    f.line('{"type":"unknown_kind"}');                     // 무관 type → 드롭
    f.raw('{"type":"message_end","message":{"content":[{"type":"text","text":"부분"');  // partial(개행 전)
    f.line('}]}}');                                        // partial 완성 → text_delta "부분"
    f.close(0);
    const events = await drain(session.events);
    expect(events.map((e) => e.kind)).toEqual(["text_delta", "session_end"]);
    expect((events[0] as Extract<SubAgentEvent, { kind: "text_delta" }>).text).toBe("부분");
  });

  it("비정상 종료: exit code≠0 → session_end{ok:false, reason 'exit code 3'}", async () => {
    const f = fakeNdjson();
    const port = makePiSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    f.close(3);
    const [end] = await drain(session.events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(end.ok).toBe(false);
    expect(end.reason).toContain("exit code 3");
  });

  it("honest-unsupported: spawn 'error'(ENOENT 등) → session_end{ok:false, 'pi unavailable'} (throw 아님)", async () => {
    const f = fakeNdjson();
    const port = makePiSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    f.emitError("spawn pi ENOENT");
    const [end] = await drain(session.events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(end.ok).toBe(false);
    expect(end.reason).toContain("pi unavailable");
  });

  it("honest-unsupported: resolveBin throw(PI_BIN 부적합) → 즉시 session_end{ok:false} (spawn 미호출)", async () => {
    const f = fakeNdjson();
    const port = makePiSubAgent({ resolveBin: () => { throw new Error("PI_BIN must be an absolute path"); }, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    const [end] = await drain(session.events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(end.ok).toBe(false);
    expect(end.reason).toContain("pi unavailable");
  });

  it("AC1 — cancel(): SIGTERM 무시 → 유예 후 SIGKILL → session_end 1회 (결정론)", async () => {
    const f = fakeNdjson();
    const port = makePiSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn, hardKillDeadlineMs: 60 });
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

  // stub-detector: piLineToEvent 가 실제 매핑(항상참/no-op 아님)
  it("stub-detector — piLineToEvent 가 type 별 정확 매핑(빈/무관=null)", () => {
    expect(piLineToEvent('{"type":"tool_call","toolName":"bash"}')).toEqual({ kind: "tool_use_start", tool: "bash" });
    expect(piLineToEvent('{"type":"tool_result","toolName":"bash","isError":true}')).toEqual({ kind: "tool_use_end", tool: "bash", ok: false });
    expect(piLineToEvent("")).toBeNull();
    expect(piLineToEvent('{"type":"message_end","message":{"content":[]}}')).toBeNull(); // 빈 텍스트=드롭
  });
});
