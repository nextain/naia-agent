// ports — UC1 agent(brain) (계약 §B.2). domain 만 의존.
import type {
  ProviderConfig, ChatMessage, ProviderChunk, AgentEmit, AgentRequest,
} from "../domain/chat.js";

export type Unsub = () => void;

// ── driven (brain 이 의존) ──
export interface ProviderChatOpts {
  readonly systemPrompt?: string;
  readonly signal?: AbortSignal;
}
export interface ProviderPort {
  /** LLM 추론 스트림. abort signal 수용. rejection(throw) 전파(error 는 chunk 아님). */
  chat(config: ProviderConfig, messages: readonly ChatMessage[], opts: ProviderChatOpts): AsyncIterable<ProviderChunk>;
}

export interface ConversationPort {
  /** 대화조립 — token-budget + system-prompt. */
  assemble(req: { messages: readonly ChatMessage[]; systemPrompt?: string }): { messages: readonly ChatMessage[]; systemPrompt?: string };
}

export interface CredentialPort {
  /** creds_update 수신 시 갱신. */
  update(provider: string, secret: { apiKey?: string; naiaKey?: string }): void;
  /** providerConfig 조립 시 주입(secret 은 chat_request wire 엔 없음, creds_update 채널). */
  get(provider: string): { apiKey?: string; naiaKey?: string } | undefined;
}

export interface ApprovalPort {
  /** inbound approval_response 처리(보류 결정 해소). UC1 범위. awaitDecision(emit+대기)=UC5. */
  resolve(requestId: string, toolCallId: string, decision: "approve" | "reject"): void;
}

// ── driving-in (wire→brain), 단일 구독자 ──
export interface AgentIngressPort {
  /** parseRequest 후 전 AgentRequest variant 단일 cb(미지=무시+log). router 가 type 분기. */
  onRequest(cb: (req: AgentRequest) => void): Unsub;
}

// ── driven-out (brain→wire) ──
export interface AgentEgressPort {
  /** AgentEmit → wire AgentMessage writeLine. ⚠️ no-throw(실패=로그, throw 금지). */
  emit(requestId: string, e: AgentEmit): void;
}

/** out-of-band 진단(중복 requestId 등 — wire 아님). */
export interface DiagnosticLog {
  log(message: string, ctx?: unknown): void;
}
