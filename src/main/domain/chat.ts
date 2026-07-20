// domain/chat — UC1 agent(brain) (계약 §B.1). 순수. I/O·wire 0.
// 공유 wire 경계(H-agent)에 conform: AgentRequest=os AgentOutbound 1:1, AgentEmit=os chat-turn AgentMessage.

export interface ProviderConfig {
  readonly provider: string;
  readonly model: string;
	readonly ollamaHost?: string;
	/** Ollama GPU layer count; 0 keeps the model off the display GPU. */
	readonly ollamaNumGpu?: number;
	readonly vllmHost?: string;
  readonly labGatewayUrl?: string;
  readonly enableThinking?: boolean;
  readonly ollamaNumCtx?: number;
  readonly apiKey?: string;   // creds_update 채널로만 적재(chat_request wire 엔 없음)
  readonly naiaKey?: string;
}

// ── UC5 도구 (계약 §B.1) ──
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown /* JSON schema */;
  readonly tier?: string /* UC5 slice 2: 미설정/"none"=자동, 그 외=승인 필요 */;
  /** Trusted executor-owned metadata; provider/model output schemas omit this field. */
  readonly processing?: {
    readonly workload: "network_tool";
    readonly destination: ProcessingDestination;
    readonly provider: string;
    readonly model: string;
    /** Optional trusted argument predicate for mixed local/external tools. */
    readonly when?: {
      readonly key: string;
      readonly values: readonly (string | number | boolean)[];
    };
  };
}
export interface ToolCall { readonly id: string; readonly name: string; readonly args: unknown; }

// ── UC-ENV-SEGMENTS (S4, 계약 C2) — 환경고유 컨텍스트 폐쇄 union ──
// 클라(naia-os)가 환경고유 정보를 *raw systemPrompt 에 굽지 않고* 구조화 세그먼트로 전달, 코어가 머지.
// 권한 모델(C2/GLM): persona/profile/workspaceContext 는 클라 주입 **금지**(코어 SoT) — environmentSegments **만**
// 클라 제공이며, 그것도 자유 system-prompt 텍스트가 아니라 **kind 별 구조화 값**이다. 자유 텍스트로 persona/
// workspace/agentInstruction 을 위조 주입하는 경로를 API 차원에서 차단(raw systemPrompt 이름만 바꾼 게 아님).
//  - avatarEmotion: naia-os 아바타 모드 — 코어가 표준 emotion-tag 지시문을 *자체 발행*(클라는 capability flag 만,
//    문구는 코어 소유). 아바타 없는 CLI 는 omit → emotion 지시 없음.
//  - panel: 런타임 UI 패널 컨텍스트 — "참고 데이터"로 격리·이스케이프(JSON.stringify + 길이 제한). 모델 지시문 아님.
//  - responseStyle: 환경의 응답 스타일 힌트(음성 파이프라인 = brief). 코어가 표준 간결성 지시문을 *자체 발행*
//    (클라는 style enum 만, 문구는 코어 소유). brief=짧은 구어 응답, normal=무영향. 음성 STT→채팅 경로가 raw
//    systemPrompt 로 persona 를 덮던 회귀(S4)를 닫는다 — persona 조립을 보존하면서 간결성만 환경 지시로 운반.
// 화이트리스트(avatarEmotion|panel|responseStyle) 외 kind 는 코어가 드롭(domain/environment-segments.ts).
export type EnvironmentSegment =
  | { readonly kind: "avatarEmotion" }
  | { readonly kind: "panel"; readonly entries: readonly { readonly type: string; readonly data: unknown }[] }
  | { readonly kind: "responseStyle"; readonly style: "brief" | "normal" };

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[]; // assistant 전용 — UC5 도구 라운드(없으면 미설정)
  readonly toolCallId?: string;             // tool 전용 — 결과 메시지가 어느 call 에 대응하는지 결속
  readonly attachments?: readonly AttachmentRef[];
}

export type ImageMimeType = "image/png" | "image/jpeg" | "image/webp";
export interface AttachmentRef {
  readonly id: string;
  readonly kind: "image";
  readonly mimeType: ImageMimeType;
  readonly sizeBytes: number;
  readonly localRef: string;
}
export type ChannelContext =
  | { readonly kind: "shell" }
  | {
      readonly kind: "discord";
      readonly bindingId: string;
      readonly guildId: string;
      readonly channelId: string;
      readonly userId: string;
    };
export interface GroundingRequest {
  readonly policy: "off" | "available" | "required";
  readonly knowledgeScope: string;
}
export type ProcessingDestination = "local_device" | "private_managed" | "external_cloud";
export type ProcessingWorkload = "main_llm" | "sub_llm" | "memory_llm" | "embedding" | "network_tool";
export type ProcessingDecision = "allowed" | "blocked" | "confirmation_required";
export interface ProcessingRequest { readonly processingProfileRef: string }
export interface ProcessingDisclosure {
  readonly workload: ProcessingWorkload;
  readonly destination: ProcessingDestination;
  readonly decision: ProcessingDecision;
  readonly processingProfileRef: string;
  readonly provider?: string;
  readonly model?: string;
}
export type ProviderSessionRequest =
  | { readonly mode: "new" }
  | { readonly mode: "resume"; readonly providerSessionRef: string };
export interface GroundingSource {
  readonly title: string;
  readonly sourceUris: readonly string[];
}
export interface ImageArtifact extends AttachmentRef {
  readonly name?: string;
}
export type WireErrorCode =
  | "PROVIDER_NOT_INSTALLED"
  | "PROVIDER_LOGIN_REQUIRED"
  | "PROVIDER_AUTH_EXPIRED"
  | "PROVIDER_NETWORK"
  | "DISCORD_TOKEN_MISSING"
  | "DISCORD_INTENTS_MISSING"
  | "DISCORD_NOT_INSTALLED"
  | "DISCORD_PERMISSION_DENIED"
  | "DISCORD_RATE_LIMITED"
  | "ATTACHMENT_UNSUPPORTED_TYPE"
  | "ATTACHMENT_TOO_LARGE"
  | "ATTACHMENT_INVALID_REF"
  | "KNOWLEDGE_UNCOMPILED"
  | "KNOWLEDGE_UNAVAILABLE"
  | "WIRE_INVALID_ARGUMENT"
  | "WIRE_UNSUPPORTED_ENUM"
  | "WIRE_SCOPE_FORBIDDEN"
  | "PROVIDER_SESSION_MISMATCH"
  | "PROVIDER_SESSION_EXPIRED"
  | "PROVIDER_SESSION_CLOSED"
  | "PROCESSING_PROFILE_REQUIRED"
  | "PROCESSING_DESTINATION_UNKNOWN"
  | "EXTERNAL_PROCESSING_FORBIDDEN"
  | "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED";

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
  /** raw override(--system 플래그 등 명시 override). S4 종착: 코어가 persona+workspace+environmentSegments 를
   *  스스로 조립 — naia-os 는 더는 systemPrompt 를 싣지 않는다. 있으면 코어 조립 전부 무시(명시 override only). */
  readonly systemPrompt?: string;
  /** S4 — 클라(naia-os) 환경고유 컨텍스트(아바타 감정·패널). 코어가 persona+workspace 뒤에 결정론 머지.
   *  CLI 는 빈 배열(아바타·패널 없음). 화이트리스트 외 kind 는 코어가 드롭. systemPrompt override 시 무시. */
  readonly environmentSegments?: readonly EnvironmentSegment[];
  readonly enableTools?: boolean;
  readonly enableThinking?: boolean; // top-level (agent 가 providerConfig 에 주입)
  readonly gatewayUrl?: string;
  readonly disabledSkills?: readonly string[];
  /** UC-CONT-MVP-6 — YieldSpeechActivity가 발급한 profile-bound Q&A 결속. app이 검증하기 전에는 권한 없음. */
  readonly activityResume?: {
    readonly activityId: string;
    readonly profileGeneration: number;
    readonly yieldGeneration: number;
    readonly resumeToken: string;
  };
  readonly channel?: ChannelContext;
  readonly grounding?: GroundingRequest;
  readonly providerSession?: ProviderSessionRequest;
  readonly processing?: ProcessingRequest;
}
export interface CancelRequest { readonly kind: "cancel"; readonly requestId: string; readonly activityId?: string; }
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
  | { readonly kind: "compacted"; readonly droppedCount: number } // UC-compaction(FR-COMPACT): 예산 압박 시 head 요약 발생 알림(UI 표시용, 비-terminal)
  | { readonly kind: "panelToolCall"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown } // UC-PANEL FR-PANEL-2: 환경 도구(BGM·브라우저·workspace) 위임 — agent 미실행, 셸이 실행(비-terminal)
  | { readonly kind: "grounding"; readonly status: "grounded" | "no_evidence" | "uncompiled" | "unavailable"; readonly sources: readonly GroundingSource[] }
  | { readonly kind: "artifact"; readonly artifact: ImageArtifact }
  | { readonly kind: "providerSession"; readonly sessionId: string; readonly providerSessionRef: string; readonly state: "started" | "resumed" | "closed" }
  | ({ readonly kind: "processingDisclosure" } & ProcessingDisclosure)
  | { readonly kind: "finish" }
  | { readonly kind: "error"; readonly message: string; readonly code?: WireErrorCode };

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

/** 휴리스틱 토큰 추정(≈4 char/token, 메시지당 framing 16자) — 압축 트리거 판단용(정확 토크나이저 불요).
 *  순수. budgeted-conversation 의 char≈token 휴리스틱과 동일 기준. */
export function estimateMessageTokens(messages: readonly ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += (m.content?.length ?? 0) + 16;
  return Math.ceil(chars / 4);
}
