import { describe, expect, it } from "vitest";
import { parseOpencodeEvent } from "../event-parser.js";

describe("parseOpencodeEvent — NDJSON line parser", () => {
  it("returns null for empty line", () => {
    expect(parseOpencodeEvent("")).toBeNull();
    expect(parseOpencodeEvent("   ")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseOpencodeEvent("not json")).toBeNull();
    expect(parseOpencodeEvent("{broken")).toBeNull();
  });

  it("classifies step_start / text / tool_use / step_finish", () => {
    expect(
      parseOpencodeEvent(
        '{"type":"step_start","sessionID":"ses_a","part":{"type":"step-start"}}',
      )?.type,
    ).toBe("step_start");

    expect(
      parseOpencodeEvent(
        '{"type":"text","sessionID":"ses_a","part":{"type":"text","text":"hi"}}',
      )?.type,
    ).toBe("text");

    expect(
      parseOpencodeEvent(
        '{"type":"tool_use","sessionID":"ses_a","part":{"type":"tool","tool":"write","callID":"call_1","state":{"status":"completed"}}}',
      )?.type,
    ).toBe("tool_use");

    expect(
      parseOpencodeEvent(
        '{"type":"step_finish","sessionID":"ses_a","part":{"type":"step-finish","reason":"stop"}}',
      )?.type,
    ).toBe("step_finish");
  });

  it("classifies unknown types", () => {
    expect(
      parseOpencodeEvent('{"type":"new_future_event","part":{}}')?.type,
    ).toBe("unknown");
  });

  it("extracts text from text event part.text", () => {
    const ev = parseOpencodeEvent(
      '{"type":"text","sessionID":"ses_a","part":{"type":"text","text":"hello world"}}',
    );
    expect(ev?.text).toBe("hello world");
  });

  it("extracts tool details (name/callId/status/input/output)", () => {
    const ev = parseOpencodeEvent(
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_a",
        part: {
          type: "tool",
          tool: "write",
          callID: "call_xyz",
          state: {
            status: "completed",
            input: { filePath: "/tmp/x.txt", content: "hi" },
            output: "Wrote file successfully.",
          },
        },
      }),
    );
    expect(ev?.tool?.name).toBe("write");
    expect(ev?.tool?.callId).toBe("call_xyz");
    expect(ev?.tool?.status).toBe("completed");
    expect(ev?.tool?.input).toEqual({
      filePath: "/tmp/x.txt",
      content: "hi",
    });
    expect(ev?.tool?.output).toBe("Wrote file successfully.");
  });

  it("extracts step_finish reason and tokens", () => {
    const ev = parseOpencodeEvent(
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_a",
        part: {
          type: "step-finish",
          reason: "tool-calls",
          tokens: {
            total: 9989,
            input: 25,
            output: 25,
            reasoning: 19,
            cache: { read: 9920, write: 0 },
          },
        },
      }),
    );
    expect(ev?.stepFinishReason).toBe("tool-calls");
    expect(ev?.tokens?.total).toBe(9989);
    expect(ev?.tokens?.input).toBe(25);
    expect(ev?.tokens?.cacheRead).toBe(9920);
  });

  it("propagates sessionID and timestamp", () => {
    const ev = parseOpencodeEvent(
      '{"type":"text","sessionID":"ses_xyz","timestamp":1700000000,"part":{"type":"text","text":"x"}}',
    );
    expect(ev?.sessionID).toBe("ses_xyz");
    expect(ev?.timestamp).toBe(1700000000);
  });
});
