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

// ── UC5 도구 (계약 §B.1) ──
export interface ToolSpec { readonly name: string; readonly description: string; readonly parameters: unknown /* JSON schema */; readonly tier?: string /* UC5 slice 2: 미설정/"none"=자동, 그 외=승인 필요 */; }
export interface ToolCall { readonly id: string; readonly name: string; readonly args: unknown; }

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[]; // assistant 전용 — UC5 도구 라운드(없으면 미설정)
  readonly toolCallId?: string;             // tool 전용 — 결과 메시지가 어느 call 에 대응하는지 결속
}

// ── inbound domain 폐쇄 union (os AgentOutbound 와 1:1) ──
export interface ChatRequest {
  readonly kind: "chat";
  readonly requestId: string;
  /** 대화별 세션 id(shell localSessionId) — agent 가 transcript 를 세션 파일로 분리하는 키(FR-CONV.2). 누락 시 단일 fallback. */
  readonly sessionId?: string;
  /** wire 가 실은 provider override(옵셔널). 없으면 agent 가 기동 시 naia-settings 로딩한 defaultConfig 사용 —
   *  정본(루크): "대화는 메시지만 던지면 agent 가 미리(기동 시) 설정된 provider 로 처리". 있으면 그 요청만 오버라이드(하위호환). */
  readonly provider?: ProviderConfig;
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
/** 셸의 standalone tool_request(IPC) — old-core 가 스킬을 직접 실행하던 경로(skill_sessions/skill_config/gateway history 등).
 *  new-core 는 LLM 도구루프(chat_request) 로만 도구 실행 → standalone tool_request 는 미지원. 단 **즉시 error 응답**해야
 *  셸 directToolCall 이 120s 행에 빠지지 않음(무응답 시 RESPONSE_TIMEOUT → 패널 행·WebDriver 세션 드롭 유발). */
export interface ToolRequestControl { readonly kind: "toolRequest"; readonly requestId: string; readonly toolName: string; }
export type AgentRequest = ChatRequest | CancelRequest | ApprovalResponse | CredsUpdate | ToolRequestControl;

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
  | { readonly kind: "toolResult"; readonly toolCallId: string; readonly output: string; readonly toolName: string; readonly success: boolean } // UC1 리뷰: success/toolName 보존
  | { readonly kind: "approvalRequest"; readonly toolCallId: string; readonly toolName: string; readonly tier: string; readonly args: unknown; readonly description: string } // UC5 방출 + UC1 리뷰(args/description)
  | { readonly kind: "gatewayApprovalRequest"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown } // UC5 방출
  | { readonly kind: "usage"; readonly inputTokens: number; readonly outputTokens: number; readonly cost?: number; readonly model?: string }
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

/**
 * UC5 도구 라운드 결과를 다음 provider 호출용 messages 로 엮음(순수, 계약 §B.1).
 * assistant(roundText + toolCalls) append → 각 call 의 결과를 tool 메시지로 append(순서·결속 보존).
 * roundText 가 history 에서 유실되지 않음. results[i] = calls[i] 의 결과(인덱스 대응).
 */
export function threadToolRound(
  messages: readonly ChatMessage[],
  roundText: string,
  calls: readonly ToolCall[],
  results: readonly { readonly output: string }[],
): readonly ChatMessage[] {
  const assistant: ChatMessage = { role: "assistant", content: roundText, toolCalls: calls };
  const toolMsgs: ChatMessage[] = calls.map((c, i) => ({ role: "tool", toolCallId: c.id, content: results[i]?.output ?? "" }));
  return [...messages, assistant, ...toolMsgs];
}
