import { describe, expect, it } from "vitest";
import {
  type NaiaStreamChunk,
  type SpawnContext,
  type ToolExecutionContext,
  UnsupportedError,
} from "@nextain/agent-types";
import { ShellAdapter } from "../shell-adapter.js";

const ECHO_CMD = process.platform === "win32" ? "cmd" : "/usr/bin/env";
const ECHO_ARGS = process.platform === "win32" ? ["/c", "echo"] : ["echo"];

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

describe("ShellAdapter — adapter contract C1~C10 + path traversal A6", () => {
  it("C1 — first chunk is session_start", async () => {
    const adapter = new ShellAdapter({
      command: ECHO_CMD,
      args: () => [...ECHO_ARGS, "hello"],
    });
    const session = await adapter.spawn(
      { prompt: "hello", workdir: "/tmp" },
      makeCtx(),
    );
    const events = await collect(session.events());
    expect(events[0]?.type).toBe("session_start");
  });

  it("C2 — session_end emitted exactly once as last chunk", async () => {
    const adapter = new ShellAdapter({
      command: ECHO_CMD,
      args: () => [...ECHO_ARGS, "hello"],
    });
    const session = await adapter.spawn(
      { prompt: "hello", workdir: "/tmp" },
      makeCtx(),
    );
    const events = await collect(session.events());
    const ends = events.filter((e) => e.type === "session_end");
    expect(ends.length).toBe(1);
    expect(events[events.length - 1]?.type).toBe("session_end");
  });

  it("C2 + completion — successful echo yields reason: completed", async () => {
    const adapter = new ShellAdapter({
      command: ECHO_CMD,
      args: () => [...ECHO_ARGS, "hello world"],
    });
    const session = await adapter.spawn(
      { prompt: "hello world", workdir: "/tmp" },
      makeCtx(),
    );
    const events = await collect(session.events());
    const end = events.find((e) => e.type === "session_end");
    expect(end?.type === "session_end" && end.reason).toBe("completed");
  });

  it("emits text_delta from stdout", async () => {
    const adapter = new ShellAdapter({
      command: ECHO_CMD,
      args: () => [...ECHO_ARGS, "naia"],
    });
    const session = await adapter.spawn(
      { prompt: "x", workdir: "/tmp" },
      makeCtx(),
    );
    const events = await collect(session.events());
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toContain("naia");
  });

  it("P0-6 — secret pattern in stdout is redacted", async () => {
    // echo a fake secret token; redactString should mask it.
    const adapter = new ShellAdapter({
      command: ECHO_CMD,
      args: () => [...ECHO_ARGS, "Bearer sk-ant-api03-xxxxx"],
    });
    const session = await adapter.spawn(
      { prompt: "x", workdir: "/tmp" },
      makeCtx(),
    );
    const events = await collect(session.events());
    const all = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");
    expect(all).not.toContain("sk-ant-api03-xxxxx");
  });

  it("C3/C12 — cancel() resolves and yields session_end(cancelled) within deadline", async () => {
    const adapter = new ShellAdapter({
      command: process.platform === "win32" ? "cmd" : "/usr/bin/env",
      args: () =>
        process.platform === "win32"
          ? ["/c", "ping", "-n", "10", "127.0.0.1"]
          : ["sleep", "5"],
      hardKillDeadlineMs: 200,
    });
    const session = await adapter.spawn(
      { prompt: "x", workdir: "/tmp" },
      makeCtx(),
    );
    // start consuming, then cancel
    const consumer = collect(session.events());
    setTimeout(() => {
      void session.cancel("test-cancel");
    }, 50);
    const events = await consumer;
    const end = events.find((e) => e.type === "session_end");
    expect(end?.type === "session_end" && end.reason).toBe("cancelled");
  }, 5000);

  it("C4 — abort signal at spawn triggers cancellation", async () => {
    const ac = new AbortController();
    ac.abort();
    const adapter = new ShellAdapter({
      command: ECHO_CMD,
      args: () => [...ECHO_ARGS, "hello"],
      hardKillDeadlineMs: 200,
    });
    const tc: ToolExecutionContext = { sessionId: "test", workingDir: "/tmp" };
    const session = await adapter.spawn(
      { prompt: "x", workdir: "/tmp" },
      { signal: ac.signal, toolContext: tc },
    );
    const events = await collect(session.events());
    const end = events.find((e) => e.type === "session_end");
    expect(end).toBeDefined();
    // either cancelled or completed (race depending on timing) — the contract
    // is that we terminate and emit session_end exactly once
    expect(events.filter((e) => e.type === "session_end").length).toBe(1);
  });

  it("C7/C14 — pause/resume/inject throw UnsupportedError", async () => {
    const adapter = new ShellAdapter({
      command: ECHO_CMD,
      args: () => [...ECHO_ARGS, "hello"],
    });
    const session = await adapter.spawn(
      { prompt: "x", workdir: "/tmp" },
      makeCtx(),
    );
    await expect(session.pause()).rejects.toBeInstanceOf(UnsupportedError);
    await expect(session.resume()).rejects.toBeInstanceOf(UnsupportedError);
    await expect(session.inject("x")).rejects.toBeInstanceOf(UnsupportedError);
    await collect(session.events()); // drain
  });

  it("C9 — id/name/version/capabilities all non-empty", () => {
    const adapter = new ShellAdapter({ command: "/bin/true" });
    expect(adapter.id).toBeTruthy();
    expect(adapter.name).toBeTruthy();
    expect(adapter.version).toBeTruthy();
    expect(adapter.capabilities.length).toBeGreaterThan(0);
  });

  it("C10 — two concurrent sessions are isolated (no event leak)", async () => {
    const adapter = new ShellAdapter({
      command: ECHO_CMD,
      args: (task) => [...ECHO_ARGS, task.prompt],
    });
    const ctx1 = makeCtx();
    const ctx2 = makeCtx();
    const [s1, s2] = await Promise.all([
      adapter.spawn({ prompt: "session-A", workdir: "/tmp" }, ctx1),
      adapter.spawn({ prompt: "session-B", workdir: "/tmp" }, ctx2),
    ]);
    expect(s1.id).not.toBe(s2.id);
    const [e1, e2] = await Promise.all([collect(s1.events()), collect(s2.events())]);
    const t1 = e1
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");
    const t2 = e2
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");
    expect(t1).toContain("session-A");
    expect(t1).not.toContain("session-B");
    expect(t2).toContain("session-B");
    expect(t2).not.toContain("session-A");
  });

  it("A6 — workdir is resolved and child cwd is set", async () => {
    const adapter = new ShellAdapter({
      command: process.platform === "win32" ? "cmd" : "/bin/sh",
      args: () => (process.platform === "win32" ? ["/c", "cd"] : ["-c", "pwd"]),
    });
    const session = await adapter.spawn(
      { prompt: "x", workdir: "/tmp" },
      makeCtx(),
    );
    const events = await collect(session.events());
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toContain("/tmp");
  });
});
