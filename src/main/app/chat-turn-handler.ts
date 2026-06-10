// app — UC1 ChatTurnHandler + UC5 도구 실행 루프 (계약 §B.3 + UC5-agent-tool-loop §B.3). 포트만 사용. domain 만.
// 불변식: usage=terminal 직전 1회(라운드 스냅샷 합)·이후 무방출 / finish XOR error(terminal 래치) / 레지스트리 finally 해제 / emit no-throw.
import type {
  ChatRequest, CancelRequest, ApprovalResponse, CredsUpdate, ChatTurnState, ChatMessage, ToolCall, ProviderConfig,
} from "../domain/chat.js";
import { mapProviderChunk, threadToolRound } from "../domain/chat.js";
import type {
  ProviderPort, ConversationPort, CredentialPort, ApprovalPort, AgentEgressPort, DiagnosticLog, ToolExecutorPort, ProviderChatOpts,
} from "../ports/uc1.js";

interface Turn { abort: AbortController; state: ChatTurnState; }

const MAX_TOOL_ROUNDS = 8; // 허용 도구라운드 최대치(round 단위). cap-th 결과로 provider 1회 재호출 허용, 그게 또 도구면 error.

/** 한 provider 호출(라운드)의 결과 — runRound 가 반환, onChatRequest 루프가 해석. */
interface RoundResult {
  readonly text: string;                                          // 이 라운드 누적 텍스트(thinking 제외) — history threading 용
  readonly calls: readonly ToolCall[];                            // 버퍼링된 toolUse(아직 emit 안 함)
  readonly usage: { inputTokens: number; outputTokens: number } | null; // 라운드 스냅샷(마지막 채택)
  readonly finished: boolean;                                     // finish chunk 수신
  readonly aborted: boolean;                                      // abort race 승 또는 abort 중 rejection
  readonly rejected?: string;                                     // provider rejection(abort 아님) 메시지
}

export interface HandlerDeps {
  readonly provider: ProviderPort;
  readonly conversation: ConversationPort;
  readonly credentials: CredentialPort;
  readonly approval: ApprovalPort;
  readonly egress: AgentEgressPort;
  readonly diag: DiagnosticLog;
  readonly toolExecutor?: ToolExecutorPort;                       // UC5 — 미주입 = 도구 없음(UC1 순수 채팅 회귀 없음)
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
    const signal = t.abort.signal;
    let sawTerminal = false;
    const totalUsage = { inputTokens: 0, outputTokens: 0 };
    const emit = (e: Parameters<AgentEgressPort["emit"]>[1]) => this.d.egress.emit(req.requestId, e); // egress no-throw
    // terminal 래치(usage 중복 emit 원천 차단 — 두 종결 모두 이 헬퍼만 사용).
    const terminalFinish = () => { if (!sawTerminal) { emit({ kind: "usage", ...totalUsage }); emit({ kind: "finish" }); sawTerminal = true; t.state = "finished"; } };
    const terminalError = (message: string) => { if (!sawTerminal) { emit({ kind: "usage", ...totalUsage }); emit({ kind: "error", message }); sawTerminal = true; t.state = "errored"; } };

    try {
      const providerConfig: ProviderConfig = {
        ...req.provider,
        ...(req.enableThinking !== undefined ? { enableThinking: req.enableThinking } : {}),
        ...(this.d.credentials.get(req.provider.provider) ?? {}),
      };
      const asm = this.d.conversation.assemble({ messages: req.messages, systemPrompt: req.systemPrompt });
      const exec = this.d.toolExecutor;
      const tools = exec?.specs() ?? [];
      let messages: readonly ChatMessage[] = asm.messages;
      let toolRounds = 0;

      for (;;) {
        if (sawTerminal) break;
        if (signal.aborted) { terminalError("cancelled"); break; }                 // (a) provider 호출 전 가드
        const round = await this.runRound(providerConfig, messages, asm.systemPrompt, tools, signal, emit);
        if (round.usage) { totalUsage.inputTokens += round.usage.inputTokens; totalUsage.outputTokens += round.usage.outputTokens; } // 라운드 스냅샷 1회 합산
        if (round.aborted) { terminalError("cancelled"); break; }
        if (round.rejected !== undefined) { terminalError(`provider error: ${round.rejected}`); break; }
        if (!round.finished) { terminalError("incomplete stream"); break; }         // finish 없는 EOF = provider error(UC1 계승)
        if (signal.aborted) { terminalError("cancelled"); break; }                  // (b) provider loop 종료 직후 가드(finish 직후 취소 시 finish/cap-error 선방출 차단)
        if (round.calls.length === 0) { terminalFinish(); break; }                  // 최종 응답
        if (toolRounds >= MAX_TOOL_ROUNDS) { terminalError("tool loop limit exceeded"); break; } // cap-th 실행 후 재호출이 또 도구 → error(usage 1회, toolUse 미emit=orphan 없음)
        toolRounds++;
        const results: { output: string; isError?: boolean }[] = [];
        let cancelled = false;
        for (const call of round.calls) {                                           // cap 통과 — 이제 toolUse emit 안전
          if (signal.aborted) { terminalError("cancelled"); cancelled = true; break; } // (c) 매 execute 전 가드(아직 미emit → orphan 없음)
          emit({ kind: "toolUse", toolCallId: call.id, toolName: call.name, args: call.args }); // 실행 직전 emit — toolResult 와 쌍(I6)
          let r: { output: string; isError?: boolean };
          try {
            r = exec ? await exec.execute(call, { signal }) : { output: "no tool executor available", isError: true };
          } catch (e) {
            if (signal.aborted) { terminalError("cancelled"); cancelled = true; break; } // execute reject + abort = cancelled
            r = { output: errMessage(e), isError: true };                            // 비-abort reject = isError(루프 안정, no-throw 계약 위반 provider 방어)
          }
          if (signal.aborted) { terminalError("cancelled"); cancelled = true; break; } // (d) execute 직후 가드(toolResult 방출 금지)
          emit({ kind: "toolResult", toolCallId: call.id, output: r.output });        // toolUse 와 쌍
          results.push(r);
        }
        if (cancelled || sawTerminal) break;
        messages = threadToolRound(messages, round.text, round.calls, results);      // assistant(text+calls) + tool 메시지들 → 다음 라운드
      }
    } catch (err) {
      // 루프 밖 예기치 못한 throw(포트 계약 위반 등). abort 면 cancelled.
      terminalError(signal.aborted ? "cancelled" : errMessage(err));
    } finally {
      if (!sawTerminal) terminalError(signal.aborted ? "cancelled" : "incomplete stream"); // 무-terminal 안전망
      this.turns.delete(req.requestId);                                             // 예외 무관 terminal 해제 보장
    }
  }

  /**
   * 한 provider 호출(라운드) 구동 — 수동 iterator + abort race(R5/R6/R8/R9 계승). text/thinking 즉시 emit,
   * toolUse 는 *버퍼링*(emit 안 함 — onChatRequest 가 cap 통과 후 emit), usage 마지막 스냅샷 채택, finish 종료자.
   */
  private async runRound(
    cfg: ProviderConfig, messages: readonly ChatMessage[], systemPrompt: string | undefined,
    tools: ProviderChatOpts["tools"], signal: AbortSignal, emit: (e: Parameters<AgentEgressPort["emit"]>[1]) => void,
  ): Promise<RoundResult> {
    const stream = this.d.provider.chat(cfg, messages, { ...(systemPrompt !== undefined ? { systemPrompt } : {}), signal, ...(tools && tools.length ? { tools } : {}) });
    const it = stream[Symbol.asyncIterator]();
    const closeIt = () => { try { void Promise.resolve(it.return?.()).catch(() => {}); } catch { /* return() 동기 throw 격리(R9) */ } };
    const ABORTED = Symbol("aborted");
    const abortP: Promise<typeof ABORTED> = new Promise((res) => {
      if (signal.aborted) res(ABORTED);
      else signal.addEventListener("abort", () => res(ABORTED), { once: true });
    });
    let text = ""; const calls: ToolCall[] = []; let usage: RoundResult["usage"] = null; let finished = false;
    try {
      for (;;) {
        const r = await Promise.race([it.next(), abortP]);
        if (r === ABORTED) { closeIt(); return { text, calls, usage, finished: false, aborted: true }; } // abort 승(R6/R8). await 안 함=return hang 대비
        if (r.done) break;                                                          // finish 없는 EOF(소진=close 불요)
        const chunk = r.value;
        if (chunk.kind === "usage") { usage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens }; } // 마지막 스냅샷 채택(델타 아님)
        else if (chunk.kind === "finish") { finished = true; closeIt(); break; }     // 라운드 종료자=finish 1회; 이후 chunk 무시
        else if (chunk.kind === "toolUse") { calls.push({ id: chunk.id, name: chunk.name, args: chunk.args }); } // ⚠️ 버퍼링(emit 보류)
        else if (chunk.kind === "text") { text += chunk.text; emit(mapProviderChunk(chunk)); } // 즉시 표시 + history 누적
        else { emit(mapProviderChunk(chunk)); }                                      // thinking — 즉시 표시(history 누적 안 함)
      }
    } catch (err) {
      closeIt();
      if (signal.aborted) return { text, calls, usage, finished: false, aborted: true };
      return { text, calls, usage, finished: false, aborted: false, rejected: errMessage(err) };
    }
    return { text, calls, usage, finished, aborted: false };
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
