// composition root — UC1 agent(brain) 와이어링 (계약 §B.5). 단일 root.
import { ChatTurnHandler, type HandlerDeps } from "../app/chat-turn-handler.js";
import { makeFakeProvider } from "../adapters/fake-provider.js";
import { makeInMemoryApproval } from "../adapters/approval.js";
import { makeStderrDiagnostic } from "../adapters/diagnostic.js";
import { makeBudgetedConversation } from "../adapters/budgeted-conversation.js";
import type {
  ProviderPort, ProviderResolverPort, ConversationPort, CredentialPort, ApprovalPort, AgentIngressPort, AgentEgressPort, DiagnosticLog, ToolExecutorPort,
} from "../ports/uc1.js";
import type { MemoryPort } from "../ports/memory.js";
import type { ConversationLogPort } from "../ports/conversation-log.js";
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
  conversation?: ConversationPort;
  credentials?: CredentialPort;
  approval?: ApprovalPort;
  toolExecutor?: ToolExecutorPort; // UC5 — 미주입 = 도구 없음(UC1 순수 채팅)
  memory?: MemoryPort;             // UC-memory — 미주입 = 기존 동작(무회귀)
  conversationLog?: ConversationLogPort; // FR-CONV.1 — 미주입 = transcript 미기록(무회귀)
  memoryTimeoutMs?: number;        // recall/save deadline override(테스트용)
  defaultConfig?: ProviderConfig;  // 기동 시 naia-settings(llm.json main) 로딩한 활성 provider(wire provider 미실 시 사용)
  ingress?: AgentIngressPort;      // 비-stdio transport(gRPC) 가 직접 주입 — transport 무지(직교). 미주입+io 시 stdio.
  egress?: AgentEgressPort;        // 동상(gRPC per-request stream 등). 미주입+io 시 stdio.
  diag?: DiagnosticLog;
}): { handler: ChatTurnHandler; setDefaultConfig: (config: ProviderConfig | undefined) => void; ingress?: AgentIngressPort; start?: () => void; drain?: () => Promise<void> } {
  // 표준 sink(docs/logging.md). 미주입=no-op write(코어 순수·무소음) — entry 가 process.stderr+debug 게이트 주입. console.* 금지.
  const diag: DiagnosticLog = opts?.diag ?? makeStderrDiagnostic();
  const approval: ApprovalPort = opts?.approval ?? makeInMemoryApproval(); // UC5 slice 2 — tier-gated 도구 승인 보류
  const deps: HandlerDeps = {
    provider: opts?.provider ?? makeFakeProvider(),
    ...(opts?.resolver ? { resolver: opts.resolver } : {}),
    conversation: opts?.conversation ?? makeBudgetedConversation(),
    credentials: opts?.credentials ?? makeInMemoryCredentials(),
    approval,
    ...(opts?.toolExecutor ? { toolExecutor: opts.toolExecutor } : {}),
    ...(opts?.memory ? { memory: opts.memory } : {}),
    ...(opts?.conversationLog ? { conversationLog: opts.conversationLog } : {}),
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
        const p = handler.onChatRequest(req).catch((e) => diag.log("onChatRequest 처리 실패", e)).finally(() => inflight.delete(p));
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
