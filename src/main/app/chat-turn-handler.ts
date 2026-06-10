// app — UC1 ChatTurnHandler (계약 §B.3). 포트만 사용. domain 만(wire/demux 안 봄).
// 불변식: usage=terminal 직전 1회·이후 무방출 / finish 즉시 break / catch !sawTerminal / 레지스트리 finally 해제 / emit no-throw.
import type {
  ChatRequest, CancelRequest, ApprovalResponse, CredsUpdate, ChatTurnState,
} from "../domain/chat.js";
import { mapProviderChunk } from "../domain/chat.js";
import type {
  ProviderPort, ConversationPort, CredentialPort, ApprovalPort, AgentEgressPort, DiagnosticLog,
} from "../ports/uc1.js";

interface Turn { abort: AbortController; state: ChatTurnState; }

export interface HandlerDeps {
  readonly provider: ProviderPort;
  readonly conversation: ConversationPort;
  readonly credentials: CredentialPort;
  readonly approval: ApprovalPort;
  readonly egress: AgentEgressPort;
  readonly diag: DiagnosticLog;
}

export class ChatTurnHandler {
  private readonly turns = new Map<string, Turn>();
  constructor(private readonly d: HandlerDeps) {}

  async onChatRequest(req: ChatRequest): Promise<void> {
    if (this.turns.has(req.requestId)) {
      // 중복=requestId 고유성 불변식 위반(os §B.4.1). wire error emit 금지(기존 활성턴 종료 방지) — 진단 로그만.
      this.d.diag.log("duplicate requestId — 무시", req.requestId);
      return;
    }
    const t: Turn = { abort: new AbortController(), state: "streaming" };
    this.turns.set(req.requestId, t);
    let sawTerminal = false;
    const usage = { inputTokens: 0, outputTokens: 0 };
    const emit = (e: Parameters<AgentEgressPort["emit"]>[1]) => this.d.egress.emit(req.requestId, e); // egress no-throw

    try {
      const providerConfig = {
        ...req.provider,
        ...(req.enableThinking !== undefined ? { enableThinking: req.enableThinking } : {}),
        ...(this.d.credentials.get(req.provider.provider) ?? {}),
      };
      const asm = this.d.conversation.assemble({ messages: req.messages, systemPrompt: req.systemPrompt });
      const stream = this.d.provider.chat(providerConfig, asm.messages, { systemPrompt: asm.systemPrompt, signal: t.abort.signal });
      for await (const chunk of stream) {
        if (chunk.kind === "usage") {
          usage.inputTokens += chunk.inputTokens; usage.outputTokens += chunk.outputTokens; // 누적만(emit 안 함)
        } else if (chunk.kind === "finish") {
          emit({ kind: "usage", ...usage }); emit({ kind: "finish" });
          sawTerminal = true; t.state = "finished";
          break; // finish 즉시 종료
        } else {
          emit(mapProviderChunk(chunk));
        }
      }
    } catch (err) {
      if (!sawTerminal) {
        emit({ kind: "usage", ...usage });
        emit({ kind: "error", message: errMessage(err) });
        sawTerminal = true; t.state = "errored";
      }
    } finally {
      if (!sawTerminal) { // 무-terminal EOF=조기종료
        emit({ kind: "usage", ...usage });
        emit({ kind: "error", message: "incomplete stream" });
        t.state = "errored";
      }
      this.turns.delete(req.requestId); // 예외 무관 terminal 해제 보장
    }
  }

  onApprovalResponse(req: ApprovalResponse): void {
    this.d.approval.resolve(req.requestId, req.toolCallId, req.decision); // UC1 보류 없으면 no-op
  }
  onCredsUpdate(req: CredsUpdate): void {
    this.d.credentials.update(req.provider, req.secret);
  }
  onCancel(req: CancelRequest): void {
    const t = this.turns.get(req.requestId);
    if (!t || t.state !== "streaming") return; // 없음/종결=no-op
    t.state = "cancelling";
    t.abort.abort(); // 후속 finished/errored 가 해제(비종결)
  }

  /** 관측용. */
  turnState(requestId: string): ChatTurnState | undefined { return this.turns.get(requestId)?.state; }
}

function errMessage(e: unknown): string { return e instanceof Error ? e.message : String(e); }
