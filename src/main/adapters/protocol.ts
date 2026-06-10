// adapters/protocol — wire ↔ domain 변환 (계약 §B.4). 공유 wire(H-agent) conform.
// os AgentOutbound(wire) → AgentRequest(domain) decode / AgentEmit(domain) → os AgentMessage(wire) encode.
import type { AgentRequest, AgentEmit, ProviderConfig, ChatMessage } from "../domain/chat.js";

/** wire line → AgentRequest. parseRequest(관대): type 화이트리스트, 미지=null. */
export function decodeRequest(line: string): AgentRequest | null {
  let o: Record<string, unknown>;
  try { o = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  const type = typeof o["type"] === "string" ? (o["type"] as string) : undefined;
  switch (type) {
    case "chat_request":
      return {
        kind: "chat",
        requestId: str(o["requestId"]),
        provider: (o["provider"] ?? {}) as ProviderConfig,
        messages: (Array.isArray(o["messages"]) ? o["messages"] : []) as ChatMessage[],
        ...(o["systemPrompt"] !== undefined ? { systemPrompt: str(o["systemPrompt"]) } : {}),
        ...(o["enableTools"] !== undefined ? { enableTools: !!o["enableTools"] } : {}),
        ...(o["enableThinking"] !== undefined ? { enableThinking: !!o["enableThinking"] } : {}),
        ...(o["gatewayUrl"] !== undefined ? { gatewayUrl: str(o["gatewayUrl"]) } : {}),
        ...(o["disabledSkills"] !== undefined ? { disabledSkills: o["disabledSkills"] as string[] } : {}),
      };
    case "cancel_stream":
      return { kind: "cancel", requestId: str(o["requestId"]) };
    case "approval_response":
      return { kind: "approvalResponse", requestId: str(o["requestId"]), toolCallId: str(o["toolCallId"]), decision: o["decision"] === "approve" ? "approve" : "reject" };
    case "creds_update":
      return { kind: "credsUpdate", provider: str(o["provider"]), secret: { ...(o["apiKey"] !== undefined ? { apiKey: str(o["apiKey"]) } : {}), ...(o["naiaKey"] !== undefined ? { naiaKey: str(o["naiaKey"]) } : {}) } };
    default:
      return null; // 미지 = router 가 무시+log
  }
}

/** AgentEmit(domain) → os AgentMessage(wire). kind(camel)→type(snake), requestId 결속. */
export function encodeEmit(requestId: string, e: AgentEmit): Record<string, unknown> {
  switch (e.kind) {
    case "text": return { type: "text", requestId, text: e.text };
    case "thinking": return { type: "thinking", requestId, text: e.text };
    case "toolUse": return { type: "tool_use", requestId, toolCallId: e.toolCallId, toolName: e.toolName, args: e.args };
    case "toolResult": return { type: "tool_result", requestId, toolCallId: e.toolCallId, output: e.output };
    case "approvalRequest": return { type: "approval_request", requestId, toolCallId: e.toolCallId, toolName: e.toolName, tier: e.tier };
    case "gatewayApprovalRequest": return { type: "gateway_approval_request", requestId, toolCallId: e.toolCallId, toolName: e.toolName, args: e.args };
    case "usage": return { type: "usage", requestId, inputTokens: e.inputTokens, outputTokens: e.outputTokens };
    case "logEntry": return { type: "log_entry", requestId, level: e.level, message: e.message };
    case "tokenWarning": return { type: "token_warning", requestId, raw: e.raw };
    case "finish": return { type: "finish", requestId };
    case "error": return { type: "error", requestId, message: e.message };
  }
}

function str(v: unknown): string { return typeof v === "string" ? v : v == null ? "" : String(v); }
