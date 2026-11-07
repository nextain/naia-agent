// sessionId seam(FR-CONV.2) — proto ChatRequest.session_id → domain ChatRequest.sessionId.
// 누락 시 미설정(domain 에 sessionId 없음 → handler 가 "default" fallback). 기존 필드 무회귀.
import { describe, it, expect } from "vitest";
import { decodeRequest } from "../main/adapters/protocol.js";
import { chatRequestToDomain } from "../main/adapters/grpc/grpc-codec.js";

describe("chatRequestToDomain — sessionId 배선(FR-CONV.2)", () => {
  it("sessionId 보존", () => {
    const d = chatRequestToDomain({ requestId: "r1", sessionId: "chat-123", messages: [{ role: "user", content: "hi" }] });
    expect(d.sessionId).toBe("chat-123");
  });
  it("sessionId 누락 = 미설정(handler 가 default fallback)", () => {
    const d = chatRequestToDomain({ requestId: "r1", messages: [{ role: "user", content: "hi" }] });
    expect(d.sessionId).toBeUndefined();
  });
  it("기존 필드 무회귀(systemPrompt/enableTools 보존)", () => {
    const d = chatRequestToDomain({ requestId: "r1", sessionId: "s", messages: [], systemPrompt: "sp", enableTools: true });
    expect(d.systemPrompt).toBe("sp");
    expect(d.enableTools).toBe(true);
    expect(d.sessionId).toBe("s");
  });
});

it("FR-CONV.6 appName survives request and restored message codec", () => {
  const d = chatRequestToDomain({ requestId: "app", appName: "character", messages: [
    { role: "user", content: "u", appName: "character" },
    { role: "assistant", content: "a", appName: "character" },
  ] });
  expect(d.appName).toBe("character");
  expect(d.messages.map((m) => m.appName)).toEqual(["character", "character"]);
});


it("stdio keeps appName and session isolation", () => {
  const d = decodeRequest(JSON.stringify({ type: "chat_request", requestId: "a", sessionId: "s", appName: "character", messages: [{ role: "user", content: "u", appName: "character" }] }));
  expect(d).toMatchObject({ kind: "chat", sessionId: "s", appName: "character", messages: [{ appName: "character" }] });
});
