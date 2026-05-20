import { describe, expect, it } from "vitest";
import { extractMessageText, parsePiEvent } from "../event-parser.js";

describe("parsePiEvent — NDJSON line parser", () => {
  it("returns null for empty / whitespace line", () => {
    expect(parsePiEvent("")).toBeNull();
    expect(parsePiEvent("   ")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parsePiEvent("not json")).toBeNull();
    expect(parsePiEvent("{broken")).toBeNull();
  });

  it("returns null for JSON without type field", () => {
    expect(parsePiEvent('{"reason":"new"}')).toBeNull();
  });

  it("classifies known event types", () => {
    for (const t of [
      "session_start",
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "tool_call",
      "tool_result",
      "turn_end",
      "agent_end",
    ]) {
      expect(parsePiEvent(JSON.stringify({ type: t }))?.type).toBe(t);
    }
  });

  it("classifies unknown types as 'unknown'", () => {
    expect(parsePiEvent('{"type":"compaction_start"}')?.type).toBe("unknown");
    expect(parsePiEvent('{"type":"future_unknown_event"}')?.type).toBe("unknown");
  });

  it("session_start: extracts reason field", () => {
    const ev = parsePiEvent(JSON.stringify({ type: "session_start", reason: "resume" }));
    expect(ev?.reason).toBe("resume");
  });

  it("session_start: defaults reason to 'new' when missing", () => {
    const ev = parsePiEvent(JSON.stringify({ type: "session_start" }));
    expect(ev?.reason).toBe("new");
  });

  it("message_end: stores message object", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "text", text: "hello world" }],
      stopReason: "end_turn",
    };
    const ev = parsePiEvent(JSON.stringify({ type: "message_end", message: msg }));
    expect(ev?.message?.role).toBe("assistant");
    expect(ev?.message?.stopReason).toBe("end_turn");
  });

  it("tool_call: extracts toolName / toolCallId / input", () => {
    const ev = parsePiEvent(
      JSON.stringify({
        type: "tool_call",
        toolName: "write_file",
        toolCallId: "call_abc",
        input: { path: "/tmp/x.ts", content: "hello" },
      }),
    );
    expect(ev?.tool?.name).toBe("write_file");
    expect(ev?.tool?.callId).toBe("call_abc");
    expect(ev?.tool?.input).toEqual({ path: "/tmp/x.ts", content: "hello" });
  });

  it("tool_result: extracts toolName / toolCallId / content / isError", () => {
    const ev = parsePiEvent(
      JSON.stringify({
        type: "tool_result",
        toolName: "read_file",
        toolCallId: "call_xyz",
        content: "file contents",
        isError: false,
      }),
    );
    expect(ev?.tool?.name).toBe("read_file");
    expect(ev?.tool?.callId).toBe("call_xyz");
    expect(ev?.tool?.result).toBe("file contents");
    expect(ev?.tool?.isError).toBe(false);
  });

  it("tool_result: isError=true for error results", () => {
    const ev = parsePiEvent(
      JSON.stringify({
        type: "tool_result",
        toolName: "bash",
        toolCallId: "call_err",
        content: "command failed",
        isError: true,
      }),
    );
    expect(ev?.tool?.isError).toBe(true);
  });

  it("tool_call: gracefully handles missing fields", () => {
    const ev = parsePiEvent(JSON.stringify({ type: "tool_call" }));
    expect(ev?.tool?.name).toBe("unknown");
    expect(ev?.tool?.callId).toBe("");
  });
});

describe("extractMessageText", () => {
  it("extracts text from content blocks", () => {
    const text = extractMessageText({
      content: [
        { type: "text", text: "Hello" },
        { type: "tool_use", id: "x" },
        { type: "text", text: " world" },
      ],
    });
    expect(text).toBe("Hello world");
  });

  it("returns empty string for no content", () => {
    expect(extractMessageText({})).toBe("");
    expect(extractMessageText({ content: [] })).toBe("");
  });

  it("skips non-text blocks", () => {
    const text = extractMessageText({
      content: [{ type: "tool_use", id: "x" }],
    });
    expect(text).toBe("");
  });
});
