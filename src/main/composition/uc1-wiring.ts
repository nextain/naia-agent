import { ChatTurnHandler, type HandlerDeps } from "../app/chat-turn-handler.js";
import type { SpeechProfileRuntime } from "../app/speech-profile-runtime.js";
import { makeFakeProvider } from "../adapters/fake-provider.js";
import { makeInMemoryApproval } from "../adapters/approval.js";
import { makeStderrDiagnostic } from "../adapters/diagnostic.js";
import { makeBudgetedConversation } from "../adapters/budgeted-conversation.js";
import { makeMemorySkillsExecutor } from "../adapters/memory-skill.js";
import { makeCompositeToolExecutor } from "../adapters/composite-tool-executor.js";
import type {
  ProviderPort, ProviderResolverPort, ProcessingGuardPort, ConversationPort, CredentialPort, ApprovalPort, AgentIngressPort, AgentEgressPort, DiagnosticLog, ToolExecutorPort, PersonaSourcePort, WorkspaceContextPort,
} from "../ports/uc1.js";
import type { MemoryPort } from "../ports/memory.js";
import type { CompactionPort } from "../ports/compaction.js";
import type { ConversationLogPort } from "../ports/conversation-log.js";
import type { SurfacingPort } from "../ports/surfacing.js";
import type { AgentRequest, ProviderConfig } from "../domain/chat.js";

/** in-memory credential store. */
export function makeInMemoryCredentials(): CredentialPort {
  const store = new Map<string, { apiKey?: string; naiaKey?: string }>();
  return {
    update: (provider, secret) => { store.set(provider, secret); },
    get: (provider) => store.get(provider),
  };
}

/** UC1 brain 와이어링. provider 미주입=fake(헤드리스). io 주입 시 실 stdio ingress/egress 구독 개시. */
export function wireAgentUC1(opts?: {
  provider?: ProviderPort;
  resolver?: ProviderResolverPort; // 요청별 provider 해석(주입 시 우선). 미주입 시 고정 provider.
  processingGuard?: ProcessingGuardPort; // processing metadata가 있으면 provider 전 fail-closed gate.
  conversation?: ConversationPort;
  credentials?: CredentialPort;
  approval?: ApprovalPort;
  toolExecutor?: ToolExecutorPort; // UC5 — 미주입 = 도구 없음(UC1 순수 채팅)
  memory?: MemoryPort;             // UC-memory — 미주입 = 기존 동작(무회귀)
  surfacer?: SurfacingPort;        // #692 — 미주입 = 기존 동작
  compaction?: CompactionPort;     // UC-compaction — 미주입 = 압축 없음(무회귀, budgeted-conversation 드롭만)
  compactThresholdTokens?: number; // 압축 트리거 추정토큰 임계(미주입=기본)
  compactKeepTail?: number;        // 압축 시 원문 유지 최근 메시지 수(미주입=기본)
  compactTargetTokens?: number;    // recap 목표 토큰(미주입=기본)
  conversationLog?: ConversationLogPort; // FR-CONV.1 — 미주입 = transcript 미기록(무회귀)
  personaSource?: PersonaSourcePort; // FR-PERSONA-3 — 코어가 워크스페이스 페르소나를 스스로 조립. 미주입 = req.systemPrompt 만(무회귀)
  workspaceContext?: WorkspaceContextPort; // FR-WORKSPACE — 코어가 워크스페이스 컨텍스트(cwd+프로젝트)를 persona 뒤에 append. 미주입 = persona 만(무회귀)
  memoryTimeoutMs?: number;        // recall/save deadline override(테스트용)
  defaultConfig?: ProviderConfig;  // 기동 시 naia-settings(llm.json main) 로딩한 활성 provider(wire provider 미실 시 사용)
  ingress?: AgentIngressPort;      // 비-stdio transport(gRPC) 가 직접 주입 — transport 무지(직교). 미주입+io 시 stdio.
  egress?: AgentEgressPort;        // 동상(gRPC per-request stream 등). 미주입+io 시 stdio.
  diag?: DiagnosticLog;
  speechProfiles?: SpeechProfileRuntime; // Issue #82 — 검증된 profile-bound Q&A를 ordinary memory/save 전에 처리
}): { handler: ChatTurnHandler; setDefaultConfig: (config: ProviderConfig | undefined) => void; ingress?: AgentIngressPort; start?: () => void; drain?: () => Promise<void> } {
  // 표준 sink(docs/logging.md). 미주입=no-op write(코어 순수·무소음) — entry 가 process.stderr+debug 게이트 주입. console.* 금지.
  const diag: DiagnosticLog = opts?.diag ?? makeStderrDiagnostic();
  const approval: ApprovalPort = opts?.approval ?? makeInMemoryApproval(); // UC5 slice 2 — tier-gated 도구 승인 보류
  let toolExecutor = opts?.toolExecutor;
  if (opts?.memory) {
    const existing = toolExecutor?.specs().map((s) => s.name) ?? [];
    if (!existing.includes("skill_memory_save")) {
      const memExec = makeMemorySkillsExecutor({ memory: opts.memory });
      toolExecutor = toolExecutor ? makeCompositeToolExecutor([toolExecutor, memExec]) : memExec;
    }
  }
  const deps: HandlerDeps = {
    provider: opts?.provider ?? makeFakeProvider(),
    ...(opts?.resolver ? { resolver: opts.resolver } : {}),
    ...(opts?.processingGuard ? { processingGuard: opts.processingGuard } : {}),
    conversation: opts?.conversation ?? makeBudgetedConversation(),
    credentials: opts?.credentials ?? makeInMemoryCredentials(),
    approval,
    ...(toolExecutor ? { toolExecutor } : {}),
    ...(opts?.memory ? { memory: opts.memory } : {}),
    ...(opts?.surfacer ? { surfacer: opts.surfacer } : {}),
    ...(opts?.compaction ? { compaction: opts.compaction } : {}),
    ...(opts?.compactThresholdTokens !== undefined ? { compactThresholdTokens: opts.compactThresholdTokens } : {}),
    ...(opts?.compactKeepTail !== undefined ? { compactKeepTail: opts.compactKeepTail } : {}),
    ...(opts?.compactTargetTokens !== undefined ? { compactTargetTokens: opts.compactTargetTokens } : {}),
    ...(opts?.conversationLog ? { conversationLog: opts.conversationLog } : {}),
    ...(opts?.personaSource ? { personaSource: opts.personaSource } : {}),
    ...(opts?.workspaceContext ? { workspaceContext: opts.workspaceContext } : {}),
    ...(opts?.memoryTimeoutMs !== undefined ? { memoryTimeoutMs: opts.memoryTimeoutMs } : {}),
    ...(opts?.defaultConfig ? { defaultConfig: opts.defaultConfig } : {}),
    egress: opts?.egress ?? { emit: () => {} }, // transport=gRPC: egress 는 grpc adapter 주입(stdio 제거). 미주입=no-op(헤드리스).
    diag,
  };
  const handler = new ChatTurnHandler(deps);

  // ingress = 주입된 gRPC ingress(production) 또는 테스트가 직접 구성한 ports. 미주입 = handler 만(헤드리스).
  // 라이브 reload(R1-2): entry 가 SetWorkspace/ReloadSettings 시 naia-settings 재로딩 결과를 이걸로 swap.
  const setDefaultConfig = (config: ProviderConfig | undefined) => handler.setDefaultConfig(config);

  const ingress = opts?.ingress;
  if (!ingress) return { handler, setDefaultConfig };
  // 진행 중인 chat 턴 추적 — 종료(stdin EOF) 시 drain() 으로 in-flight save 완료를 기다린 뒤
  // memory flush/exit 해야 마지막 턴이 유실되지 않는다(라우팅은 fire-and-forget).
  const inflight = new Set<Promise<void>>();
  const route = (req: AgentRequest) => {
    // 진입 로깅(P1, debug 모드) — 수신 시각·kind·requestId. 90초 등 타이밍 규명용(agent 수신 타임라인).
    diag.debug?.("ingress route", { kind: req.kind, requestId: "requestId" in req ? req.requestId : undefined, ...(req.kind === "toolRequest" ? { toolName: req.toolName } : {}) });
    switch (req.kind) {
      case "chat": {
        const run = async () => {
          try {
            if (opts?.speechProfiles && await opts.speechProfiles.handleProfileChat(req)) return;
            await handler.onChatRequest(req);
          } finally {
            if (req.activityResume) {
              opts?.speechProfiles?.resumeAfterChat({
                sessionId: req.sessionId ?? "",
                ...req.activityResume,
              });
            }
          }
        };
        const p = run().catch((e) => diag.log("onChatRequest 처리 실패", e)).finally(() => inflight.delete(p));
        inflight.add(p);
        break;
      }
      case "cancel": handler.onCancel(req); break;
      case "approvalResponse": handler.onApprovalResponse(req); break;
      case "credsUpdate": handler.onCredsUpdate(req); break;
      case "toolRequest": handler.onToolRequest(req); break; // old-core standalone 스킬 — 즉시 error(셸 120s 행 방지)
    }
  };
  return {
    handler, setDefaultConfig, ingress,
    start: () => { ingress.onRequest(route); },
    drain: async () => { while (inflight.size) await Promise.all([...inflight]); }, // 종료 전 in-flight 턴 완료 대기(드레인 중 도착분까지)
  };
}
