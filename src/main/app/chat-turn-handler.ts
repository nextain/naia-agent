// app — UC1 ChatTurnHandler + UC5 도구 실행 루프 (계약 §B.3 + UC5-agent-tool-loop §B.3). 포트만 사용. domain 만.
// 불변식: usage=terminal 직전 1회(라운드 스냅샷 합)·이후 무방출 / finish XOR error(terminal 래치) / 레지스트리 finally 해제 / emit no-throw.
import type {
  ChatRequest, CancelRequest, ApprovalResponse, CredsUpdate, ChatTurnState, ChatMessage, ToolCall, ProviderConfig,
} from "../domain/chat.js";
import { mapProviderChunk, threadToolRound } from "../domain/chat.js";
import { calculateCost } from "../domain/cost.js";
import type {
  ProviderPort, ProviderResolverPort, ConversationPort, CredentialPort, ApprovalPort, AgentEgressPort, DiagnosticLog, ToolExecutorPort, ProviderChatOpts,
} from "../ports/uc1.js";
import type { MemoryPort } from "../ports/memory.js";
import { formatRecalledMemory } from "../domain/memory.js";

interface Turn { abort: AbortController; state: ChatTurnState; }

const MAX_TOOL_ROUNDS = 8; // 허용 도구라운드 최대치(round 단위). cap-th 결과로 provider 1회 재호출 허용, 그게 또 도구면 error.
const TOOL_EXEC_TIMEOUT_MS = 60_000; // per-tool 실행 deadline(UC5 리뷰): hung MCP/HTTP 도구가 turn 무한 hang 방지. 초과=isError(LLM 복구).
const MEM_RECALL_TIMEOUT_MS = 5000; // recall bound — 무응답 시 주입 생략하고 턴 진행(terminal 항상 방출).
const MEM_SAVE_TIMEOUT_MS = 5000;   // save bound — 무응답 시 finish/drain 영구정지 방지(timeout→로그 후 finish).

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
  /** 고정 provider(fallback/테스트). 라이브는 resolver 가 요청별 해석(우선). */
  readonly provider: ProviderPort;
  /** 요청별 provider 해석(config 기반 라우팅). 주입 시 runRound 가 resolver.resolve(cfg) 사용. */
  readonly resolver?: ProviderResolverPort;
  readonly conversation: ConversationPort;
  readonly credentials: CredentialPort;
  readonly approval: ApprovalPort;
  readonly egress: AgentEgressPort;
  readonly diag: DiagnosticLog;
  /** 기동 시 naia-settings(llm.json main role) 로딩한 활성 provider. wire chat_request 가 provider 를
   *  안 실으면 이걸 사용(정본: "대화는 메시지만"). req.provider 있으면 그 요청만 오버라이드(하위호환). */
  readonly defaultConfig?: ProviderConfig;
  readonly toolExecutor?: ToolExecutorPort;                       // UC5 — 미주입 = 도구 없음(UC1 순수 채팅 회귀 없음)
  readonly memory?: MemoryPort;                                   // UC-memory — 미주입 = 기존 동작(무회귀). 턴 전 recall 주입 / 턴 후 save.
  readonly memoryTimeoutMs?: number;                              // recall/save deadline override(테스트용; 미주입=기본 5000ms).
  readonly toolTimeoutMs?: number;                                // per-tool 실행 deadline override(테스트용; 미주입=60000ms).
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
    // config 정본: wire provider override > 기동 시 naia-settings 로딩한 defaultConfig(정본 "대화는 메시지만").
    const activeConfig = req.provider ?? this.d.defaultConfig;
    const costModel = activeConfig?.model ?? ""; // 미설정 = calculateCost("") = 0(크래시 아님)
    // terminal 래치(usage 중복 emit 원천 차단 — 두 종결 모두 이 헬퍼만 사용).
    const terminalFinish = () => { if (!sawTerminal) { emit({ kind: "usage", ...totalUsage, cost: calculateCost(costModel, totalUsage.inputTokens, totalUsage.outputTokens), model: costModel }); emit({ kind: "finish" }); sawTerminal = true; t.state = "finished"; } };
    const terminalError = (message: string) => { if (!sawTerminal) { emit({ kind: "usage", ...totalUsage, cost: calculateCost(costModel, totalUsage.inputTokens, totalUsage.outputTokens), model: costModel }); emit({ kind: "error", message }); sawTerminal = true; t.state = "errored"; } };

    try {
      if (!activeConfig) { terminalError("no provider configured — naia-settings/llm.json 도 wire provider 도 없음"); return; }
      const providerConfig: ProviderConfig = {
        ...activeConfig,
        ...(req.enableThinking !== undefined ? { enableThinking: req.enableThinking } : {}),
        ...(this.d.credentials.get(activeConfig.provider) ?? {}),
      };
      const asm = this.d.conversation.assemble({ messages: req.messages, systemPrompt: req.systemPrompt });
      // UC-memory FR-MEM-1: 턴 전 recall → systemPrompt 주입(회상 있으면). 기준 = *이 턴의 새 user
      // 입력* = 메시지 배열의 마지막 메시지가 user 일 때 그것. ⚠️ "마지막 user 를 전체에서 탐색"이 아니라
      // 마지막 메시지여야 한다 — assistant continuation/regenerate(마지막이 assistant) 요청에서 과거
      // user 발화를 query·save 대상으로 재사용하는 오류를 막기 위함. 마지막이 user 가 아니면 이 턴엔 새
      // 입력이 없으므로 recall/save 생략. content="" 도 정상 입력(빈 문자열 truthiness 로 건너뛰지 않음).
      const lastMsg = req.messages.length ? req.messages[req.messages.length - 1] : undefined;
      const currentUserMsg = lastMsg?.role === "user" ? lastMsg : undefined;
      const lastUserText = currentUserMsg?.content ?? "";
      let memSystemPrompt = asm.systemPrompt;
      // FR-MEM-1a: 빈/공백 query 는 app 계층에서 단락(recall 미호출) — 빈 query 가 전체/임의 top-K 를
      // 끌어와 무관 정보를 주입하는 것을 *어댑터 구현과 무관하게* 막는다(정책은 app 소유). 어댑터에도
      // 동일 가드(방어 심층).
      if (this.d.memory && currentUserMsg && lastUserText.trim()) {
        try {
          // recall 을 abort + deadline 과 race — recall 이 멈춰도(취소 또는 무응답) 즉시 풀려 (a) 가드/턴이
          // 진행돼 terminal 이 항상 방출된다. abort/timeout → recalled=null=주입 생략(턴은 채팅 우선 진행).
          const mem = await raceAbort(this.d.memory.recall(lastUserText), signal, this.d.memoryTimeoutMs ?? MEM_RECALL_TIMEOUT_MS);
          // 프레이밍·예산 절단은 domain formatter 가 강제(adapter 무관 — FR-MEM-7/8 보장).
          const recalled = mem ? formatRecalledMemory(mem) : "";
          if (recalled) memSystemPrompt = asm.systemPrompt ? `${asm.systemPrompt}\n\n${recalled}` : recalled;
        } catch (e) { this.safeDiag("memory recall 실패(턴 유지)", e); }
      }
      const exec = this.d.toolExecutor;
      // UC5 리뷰 fix: enableTools=false → 도구 미제공(순수 챗), disabledSkills 필터(wire 필드 소비, old 충실).
      const allSpecs = exec?.specs() ?? [];
      const tools = req.enableTools === false ? [] : allSpecs.filter((s) => !(req.disabledSkills ?? []).includes(s.name));
      let messages: readonly ChatMessage[] = asm.messages;
      let toolRounds = 0;
      const usedCids = new Set<string>(); // turn-unique correlation id (D-I7)
      // tier 조회: name 매치 중 gated(none 아님) 있으면 그 tier(승인필요), 없으면 "none". 미등록=none. (중복 매치=보수적 gated 우선)
      const tierOf = (name: string): string => {
        const gated = tools.find((s) => s.name === name && s.tier !== undefined && s.tier !== "none");
        return gated?.tier ?? "none";
      };
      // cid: call.id 가 used 면 round 접미사, 그것도 used 면 counter — unused 까지 반복(loop-until-unused, §D).
      const turnCid = (id: string): string => {
        if (!usedCids.has(id)) { usedCids.add(id); return id; }
        let cand = `${id}#r${toolRounds}`; let n = 2;
        while (usedCids.has(cand)) cand = `${id}#r${toolRounds}_${n++}`;
        usedCids.add(cand); return cand;
      };

      const assistantTurnParts: string[] = []; // 턴 전체 assistant 텍스트 누적(도구 라운드 preamble 포함) — save 용
      for (;;) {
        if (sawTerminal) break;
        if (signal.aborted) { terminalError("cancelled"); break; }                 // (a) provider 호출 전 가드
        const round = await this.runRound(providerConfig, messages, memSystemPrompt, tools, signal, emit);
        if (round.usage) { totalUsage.inputTokens += round.usage.inputTokens; totalUsage.outputTokens += round.usage.outputTokens; } // 라운드 스냅샷 1회 합산
        if (round.aborted) { terminalError("cancelled"); break; }
        if (round.rejected !== undefined) { terminalError(`provider error: ${round.rejected}`); break; }
        if (!round.finished) { terminalError("incomplete stream"); break; }         // finish 없는 EOF = provider error(UC1 계승)
        if (signal.aborted) { terminalError("cancelled"); break; }                  // (b) provider loop 종료 직후 가드(finish 직후 취소 시 finish/cap-error 선방출 차단)
        if (round.text) assistantTurnParts.push(round.text);                        // 이 라운드 assistant 텍스트 누적(도구 라운드 preamble 도 보존)
        if (round.calls.length === 0) {                                             // 최종 응답
          // UC-memory FR-MEM-2: provider 가 최종 응답을 낸 시점 = **커밋 지점**. 여기서 save → finish.
          // 취소 의미 불변식: 취소는 커밋 지점 *전*((b) 가드)까지만 인정 — provider 가 최종 답을 낸 뒤
          // save 중 도착한 취소는 무시하고 턴을 finish 한다(저장됐는데 wire 는 cancelled 인 모순 방지:
          // "저장된 턴 = finish 된 턴"). assistant 텍스트는 *턴 전체*(도구 라운드 preamble 포함) 누적분.
          // ⚠️ finish emit *전*에 save await — 클라이언트가 finish 즉시 다음 턴을 보내면 그 recall 이 이
          // save 보다 먼저 돌아 저장 전 상태를 회상하는 레이스가 생긴다(save→finish→다음 recall 순서 보장).
          // save 는 deadline 으로 bound — 무응답이어도 finish/drain 이 영구 정지하지 않음(timeout→로그 후 진행).
          // save 실패/timeout=진단 로그, 턴 유지(FR-MEM-3). save 무방출이라 usage/finish 불변식 무영향.
          if (this.d.memory && currentUserMsg) {
            try {
              const saveTimeoutMs = this.d.memoryTimeoutMs ?? MEM_SAVE_TIMEOUT_MS;
              const ok = await raceTimeout(this.d.memory.save(lastUserText, assistantTurnParts.join("\n")), saveTimeoutMs);
              if (!ok) this.safeDiag("memory save 시간초과(턴 유지)", new Error(`>${saveTimeoutMs}ms`));
            } catch (e) { this.safeDiag("memory save 실패(턴 유지)", e); }
          }
          terminalFinish();
          break;
        }
        if (toolRounds >= MAX_TOOL_ROUNDS) { terminalError("tool loop limit exceeded"); break; } // cap-th 실행 후 재호출이 또 도구 → error(usage 1회, toolUse 미emit=orphan 없음)
        toolRounds++;
        const results: { output: string; isError?: boolean }[] = [];
        const threadedCalls: ToolCall[] = []; // cid 로 묶은 calls(threadToolRound·LLM correlation 일관)
        let cancelled = false;
        for (const call of round.calls) {                                           // cap 통과 — 이제 toolUse emit 안전
          if (signal.aborted) { terminalError("cancelled"); cancelled = true; break; } // (c) 매 call 전 가드(아직 미emit → orphan 없음)
          const cid = turnCid(call.id);                                             // turn-unique correlation id(D-I7)
          threadedCalls.push({ id: cid, name: call.name, args: call.args });
          emit({ kind: "toolUse", toolCallId: cid, toolName: call.name, args: call.args }); // emit(cid) — toolResult 와 쌍(I6)
          const tier = tierOf(call.name);
          if (tier !== "none") {                                                    // 승인 게이트(slice 2)
            if (signal.aborted) { terminalError("cancelled"); cancelled = true; break; } // (e) prepare 전 가드
            const { promise, dispose } = this.d.approval.prepareDecision(req.requestId, cid, { signal }); // 등록 먼저
            void promise.catch(() => {});                                           // early-stop 경로 unhandled rejection 방지
            if (signal.aborted) { dispose(); terminalError("cancelled"); cancelled = true; break; } // (e2) prepare 직후·emit 전
            let decision: "approve" | "reject" = "reject";
            // ⚠️ emit·await 를 한 try/finally 로 — emit 이 throw 해도 dispose 항상 호출(보류·listener 누수 방지).
            try {
              emit({ kind: "approvalRequest", toolCallId: cid, toolName: call.name, tier }); // 등록 후 emit(fast resolve 안전)
              decision = await promise;
            } catch { decision = "reject"; } finally { dispose(); } // abort→catch→(f) cancelled; 비-abort reject=거부
            if (signal.aborted) { terminalError("cancelled"); cancelled = true; break; } // (f) await 후 가드
            if (decision === "reject") {
              const out = "도구 호출이 거부되었습니다";
              emit({ kind: "toolResult", toolCallId: cid, output: out });           // 거부도 toolResult 쌍(I6)
              results.push({ output: out, isError: true });
              continue;                                                             // 실행 안 함 — 다음 call
            }
          }
          // approve 또는 비-gated → 실행:
          let r: { output: string; isError?: boolean };
          try {
            if (exec) {
              // UC5 리뷰 fix(liveness): per-tool deadline race(memory 와 동일). 무응답 도구가 turn 영구 hang 못 하게.
              const res = await raceAbort(exec.execute({ ...call, id: cid }, { signal }), signal, this.d.toolTimeoutMs ?? TOOL_EXEC_TIMEOUT_MS);
              if (res === null) {
                if (signal.aborted) { terminalError("cancelled"); cancelled = true; break; }
                r = { output: `tool timeout (>${this.d.toolTimeoutMs ?? TOOL_EXEC_TIMEOUT_MS}ms)`, isError: true }; // 무응답=isError, LLM 복구 가능, turn 진행
              } else {
                r = res;
              }
            } else {
              r = { output: "no tool executor available", isError: true }; // cid 일관(executor 가 id 로 correlate 해도 turn-unique)
            }
          } catch (e) {
            if (signal.aborted) { terminalError("cancelled"); cancelled = true; break; } // execute reject + abort = cancelled
            r = { output: errMessage(e), isError: true };                            // 비-abort reject = isError(루프 안정)
          }
          if (signal.aborted) { terminalError("cancelled"); cancelled = true; break; } // (d) execute 직후 가드
          emit({ kind: "toolResult", toolCallId: cid, output: r.output });           // toolUse 와 쌍(cid)
          results.push(r);
        }
        if (cancelled || sawTerminal) break;
        messages = threadToolRound(messages, round.text, threadedCalls, results);    // assistant(text+cid calls) + tool 메시지들 → 다음 라운드
      }
    } catch (err) {
      // 루프 밖 예기치 못한 throw(포트 계약 위반 등). abort 면 cancelled.
      terminalError(signal.aborted ? "cancelled" : errMessage(err));
    } finally {
      if (!sawTerminal) terminalError(signal.aborted ? "cancelled" : "incomplete stream"); // 무-terminal 안전망
      this.turns.delete(req.requestId);                                             // 예외 무관 terminal 해제 보장
    }
  }

  /** 메모리 실패 진단 로그 — 로거 자체가 throw 해도 흡수(FR-MEM-3: 메모리 실패가 턴을 깨지 않음). */
  private safeDiag(message: string, e: unknown): void {
    try { this.d.diag.log(message, errMessage(e)); } catch { /* 로거 throw 흡수 — 턴 유지 */ }
  }

  /**
   * 한 provider 호출(라운드) 구동 — 수동 iterator + abort race(R5/R6/R8/R9 계승). text/thinking 즉시 emit,
   * toolUse 는 *버퍼링*(emit 안 함 — onChatRequest 가 cap 통과 후 emit), usage 마지막 스냅샷 채택, finish 종료자.
   */
  private async runRound(
    cfg: ProviderConfig, messages: readonly ChatMessage[], systemPrompt: string | undefined,
    tools: ProviderChatOpts["tools"], signal: AbortSignal, emit: (e: Parameters<AgentEgressPort["emit"]>[1]) => void,
  ): Promise<RoundResult> {
    // 요청별 provider 해석(resolver 주입 시) — config(provider/model/naiaKey)로 라우팅. 미주입=고정 provider(fallback/테스트).
    const provider = this.d.resolver ? this.d.resolver.resolve(cfg) : this.d.provider;
    const stream = provider.chat(cfg, messages, { ...(systemPrompt !== undefined ? { systemPrompt } : {}), signal, ...(tools && tools.length ? { tools } : {}) });
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
  /** standalone tool_request(old-core 스킬 직접 호출) — new-core 미지원. 즉시 error 응답(셸 directToolCall 120s 행 방지).
   *  셸은 reject→catch(warn)로 우아하게 처리. (도구 실행은 chat_request 의 LLM 도구루프로만 — UC5.) */
  onToolRequest(req: { requestId: string; toolName: string }): void {
    this.d.egress.emit(req.requestId, { kind: "error", message: `tool '${req.toolName}' 는 new-core agent 미지원(chat 도구루프로만 실행)` });
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

/** p 를 abort + deadline 과 race. abort 또는 timeout 이 먼저면 null(p 는 dangling — void-catch 로
 *  unhandled rejection 방지). p 가 먼저 resolve→값 / reject→전파(호출부 catch 로 진단). 어느 경로든
 *  listener·timer 정리(잔존 방지). recall 이 무응답이어도 deadline 으로 풀려 턴이 진행된다. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T | null> {
  void p.catch(() => {});                                                            // race 패배 시 p reject 흡수
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    let done = false;
    const onAbort = () => settle(() => resolve(null));
    // ⚠️ unref 금지 — drain 이 hang 중인 recall 만 기다릴 때 이 timer 가 이벤트 루프를 살려 deadline 이
    // 실제로 발화하게 한다(unref 하면 프로세스가 timeout 전 종료 → terminal/close 누락). settle 시 clear.
    const timer = setTimeout(() => settle(() => resolve(null)), timeoutMs);
    const cleanup = () => { signal.removeEventListener("abort", onAbort); clearTimeout(timer); };
    const settle = (act: () => void) => { if (!done) { done = true; cleanup(); act(); } };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => settle(() => resolve(v)), (e) => settle(() => reject(e)));
  });
}

/** p 를 deadline 과 race. 완료=true, timeout=false. p reject 는 전파(호출부 catch). save 를 bound 해
 *  무응답 save 가 finish/drain 을 영구 정지시키지 못하게. p 는 dangling 가능(void-catch). */
function raceTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<boolean> {
  void p.catch(() => {});
  return new Promise<boolean>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(false); } }, timeoutMs); // unref 금지(위 raceAbort 와 동일 이유 — drain 중 발화 보장)
    p.then(
      () => { if (!done) { done = true; clearTimeout(timer); resolve(true); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } },
    );
  });
}
