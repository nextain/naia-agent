import { describe, expect, it } from "vitest";
import {
  type NaiaStreamChunk,
  type SpawnContext,
  type ToolExecutionContext,
  UnsupportedError,
} from "@nextain/agent-types";
import { OpencodeRunAdapter } from "../opencode-run-adapter.js";

/**
 * For unit testing without invoking real opencode, we point resolveBin at
 * `printf` (POSIX) which lets us emit a controlled NDJSON sequence to stdout.
 * The adapter parses lines and converts them to NaiaStreamChunk.
 *
 * NOTE: `printf` consumes the prompt as the format string — so we craft args
 * that ignore the prompt and emit our fixed NDJSON.
 */

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

const FAKE_NDJSON_TEXT_ONLY = [
  '{"type":"step_start","sessionID":"ses_a","timestamp":1,"part":{"type":"step-start"}}',
  '{"type":"text","sessionID":"ses_a","timestamp":2,"part":{"type":"text","text":"hi"}}',
  '{"type":"step_finish","sessionID":"ses_a","timestamp":3,"part":{"type":"step-finish","reason":"stop","tokens":{"total":1,"input":0,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}}',
].join("\n") + "\n";

const FAKE_NDJSON_WITH_TOOL = [
  '{"type":"step_start","sessionID":"ses_b","timestamp":1,"part":{"type":"step-start"}}',
  '{"type":"tool_use","sessionID":"ses_b","timestamp":2,"part":{"type":"tool","tool":"write","callID":"call_x","state":{"status":"completed","input":{"filePath":"/tmp/test.txt","content":"hi"},"output":"Wrote file successfully."}}}',
  '{"type":"step_finish","sessionID":"ses_b","timestamp":3,"part":{"type":"step-finish","reason":"tool-calls","tokens":{"total":1,"input":0,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}}',
].join("\n") + "\n";

function makeAdapter(ndjson: string) {
  return new OpencodeRunAdapter({
    hardKillDeadlineMs: 200,
    resolveBin: () => ({
      command: "/usr/bin/printf",
      // %s prints the next argument verbatim; subsequent args are ignored
      // by printf when format has only one %s. We pass our NDJSON as the
      // first positional — adapter appends opencode's own args after.
      // To control output regardless of adapter args, prepend our format
      // and let `printf` ignore the rest.
      prefixArgs: ["%s", ndjson],
    }),
  });
}

describe("OpencodeRunAdapter — NDJSON event → NaiaStreamChunk conversion", () => {
  it("text-only turn emits session_start + session_progress + text_delta + session_end(completed)", async () => {
    const adapter = makeAdapter(FAKE_NDJSON_TEXT_ONLY);
    const session = await adapter.spawn(
      { prompt: "hi", workdir: "/tmp" },
      makeCtx(),
    );
    const events = await collect(session.events());
    expect(events[0]?.type).toBe("session_start");
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    const lastEnd = events.find((e) => e.type === "session_end");
    expect(lastEnd?.type === "session_end" && lastEnd.reason).toBe("completed");
  });

  it("text_delta carries the right text", async () => {
    const adapter = makeAdapter(FAKE_NDJSON_TEXT_ONLY);
    const session = await adapter.spawn(
      { prompt: "x", workdir: "/tmp" },
      makeCtx(),
    );
    const events = await collect(session.events());
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toBe("hi");
  });

  it("tool_use(completed) synthesizes tool_use_start + tool_use_end pair (C5)", async () => {
    const adapter = makeAdapter(FAKE_NDJSON_WITH_TOOL);
    const session = await adapter.spawn(
      { prompt: "x", workdir: "/tmp" },
      makeCtx(),
    );
    const events = await collect(session.events());
    const starts = events.filter((e) => e.type === "tool_use_start");
    const ends = events.filter((e) => e.type === "tool_use_end");
    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);
    // pair correspondence
    if (starts[0]?.type === "tool_use_start" && ends[0]?.type === "tool_use_end") {
      expect(starts[0].toolUseId).toBe(ends[0].toolUseId);
      expect(starts[0].tool).toBe("write");
      expect(ends[0].tool).toBe("write");
      expect(ends[0].ok).toBe(true);
    }
  });

  it("P0-6 — secret in text_delta is redacted", async () => {
    const ndjson =
      JSON.stringify({
        type: "text",
        sessionID: "ses_c",
        part: { type: "text", text: "Use Bearer sk-ant-api03-secret-here" },
      }) + "\n";
    const adapter = makeAdapter(ndjson);
    const session = await adapter.spawn(
      { prompt: "x", workdir: "/tmp" },
      makeCtx(),
    );
    const events = await collect(session.events());
    const all = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");
    expect(all).not.toContain("sk-ant-api03-secret-here");
  });

  it("C9 — id/name/version/capabilities all non-empty", () => {
    const adapter = new OpencodeRunAdapter();
    expect(adapter.id).toBe("opencode-cli");
    expect(adapter.name).toBeTruthy();
    expect(adapter.version).toBeTruthy();
    expect(adapter.capabilities.length).toBeGreaterThan(0);
  });

  it("C7/C14 — pause/resume/inject throw UnsupportedError", async () => {
    const adapter = makeAdapter(FAKE_NDJSON_TEXT_ONLY);
    const session = await adapter.spawn(
      { prompt: "x", workdir: "/tmp" },
      makeCtx(),
    );
    await expect(session.pause()).rejects.toBeInstanceOf(UnsupportedError);
    await expect(session.resume()).rejects.toBeInstanceOf(UnsupportedError);
    await expect(session.inject("x")).rejects.toBeInstanceOf(UnsupportedError);
    await collect(session.events());
  });

  it("C2 — session_end emitted exactly once as last chunk", async () => {
    const adapter = makeAdapter(FAKE_NDJSON_WITH_TOOL);
    const session = await adapter.spawn(
      { prompt: "x", workdir: "/tmp" },
      makeCtx(),
    );
    const events = await collect(session.events());
    expect(events[events.length - 1]?.type).toBe("session_end");
    expect(events.filter((e) => e.type === "session_end").length).toBe(1);
  });
});
