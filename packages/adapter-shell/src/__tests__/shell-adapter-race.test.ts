/**
 * Paranoid P0-2 regression — ShellAdapter #emit must guard against late
 * stdout chunks arriving after session_end. Without the guard, queued
 * chunks could resolve waiters that should have been done:true.
 */
import { describe, expect, it } from "vitest";
import type {
  NaiaStreamChunk,
  SpawnContext,
  ToolExecutionContext,
} from "@nextain/agent-types";
import { ShellAdapter } from "../shell-adapter.js";

const ECHO_CMD = "/usr/bin/env";
const ECHO_ARGS = ["echo"];

function makeCtx(): SpawnContext {
  const tc: ToolExecutionContext = { sessionId: "test", workingDir: "/tmp" };
  return { signal: new AbortController().signal, toolContext: tc };
}

async function collect(
  events: AsyncIterable<NaiaStreamChunk>,
): Promise<NaiaStreamChunk[]> {
  const out: NaiaStreamChunk[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe("ShellAdapter — P0-2 regression (late chunk after session_end)", () => {
  it("session_end is exactly 1, no double-fire under rapid exit", async () => {
    // Repeated rapid execution — increases chance of race
    for (let i = 0; i < 5; i++) {
      const adapter = new ShellAdapter({
        command: ECHO_CMD,
        args: () => [...ECHO_ARGS, "rapid"],
      });
      const session = await adapter.spawn(
        { prompt: "x", workdir: "/tmp" },
        makeCtx(),
      );
      const events = await collect(session.events());
      const ends = events.filter((e) => e.type === "session_end");
      expect(ends.length).toBe(1);
    }
  });

  it("cancel during emit does not cause double session_end", async () => {
    const adapter = new ShellAdapter({
      command: "/bin/sh",
      args: () => ["-c", "for i in 1 2 3 4 5; do echo line$i; done"],
      hardKillDeadlineMs: 100,
    });
    const session = await adapter.spawn(
      { prompt: "x", workdir: "/tmp" },
      makeCtx(),
    );
    setTimeout(() => void session.cancel("test"), 5);
    const events = await collect(session.events());
    expect(events.filter((e) => e.type === "session_end").length).toBe(1);
  });
});
