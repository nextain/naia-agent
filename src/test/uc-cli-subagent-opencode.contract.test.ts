// UC-CLI subagent-opencode-cli 어댑터 계약(2b) — opencode NDJSON → SubAgentEvent + honest-unsupported + 인터럽트.
// fake child(spawnFn 주입)로 실 opencode 없이 결정론 검증. resolveBin 주입으로 PATH 조회 회피.
import { describe, it, expect } from "vitest";
import type { ChildProcess } from "node:child_process";
import { makeOpencodeSubAgent, opencodeLineToEvent } from "../main/adapters/subagent-opencode-cli.js";
import type { SpawnFn, ResolvedBin } from "../main/adapters/subprocess-session.js";
import type { SubAgentEvent } from "../main/domain/orchestration.js";

const fixedBin = (): ResolvedBin => ({ command: "opencode", prefixArgs: [] });

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

describe("subagent-opencode-cli 어댑터 계약 (2b, fake child)", () => {
  it("opencode NDJSON → SubAgentEvent 시퀀스 (planning→text→tool_use_start→tool_use_end→session_end)", async () => {
    const f = fakeNdjson();
    const port = makeOpencodeSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "리팩터", workdir: "/tmp/w" });
    f.line('{"type":"step_start"}');
    f.line('{"type":"text","part":{"text":"분석 중"}}');
    f.line('{"type":"tool_use","part":{"tool":"edit","state":{"status":"running"}}}');
    f.line('{"type":"tool_use","part":{"tool":"edit","state":{"status":"completed"}}}');
    f.line('{"type":"step_finish","part":{"tokens":{}}}'); // 드롭
    f.close(0);
    const events = await drain(session.events);

    expect(events.map((e) => e.kind)).toEqual(["planning", "text_delta", "tool_use_start", "tool_use_end", "session_end"]);
    expect((events[1] as Extract<SubAgentEvent, { kind: "text_delta" }>).text).toBe("분석 중");
    expect((events[2] as Extract<SubAgentEvent, { kind: "tool_use_start" }>).tool).toBe("edit");
    expect((events[3] as Extract<SubAgentEvent, { kind: "tool_use_end" }>).ok).toBe(true);
    expect((events[4] as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(true);
  });

  it("args 정합: opencode run --format json --dir <workdir> [-m] [--skip] <prompt>(마지막)", () => {
    const f = fakeNdjson();
    const port = makeOpencodeSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn, model: "glm-4.7", skipPermissions: true });
    port.spawn({ prompt: "do it", workdir: "/tmp/w" });
    expect(f.spawnArgs.command).toBe("opencode");
    expect(f.spawnArgs.args).toEqual(["run", "--format", "json", "--dir", "/tmp/w", "-m", "glm-4.7", "--dangerously-skip-permissions", "do it"]);
  });

  it("tool_use status 'error' → tool_use_end{ok:false}; malformed 관용", async () => {
    const f = fakeNdjson();
    const port = makeOpencodeSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    f.line("{bad");                                                                  // 드롭
    f.line('{"type":"tool_use","part":{"tool":"bash","state":{"status":"error"}}}'); // end ok:false
    f.close(0);
    const events = await drain(session.events);
    expect(events.map((e) => e.kind)).toEqual(["tool_use_end", "session_end"]);
    expect((events[0] as Extract<SubAgentEvent, { kind: "tool_use_end" }>).ok).toBe(false);
  });

  it("honest-unsupported: spawn 'error' → session_end{ok:false, 'opencode unavailable'} (throw 아님)", async () => {
    const f = fakeNdjson();
    const port = makeOpencodeSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    f.emitError("spawn opencode ENOENT");
    const [end] = await drain(session.events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(end.ok).toBe(false);
    expect(end.reason).toContain("opencode unavailable");
  });

  it("AC1 — cancel(): SIGTERM → 유예 → SIGKILL → session_end 1회 (결정론)", async () => {
    const f = fakeNdjson();
    const port = makeOpencodeSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn, hardKillDeadlineMs: 60 });
    const session = port.spawn({ prompt: "long", workdir: "/tmp/w" });
    const events: SubAgentEvent[] = [];
    const drained = (async () => { for await (const e of session.events) events.push(e); })();
    await session.cancel("stop");
    await drained;
    expect(f.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(events.filter((e) => e.kind === "session_end")).toHaveLength(1);
  });

  it("stub-detector — opencodeLineToEvent type 별 정확 매핑", () => {
    expect(opencodeLineToEvent('{"type":"step_start"}')).toEqual({ kind: "planning" });
    expect(opencodeLineToEvent('{"type":"text","part":{"text":"hi"}}')).toEqual({ kind: "text_delta", text: "hi" });
    expect(opencodeLineToEvent('{"type":"text","part":{"text":""}}')).toBeNull(); // 빈 텍스트 드롭
    expect(opencodeLineToEvent('{"type":"step_finish"}')).toBeNull();             // 무관 드롭
  });
});
