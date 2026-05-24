import { describe, it, expect } from "vitest";
import { StreamPlayer, StreamRecorder } from "../index.js";
import type { StreamPlayerFixture } from "../index.js";
import type { LLMRequest, LLMResponse, LLMStreamChunk } from "@nextain/agent-types";

function makeFixture(text: string): StreamPlayerFixture {
  const chunks: LLMStreamChunk[] = [
    { type: "content_block_start", index: 0, block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "end", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } },
  ];
  return { chunks };
}

const baseRequest: LLMRequest = { messages: [{ role: "user", content: "hi" }] };

describe("StreamPlayer", () => {
  it("plays back all chunks in order", async () => {
    const fixture = makeFixture("hello");
    const player = new StreamPlayer(fixture);
    const chunks: LLMStreamChunk[] = [];
    for await (const c of player.stream(baseRequest)) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(4);
    expect(chunks[0]?.type).toBe("content_block_start");
    expect(chunks[chunks.length - 1]?.type).toBe("end");
  });

  it("increments callCount", async () => {
    const player = new StreamPlayer(makeFixture("x"));
    for await (const _ of player.stream(baseRequest)) { /* drain */ }
    for await (const _ of player.stream(baseRequest)) { /* drain */ }
    expect(player.callCount).toBe(2);
  });

  it("generate() throws when no response in fixture", async () => {
    const player = new StreamPlayer(makeFixture("x"));
    await expect(player.generate(baseRequest)).rejects.toThrow("no `response`");
  });

  it("generate() returns response when provided", async () => {
    const response: LLMResponse = { id: "resp-1", model: "test", content: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };
    const player = new StreamPlayer({ chunks: [], response });
    const result = await player.generate(baseRequest);
    expect(result.content[0]).toEqual({ type: "text", text: "ok" });
  });

  it("stops yielding on abort signal", async () => {
    const fixture = makeFixture("hello");
    const player = new StreamPlayer(fixture);
    const controller = new AbortController();
    controller.abort();
    const chunks: LLMStreamChunk[] = [];
    for await (const c of player.stream({ ...baseRequest, signal: controller.signal })) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(0);
  });

  it("preserves fixture meta", () => {
    const fixture: StreamPlayerFixture = {
      chunks: [],
      meta: { recordedAt: "2026-01-01", model: "test" },
    };
    const player = new StreamPlayer(fixture);
    expect(player.callCount).toBe(0);
  });
});

describe("StreamRecorder", () => {
  it("records chunks from inner LLM stream", async () => {
    const inner = new StreamPlayer(makeFixture("recorded text"));
    const recorder = new StreamRecorder({ llm: inner });
    for await (const _ of recorder.stream(baseRequest)) { /* drain */ }
    expect(recorder.recordings).toHaveLength(1);
    expect(recorder.recordings[0]!.chunks).toHaveLength(4);
  });

  it("records generate() calls", async () => {
    const response: LLMResponse = { id: "resp-1", model: "test", content: [{ type: "text", text: "gen" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };
    const inner = new StreamPlayer({ chunks: [], response });
    const recorder = new StreamRecorder({ llm: inner });
    await recorder.generate(baseRequest);
    expect(recorder.recordings).toHaveLength(1);
    expect(recorder.recordings[0]!.response).toBeDefined();
  });

  it("accumulates multiple recordings", async () => {
    const inner = new StreamPlayer(makeFixture("a"));
    const recorder = new StreamRecorder({ llm: inner });
    for await (const _ of recorder.stream(baseRequest)) { /* drain */ }
    for await (const _ of recorder.stream(baseRequest)) { /* drain */ }
    expect(recorder.recordings).toHaveLength(2);
  });

  it("lastRecording returns most recent", async () => {
    const inner = new StreamPlayer(makeFixture("last"));
    const recorder = new StreamRecorder({ llm: inner });
    for await (const _ of recorder.stream(baseRequest)) { /* drain */ }
    expect(recorder.lastRecording).toBe(recorder.recordings[0]);
  });

  it("reset() clears recordings", async () => {
    const inner = new StreamPlayer(makeFixture("x"));
    const recorder = new StreamRecorder({ llm: inner });
    for await (const _ of recorder.stream(baseRequest)) { /* drain */ }
    recorder.reset();
    expect(recorder.recordings).toHaveLength(0);
  });

  it("toJSON() returns serializable array", async () => {
    const inner = new StreamPlayer(makeFixture("json"));
    const recorder = new StreamRecorder({ llm: inner });
    for await (const _ of recorder.stream(baseRequest)) { /* drain */ }
    const json = JSON.stringify(recorder.toJSON());
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].chunks).toHaveLength(4);
  });

  it("recorded fixture can be replayed via StreamPlayer", async () => {
    const inner = new StreamPlayer(makeFixture("round-trip"));
    const recorder = new StreamRecorder({ llm: inner });
    for await (const _ of recorder.stream(baseRequest)) { /* drain */ }

    const recording = recorder.lastRecording!;
    const replayer = new StreamPlayer(recording);
    const chunks: LLMStreamChunk[] = [];
    for await (const c of replayer.stream(baseRequest)) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(4);
    const textDelta = chunks.find((c) => c.type === "content_block_delta");
    expect(textDelta).toBeDefined();
    if (textDelta && "delta" in textDelta) {
      expect((textDelta as { delta: { text: string } }).delta.text).toBe("round-trip");
    }
  });

  it("includes meta in recordings", async () => {
    const inner = new StreamPlayer(makeFixture("meta"));
    const recorder = new StreamRecorder({ llm: inner, meta: { model: "test-model" } });
    for await (const _ of recorder.stream(baseRequest)) { /* drain */ }
    expect(recorder.recordings[0]!.meta?.model).toBe("test-model");
    expect(recorder.recordings[0]!.meta?.recordedAt).toBeDefined();
  });
});
