// domain/chat — UC1 agent(brain) (계약 §B.1). 순수. I/O·wire 0.
// 공유 wire 경계(H-agent)에 conform: AgentRequest=os AgentOutbound 1:1, AgentEmit=os chat-turn AgentMessage.

export interface ProviderConfig {
  readonly provider: string;
  readonly model: string;
  readonly ollamaHost?: string;
  readonly vllmHost?: string;
  readonly labGatewayUrl?: string;
  readonly enableThinking?: boolean;
  readonly ollamaNumCtx?: number;
  readonly apiKey?: string;   // creds_update 채널로만 적재(chat_request wire 엔 없음)
  readonly naiaKey?: string;
}

export interface ChatMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
}

// ── inbound domain 폐쇄 union (os AgentOutbound 와 1:1) ──
export interface ChatRequest {
  readonly kind: "chat";
  readonly requestId: string;
  readonly provider: ProviderConfig;
  readonly messages: readonly ChatMessage[];
  readonly systemPrompt?: string;
  readonly enableTools?: boolean;
  readonly enableThinking?: boolean; // top-level (agent 가 providerConfig 에 주입)
  readonly gatewayUrl?: string;
  readonly disabledSkills?: readonly string[];
}
export interface CancelRequest { readonly kind: "cancel"; readonly requestId: string; }
export interface ApprovalResponse {
  readonly kind: "approvalResponse"; readonly requestId: string;
  readonly toolCallId: string; readonly decision: "approve" | "reject";
}
export interface CredsUpdate {
  readonly kind: "credsUpdate"; readonly provider: string;
  readonly secret: { readonly apiKey?: string; readonly naiaKey?: string };
}
export type AgentRequest = ChatRequest | CancelRequest | ApprovalResponse | CredsUpdate;

// ── provider-중립 도메인 정규화 스트림 단위 (old StreamChunk 의 정규화; error 없음=rejection) ──
export type ProviderChunk =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "toolUse"; readonly id: string; readonly name: string; readonly args: unknown }
  | { readonly kind: "usage"; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: "finish" };

// ── egress 가 wire 로 내보낼 chat-turn domain chunk (os chat-turn AgentMessage 의 domain 표현, 폐쇄) ──
export type AgentEmit =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "toolUse"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown }
  | { readonly kind: "toolResult"; readonly toolCallId: string; readonly output: string }
  | { readonly kind: "approvalRequest"; readonly toolCallId: string; readonly toolName: string; readonly tier: string } // UC5 방출
  | { readonly kind: "gatewayApprovalRequest"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown } // UC5 방출
  | { readonly kind: "usage"; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: "logEntry"; readonly level: string; readonly message: string }
  | { readonly kind: "tokenWarning"; readonly raw: unknown }
  | { readonly kind: "finish" }
  | { readonly kind: "error"; readonly message: string };

export function isTerminalEmit(e: AgentEmit): boolean {
  return e.kind === "finish" || e.kind === "error";
}

// ── ChatTurn 상태기계 (순수) ──
export type ChatTurnState = "streaming" | "cancelling" | "finished" | "errored";
export function isTerminalState(s: ChatTurnState): boolean {
  return s === "finished" || s === "errored";
}

/**
 * 1:1 순수 매핑: ProviderChunk → AgentEmit. toolUse id→toolCallId, name→toolName.
 * ⚠️ usage 는 여기서 매핑 안 함(handler 가 누적 — 호출 전 분기). finish→finish. error 생성 안 함(rejection=handler catch).
 */
export function mapProviderChunk(c: Exclude<ProviderChunk, { kind: "usage" }>): AgentEmit {
  switch (c.kind) {
    case "text": return { kind: "text", text: c.text };
    case "thinking": return { kind: "thinking", text: c.text };
    case "toolUse": return { kind: "toolUse", toolCallId: c.id, toolName: c.name, args: c.args };
    case "finish": return { kind: "finish" };
  }
}
