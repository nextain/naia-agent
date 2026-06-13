// adapters/protocol — wire ↔ domain 변환 (계약 §B.4). 공유 wire(H-agent) conform.
// os AgentOutbound(wire) → AgentRequest(domain) decode / AgentEmit(domain) → os AgentMessage(wire) encode.
import type { AgentRequest, AgentEmit, ProviderConfig, ChatMessage } from "../domain/chat.js";

/** wire line → AgentRequest. parseRequest(관대): type 화이트리스트, 미지=null. */
export function decodeRequest(line: string): AgentRequest | null {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null; // ⚠️ "null"/"3"/"true" 등 = TypeError 방지(baseline parseRequest 가드)
  const o = parsed as Record<string, unknown>;
  const type = typeof o["type"] === "string" ? (o["type"] as string) : undefined;
  switch (type) {
    case "chat_request": {
      // provider override 는 비어있지 않은 provider 문자열이 있을 때만 채택. 없거나 빈 객체 = undefined →
      // agent 가 기동 시 naia-settings 로딩한 defaultConfig 사용(정본: "대화는 메시지만"). 빈 {} 가 default 를 덮지 않게.
      const prov = o["provider"];
      const hasProv = !!prov && typeof prov === "object" && typeof (prov as Record<string, unknown>)["provider"] === "string" && (prov as Record<string, unknown>)["provider"] !== "";
      return {
        kind: "chat",
        requestId: str(o["requestId"]),
        ...(hasProv ? { provider: prov as ProviderConfig } : {}),
        messages: (Array.isArray(o["messages"]) ? o["messages"] : []) as ChatMessage[],
        ...(o["systemPrompt"] !== undefined ? { systemPrompt: str(o["systemPrompt"]) } : {}),
        ...(o["enableTools"] !== undefined ? { enableTools: !!o["enableTools"] } : {}),
        ...(o["enableThinking"] !== undefined ? { enableThinking: !!o["enableThinking"] } : {}),
        ...(o["gatewayUrl"] !== undefined ? { gatewayUrl: str(o["gatewayUrl"]) } : {}),
        ...(o["disabledSkills"] !== undefined ? { disabledSkills: o["disabledSkills"] as string[] } : {}),
      };
    }
    case "cancel_stream":
      return { kind: "cancel", requestId: str(o["requestId"]) };
    case "approval_response":
      return { kind: "approvalResponse", requestId: str(o["requestId"]), toolCallId: str(o["toolCallId"]), decision: o["decision"] === "approve" ? "approve" : "reject" };
    case "creds_update":
      return { kind: "credsUpdate", provider: str(o["provider"]), secret: { ...(o["apiKey"] !== undefined ? { apiKey: str(o["apiKey"]) } : {}), ...(o["naiaKey"] !== undefined ? { naiaKey: str(o["naiaKey"]) } : {}) } };
    case "tool_request":
      // old-core standalone 스킬 호출 — new-core 미지원. router 가 즉시 error 응답(셸 120s 행 방지).
      return { kind: "toolRequest", requestId: str(o["requestId"]), toolName: str(o["toolName"]) };
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
    case "toolResult": return { type: "tool_result", requestId, toolCallId: e.toolCallId, output: e.output, toolName: e.toolName, success: e.success }; // UC1 리뷰: success/toolName
    case "approvalRequest": return { type: "approval_request", requestId, toolCallId: e.toolCallId, toolName: e.toolName, tier: e.tier, args: e.args, description: e.description }; // UC1 리뷰: args/description
    case "gatewayApprovalRequest": return { type: "gateway_approval_request", requestId, toolCallId: e.toolCallId, toolName: e.toolName, args: e.args };
    case "usage": return { type: "usage", requestId, inputTokens: e.inputTokens, outputTokens: e.outputTokens, ...(e.cost !== undefined ? { cost: e.cost } : {}), ...(e.model !== undefined ? { model: e.model } : {}) };
    case "logEntry": return { type: "log_entry", requestId, level: e.level, message: e.message };
    case "tokenWarning": return { type: "token_warning", requestId, raw: e.raw };
    case "finish": return { type: "finish", requestId };
    case "error": return { type: "error", requestId, message: e.message };
  }
}

function str(v: unknown): string { return typeof v === "string" ? v : v == null ? "" : String(v); }
