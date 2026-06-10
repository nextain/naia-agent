// composition root — UC1 agent(brain) 와이어링 (계약 §B.5). 단일 root.
import { ChatTurnHandler, type HandlerDeps } from "../app/chat-turn-handler.js";
import { makeStdioIngress, makeStdioEgress, type LineIO } from "../adapters/stdio.js";
import { makeFakeProvider } from "../adapters/fake-provider.js";
import type {
  ProviderPort, ConversationPort, CredentialPort, ApprovalPort, AgentIngressPort, DiagnosticLog, ToolExecutorPort,
} from "../ports/uc1.js";
import type { AgentRequest } from "../domain/chat.js";

/** passthrough conversation(이식 시 token-budget+system-prompt 로 교체). */
const passthroughConversation: ConversationPort = {
  assemble: (req) => ({ messages: req.messages, ...(req.systemPrompt !== undefined ? { systemPrompt: req.systemPrompt } : {}) }),
};

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
  io?: LineIO;
  provider?: ProviderPort;
  conversation?: ConversationPort;
  credentials?: CredentialPort;
  approval?: ApprovalPort;
  toolExecutor?: ToolExecutorPort; // UC5 — 미주입 = 도구 없음(UC1 순수 채팅)
  diag?: DiagnosticLog;
}): { handler: ChatTurnHandler; ingress?: AgentIngressPort; start?: () => void } {
  const diag: DiagnosticLog = opts?.diag ?? { log: (m, c) => console.error("[agent-diag]", m, c ?? "") };
  const approval: ApprovalPort = opts?.approval ?? { resolve: () => {} }; // UC1 보류 없음
  const deps: HandlerDeps = {
    provider: opts?.provider ?? makeFakeProvider(),
    conversation: opts?.conversation ?? passthroughConversation,
    credentials: opts?.credentials ?? makeInMemoryCredentials(),
    approval,
    ...(opts?.toolExecutor ? { toolExecutor: opts.toolExecutor } : {}),
    egress: opts?.io ? makeStdioEgress(opts.io, (e) => diag.log("egress write 실패", e)) : { emit: () => {} },
    diag,
  };
  const handler = new ChatTurnHandler(deps);

  if (!opts?.io) return { handler };

  // 실 stdio: 단일 구독 ingress → type 별 라우팅(handler).
  const ingress = makeStdioIngress(opts.io, (line) => diag.log("미지 wire line 무시", line));
  const route = (req: AgentRequest) => {
    switch (req.kind) {
      case "chat": void handler.onChatRequest(req); break;
      case "cancel": handler.onCancel(req); break;
      case "approvalResponse": handler.onApprovalResponse(req); break;
      case "credsUpdate": handler.onCredsUpdate(req); break;
    }
  };
  return { handler, ingress, start: () => { ingress.onRequest(route); } };
}
