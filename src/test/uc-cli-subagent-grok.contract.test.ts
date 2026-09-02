import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { makeGrokSubAgent } from "../main/adapters/subagent-grok.js";
import type { SpawnFn, ResolvedBin } from "../main/adapters/subprocess-session.js";
import type { SubAgentEvent } from "../main/domain/orchestration.js";

const fixedBin = (): ResolvedBin => ({ command: "grok", prefixArgs: [] });

function fakeNdjson() {
  let stdoutCb: ((b: Buffer) => void) | undefined;
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  let spawnArgs: { command: string; args: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv } | undefined;
  const spawnFn: SpawnFn = (command, args, o) => {
    spawnArgs = { command, args, cwd: o.cwd, env: o.env };
    const child = {
      stdout: { on: (_e: string, cb: (b: Buffer) => void) => { stdoutCb = cb; } },
      stderr: { on: () => {} },
      on(ev: string, cb: (...a: unknown[]) => void) { handlers[ev] = cb; return this as unknown; },
      kill() { return true; },
    };
    return child as unknown as ChildProcess;
  };
  return {
    spawnFn,
    line: (s: string) => stdoutCb?.(Buffer.from(`${s}\n`, "utf8")),
    close: (code: number | null, signal: NodeJS.Signals | null = null) => handlers.close?.(code, signal),
    get spawnArgs() { return spawnArgs!; },
  };
}

async function drain(events: AsyncIterable<SubAgentEvent>): Promise<SubAgentEvent[]> {
  const out: SubAgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("subagent-grok 어댑터 계약", () => {
  it("streaming-messages-json → text_delta + session_end", async () => {
    const f = fakeNdjson();
    const port = makeGrokSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "ping", workdir: "/tmp/w" });
    f.line(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "pong" } } }));
    f.close(0);
    const events = await drain(session.events);
    expect(events.map((e) => e.kind)).toEqual(["text_delta", "session_end"]);
    expect((events[0] as Extract<SubAgentEvent, { kind: "text_delta" }>).text).toBe("pong");
    expect((events[1] as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(true);
  });

  it("args 정합: grok -p --output-format streaming-messages-json --cwd workdir [-m] [--always-approve]", () => {
    const f = fakeNdjson();
    const port = makeGrokSubAgent({
      resolveBin: fixedBin,
      spawnFn: f.spawnFn,
      model: "grok-4.6",
      skipPermissions: true,
    });
    port.spawn({ prompt: "do it", workdir: "/tmp/w" });
    expect(f.spawnArgs.command).toBe("grok");
    expect(f.spawnArgs.args).toEqual([
      "-p", "do it",
      "--output-format", "streaming-messages-json",
      "--include-partial-messages",
      "--cwd", "/tmp/w",
      "-m", "grok-4.6",
      "--always-approve",
    ]);
    expect(f.spawnArgs.env?.XAI_API_KEY).toBeUndefined();
  });
});
