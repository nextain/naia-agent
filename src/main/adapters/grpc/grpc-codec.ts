// adapters/grpc/grpc-codec — proto(naia_agent.proto) ↔ domain 순수 매핑.
// stdio 의 protocol.ts(decodeRequest/encodeEmit) 와 동형 — transport 만 다름(직교). gRPC 의존 없음(순수, 테스트 가능).
// proto 메시지는 @grpc/proto-loader 가 런타임 로드하는 plain object → 여기서 도메인 타입으로 변환.
import type { AgentRequest, AgentEmit, ChatMessage } from "../../domain/chat.js";

// proto-shaped 입력(proto-loader plain object; 필드명 = proto snake_case 또는 camelCase — loader keepCase=false 가정 camelCase).
export interface PbChatRequest {
  requestId: string;
  sessionId?: string;
  messages: { role: string; content: string; toolCallId?: string }[];
  systemPrompt?: string;
  enableTools?: boolean;
  enableThinking?: boolean;
  gatewayUrl?: string;
  disabledSkills?: string[];
}
export interface PbCancel { requestId: string }
export interface PbApproval { requestId: string; toolCallId: string; decision: number | string } // 0/REJECT, 1/APPROVE
export interface PbCreds { provider: string; apiKey?: string; naiaKey?: string }
export interface PbToolRequest { requestId: string; toolName: string }

// ── 도메인 chat 요청 조립 (protocol.ts decodeRequest 의 chat_request 분기 이식; provider 제거=정본) ──
const VALID_ROLES = new Set(["system", "user", "assistant", "tool"]);
export function chatRequestToDomain(p: PbChatRequest): Extract<AgentRequest, { kind: "chat" }> {
  // role 은 protocol.ts 와 동일하게 passthrough(4종 보존 — "tool" 을 "user" 로 뭉개지 않음). tool_call_id 보존.
  const messages: ChatMessage[] = (p.messages ?? []).map((m) => ({
    role: (VALID_ROLES.has(m.role) ? m.role : "user") as ChatMessage["role"],
    content: String(m.content ?? ""),
    ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
  }));
  return {
    kind: "chat",
    requestId: String(p.requestId ?? ""),
    messages,
    ...(p.sessionId !== undefined ? { sessionId: String(p.sessionId) } : {}),
    ...(p.systemPrompt !== undefined ? { systemPrompt: p.systemPrompt } : {}),
    ...(p.enableTools !== undefined ? { enableTools: p.enableTools } : {}),
    ...(p.enableThinking !== undefined ? { enableThinking: p.enableThinking } : {}),
    ...(p.gatewayUrl !== undefined ? { gatewayUrl: p.gatewayUrl } : {}),
    ...(p.disabledSkills !== undefined ? { disabledSkills: p.disabledSkills } : {}),
  };
}

export function cancelToDomain(p: PbCancel): Extract<AgentRequest, { kind: "cancel" }> {
  return { kind: "cancel", requestId: String(p.requestId ?? "") };
}
export function approvalToDomain(p: PbApproval): Extract<AgentRequest, { kind: "approvalResponse" }> {
  const approve = p.decision === 1 || p.decision === "APPROVE" || p.decision === "approve";
  return { kind: "approvalResponse", requestId: String(p.requestId ?? ""), toolCallId: String(p.toolCallId ?? ""), decision: approve ? "approve" : "reject" };
}
export function credsToDomain(p: PbCreds): Extract<AgentRequest, { kind: "credsUpdate" }> {
  return {
    kind: "credsUpdate", provider: String(p.provider ?? ""),
    secret: { ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}), ...(p.naiaKey !== undefined ? { naiaKey: p.naiaKey } : {}) },
  };
}
export function toolRequestToDomain(p: PbToolRequest): Extract<AgentRequest, { kind: "toolRequest" }> {
  return { kind: "toolRequest", requestId: String(p.requestId ?? ""), toolName: String(p.toolName ?? "") };
}

// ── 도메인 AgentEmit → proto AgentEvent (protocol.ts encodeEmit 11종 1:1 이식; oneof field 1개 set) ──
export interface PbAgentEvent { requestId: string; [oneof: string]: unknown }
export function emitToProto(requestId: string, e: AgentEmit): PbAgentEvent {
  switch (e.kind) {
    case "text": return { requestId, text: { text: e.text } };
    case "thinking": return { requestId, thinking: { text: e.text } };
    case "toolUse": return { requestId, toolUse: { toolCallId: e.toolCallId, toolName: e.toolName, argsJson: JSON.stringify(e.args ?? null) } };
    case "toolResult": return { requestId, toolResult: { toolCallId: e.toolCallId, output: e.output, toolName: e.toolName, success: e.success } };
    case "approvalRequest": return { requestId, approvalRequest: { toolCallId: e.toolCallId, toolName: e.toolName, tier: e.tier, argsJson: JSON.stringify(e.args ?? null), description: e.description } };
    case "gatewayApprovalRequest": return { requestId, gatewayApprovalRequest: { toolCallId: e.toolCallId, toolName: e.toolName, argsJson: JSON.stringify(e.args ?? null) } };
    case "usage": return { requestId, usage: { inputTokens: e.inputTokens, outputTokens: e.outputTokens, ...(e.cost !== undefined ? { cost: e.cost } : {}), ...(e.model !== undefined ? { model: e.model } : {}) } };
    case "logEntry": return { requestId, logEntry: { level: e.level, message: e.message } };
    case "tokenWarning": return { requestId, tokenWarning: { rawJson: JSON.stringify(e.raw ?? null) } };
    case "finish": return { requestId, finish: {} };
    case "error": return { requestId, error: { message: e.message } };
  }
}
