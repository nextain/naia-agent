// ports — UC1 agent(brain) (계약 §B.2) + UC5 도구(§B.2). domain 만 의존.
import type {
  ProviderConfig, ChatMessage, ProviderChunk, AgentEmit, AgentRequest, ToolSpec, ToolCall,
} from "../domain/chat.js";
import type { PersonaProfile } from "../domain/persona.js";
import type { WorkspaceSnapshot } from "../domain/workspace-context.js";

export type Unsub = () => void;

// ── driven (brain 이 의존) ──
export interface ProviderChatOpts {
  readonly systemPrompt?: string;
  readonly signal?: AbortSignal;
  readonly tools?: readonly ToolSpec[]; // UC5 — LLM 에 전달할 도구 사양(미지원 provider 는 무시)
}
export interface ProviderPort {
  /** LLM 추론 스트림. abort signal 수용. rejection(throw) 전파(error 는 chunk 아님). */
  chat(config: ProviderConfig, messages: readonly ChatMessage[], opts: ProviderChatOpts): AsyncIterable<ProviderChunk>;
}

/** 요청별 provider 해석(driven). config(provider/model/naiaKey/apiKey) → 그 요청용 ProviderPort.
 *  단일 고정 provider 가 아닌 config 기반 라우팅(lab-proxy/native/ollama). old buildProvider 의 포트화. */
export interface ProviderResolverPort {
  resolve(config: ProviderConfig): ProviderPort;
}

/** UC5 도구 실행기(driven). agent 가 등록 도구를 실행. */
export interface ToolExecutorPort {
  /** LLM 에 전달할 등록 도구 사양(빈 배열 가능 = 도구 없음). */
  specs(): readonly ToolSpec[];
  /** ⚠️ no-throw 책임: 미등록/실행실패/타임아웃 = { output, isError:true } 반환(throw 금지 — 루프 안정·LLM 복구). abort 시에만 reject 허용(루프가 cancelled 처리).
   *  requestId = UC-PANEL: panel(환경) 도구가 panel_tool_call 을 어느 chat 스트림으로 emit 할지 식별(셸 위임). builtin 도구는 무시. */
  execute(call: ToolCall, opts: { signal?: AbortSignal; requestId?: string }): Promise<{ output: string; isError?: boolean }>;
}

export interface ConversationPort {
  /** 대화조립 — token-budget + system-prompt. */
  assemble(req: { messages: readonly ChatMessage[]; systemPrompt?: string }): { messages: readonly ChatMessage[]; systemPrompt?: string };
}

/** UC-PERSONA-CLI driven — 워크스페이스 설정의 페르소나 프로필 로드(driven). 구현=persona-source-store
 *  (`<adkPath>/naia-settings/config.json` 읽기). 파일 부재/손상 = undefined(no-throw). */
export interface PersonaSourcePort {
  /** 워크스페이스 페르소나 프로필. 소스 부재/손상 = undefined(페르소나 기본 없음). */
  load(): PersonaProfile | undefined;
}

/** UC-WORKSPACE-CTX driven — 워크스페이스 컨텍스트(cwd + 프로젝트 이름 목록) 경량 스냅샷(driven).
 *  구현=workspace-context-store(`<adkPath>/projects/` 1-depth shallow readdir). **파일 내용/깊은 walk 없음**
 *  (GLM: snapshot 덤프 방지 — 이름 + cwd 만, 상세는 read_file 도구=S3). 디렉터리 부재/읽기실패 = undefined 또는
 *  빈 projects(no-throw degrade). 코어가 per-turn snapshot()→composeWorkspaceContext 로 persona 뒤에 append. */
export interface WorkspaceContextPort {
  /** 경량 워크스페이스 스냅샷(cwd + cap 적용 프로젝트 목록 + 전체 수). 소스 부재 = undefined. */
  snapshot(): WorkspaceSnapshot | undefined;
}

export interface CredentialPort {
  /** creds_update 수신 시 갱신. */
  update(provider: string, secret: { apiKey?: string; naiaKey?: string }): void;
  /** providerConfig 조립 시 주입(secret 은 chat_request wire 엔 없음, creds_update 채널). */
  get(provider: string): { apiKey?: string; naiaKey?: string } | undefined;
}

export interface ApprovalPort {
  /** inbound approval_response 처리(보류 해소). 미등록/이미 해소 key = no-op(delete-before-settle). */
  resolve(requestId: string, toolCallId: string, decision: "approve" | "reject"): void;
  /**
   * UC5 slice 2 — 보류를 *즉시 등록*(register-before-emit) 후 {promise, dispose} 반환.
   * promise: approval_response 도착 시 resolve / abort·dispose 시 reject. dispose: 미해소면 reject(settle)+정리, idempotent.
   * abort 원자성(check→listen→recheck). 구조적 키(nested map). 단일 settlement.
   */
  prepareDecision(requestId: string, toolCallId: string, opts: { signal?: AbortSignal }): { promise: Promise<"approve" | "reject">; dispose: () => void };
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

/** out-of-band 진단(중복 requestId 등 — wire 아님). 표준 로깅 sink(docs/logging.md). console.* 직접 금지(check-logging 강제). */
export interface DiagnosticLog {
  /** 항상 출력(경고/오류/진단). */
  log(message: string, ctx?: unknown): void;
  /** 진입·분기 로그(시간+컴포넌트+파라미터) — **디버그 모드에서만** 출력(릴리즈 no-op). logging 규약 P1. */
  debug?(message: string, ctx?: unknown): void;
}
