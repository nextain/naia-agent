// app — UC1 ChatTurnHandler + UC5 도구 실행 루프 (계약 §B.3 + UC5-agent-tool-loop §B.3). 포트만 사용. domain 만.
// 불변식: usage=terminal 직전 1회(라운드 스냅샷 합)·이후 무방출 / finish XOR error(terminal 래치) / 레지스트리 finally 해제 / emit no-throw.
import type {
  ChatRequest, CancelRequest, ApprovalResponse, CredsUpdate, ChatTurnState, ChatMessage, ToolCall, ProviderConfig,
} from "../domain/chat.js";
import { mapProviderChunk, threadToolRound, estimateMessageTokens } from "../domain/chat.js";
import { calculateCost } from "../domain/cost.js";
import type {
  ProviderPort, ProviderResolverPort, ConversationPort, CredentialPort, ApprovalPort, AgentEgressPort, DiagnosticLog, ToolExecutorPort, ProviderChatOpts, PersonaSourcePort, WorkspaceContextPort,
} from "../ports/uc1.js";
import type { MemoryPort } from "../ports/memory.js";
import type { CompactionPort } from "../ports/compaction.js";
import type { ConversationLogPort } from "../ports/conversation-log.js";
import { formatRecalledMemory } from "../domain/memory.js";
import { composePersonaPrompt } from "../domain/persona.js";
import { composeWorkspaceContext } from "../domain/workspace-context.js";
import { renderEnvironmentSegments } from "../domain/environment-segments.js";

interface Turn { abort: AbortController; state: ChatTurnState; }

const MAX_TOOL_ROUNDS = 8; // 허용 도구라운드 최대치(round 단위). cap-th 결과로 provider 1회 재호출 허용, 그게 또 도구면 error.
const TOOL_EXEC_TIMEOUT_MS = 60_000; // per-tool 실행 deadline(UC5 리뷰): hung MCP/HTTP 도구가 turn 무한 hang 방지. 초과=isError(LLM 복구).
const MEM_RECALL_TIMEOUT_MS = 5000; // recall bound — 무응답 시 주입 생략하고 턴 진행(terminal 항상 방출).
const MEM_SAVE_TIMEOUT_MS = 5000;   // save bound — 무응답 시 finish/drain 영구정지 방지(timeout→로그 후 finish).
// UC-compaction(FR-COMPACT) 기본값 — compaction 포트 주입 시에만 동작(미주입=압축 없음).
const DEFAULT_COMPACT_THRESHOLD_TOKENS = 4000; // 추정 토큰 이 임계 초과 시 head 요약 시도.
const DEFAULT_COMPACT_KEEP_TAIL = 6;           // 압축 시 원문 유지할 최근 메시지 수.
const DEFAULT_COMPACT_TARGET_TOKENS = 1000;    // recap 목표 토큰(요약 예산).

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
  readonly compaction?: CompactionPort;                           // UC-compaction — 미주입 = 압축 없음(무회귀, budgeted-conversation 드롭만). 예산 압박 시 head 요약→systemPrompt 주입 + 영속.
  readonly compactThresholdTokens?: number;                       // 압축 트리거 추정토큰 임계(미주입=기본 4000).
  readonly compactKeepTail?: number;                              // 압축 시 원문 유지 최근 메시지 수(미주입=기본 6).
  readonly compactTargetTokens?: number;                          // recap 목표 토큰(미주입=기본 1000).
  readonly memoryTimeoutMs?: number;                              // recall/save/compact deadline override(테스트용; 미주입=기본 5000ms).
  readonly toolTimeoutMs?: number;                                // per-tool 실행 deadline override(테스트용; 미주입=60000ms).
  readonly conversationLog?: ConversationLogPort;                 // FR-CONV.1 — turn 후 verbatim transcript append(전두엽 기록). 미주입=미기록(무회귀).
  readonly personaSource?: PersonaSourcePort;                     // FR-PERSONA-3 — 코어가 워크스페이스 페르소나를 *스스로* 조립(클라가 안 보냄). req.systemPrompt 는 override. 미주입=기존 동작(req.systemPrompt 만, 무회귀).
  readonly workspaceContext?: WorkspaceContextPort;               // FR-WORKSPACE — 코어가 워크스페이스 컨텍스트(cwd+프로젝트 이름)를 *스스로* 조립해 persona 뒤에 append(경량 shallow). 미주입=기존 동작(persona 만, 무회귀). req.systemPrompt override 시 둘 다 무시.
}

export class ChatTurnHandler {
  private readonly turns = new Map<string, Turn>();
  /** 활성 defaultConfig — 라이브 reload 가능. 초기값=주입 defaultConfig. 정본(R1-2 "startup-only 금지"):
   *  사용자가 모델 교체 시 OS가 naia-settings 갱신 후 ReloadSettings/SetWorkspace 재호출 → entry 가 setDefaultConfig 로 swap. */
  private activeDefaultConfig?: ProviderConfig;
  constructor(private readonly d: HandlerDeps) { this.activeDefaultConfig = d.defaultConfig; }

  /** 라이브 설정 reload — naia-settings 재로딩 결과(또는 undefined=설정 없음)를 활성 config 로 swap.
   *  wire chat_request 가 provider override 를 안 실으면(gRPC 정본) 다음 턴부터 이 값을 쓴다. */
  setDefaultConfig(config: ProviderConfig | undefined): void { this.activeDefaultConfig = config; }

  /** UC-compaction(FR-COMPACT): 예산 압박 시 head 를 memory.compact() 로 *요약*(정보보존). 반환 =
   *  {messages: 압축 후(tail) 또는 원본, recap: 요약 텍스트(systemPrompt 주입용; ""=압축 안 함)}.
   *  미주입/임계이하/압축실패 = 원본 그대로(드롭형 budgeted-conversation 이 최종 하드 가드). compact/attachHandoff
   *  실패는 격리 — 압축은 turn 을 깨지 않는다(요약 실패 < 대화 중단). */
  private async maybeCompact(req: ChatRequest, signal: AbortSignal): Promise<{ messages: readonly ChatMessage[]; recap: string; droppedCount: number }> {
    const compaction = this.d.compaction;
    if (!compaction) return { messages: req.messages, recap: "", droppedCount: 0 };
    const est = estimateMessageTokens(req.messages);
    const threshold = this.d.compactThresholdTokens ?? DEFAULT_COMPACT_THRESHOLD_TOKENS;
    const rawKeepTail = Math.max(1, Math.floor(this.d.compactKeepTail ?? DEFAULT_COMPACT_KEEP_TAIL));
    // 임계 이하 또는 압축할 head 없음(메시지 ≤ keepTail) → 원본(드롭 폴백은 assemble 담당).
    if (est <= threshold || req.messages.length <= rawKeepTail) return { messages: req.messages, recap: "", droppedCount: 0 };
    // ⚠️ provider-safe: tail 선두를 **user 경계에 정렬**(적대리뷰 갭). (len-rawKeepTail) 부터 첫 user 까지 전진 →
    // 그 앞을 전부 recap(요약)하고 tail 은 user 로 시작(마지막=현재 user). 엄격 provider(Anthropic Messages API)가
    // leading assistant/tool 을 400 거부하는 것 차단. 경계 조정이라 정보손실 0(잘린 만큼 recap 이 흡수).
    let tailStart = req.messages.length - rawKeepTail;
    while (tailStart < req.messages.length - 1 && req.messages[tailStart]!.role !== "user") tailStart++;
    const keepTail = req.messages.length - tailStart;
    if (keepTail >= req.messages.length) return { messages: req.messages, recap: "", droppedCount: 0 }; // 요약할 head 없음(정렬 후 전부 tail)
    try {
      const r = await raceAbort(
        compaction.compact({ messages: req.messages, keepTail, targetTokens: this.d.compactTargetTokens ?? DEFAULT_COMPACT_TARGET_TOKENS }),
        signal, this.d.memoryTimeoutMs ?? MEM_RECALL_TIMEOUT_MS,
      );
      // null=abort/timeout, droppedCount<=0=압축 미수행, recap 공백=주입할 요약 없음 → 모두 원본 유지.
      if (!r || r.droppedCount <= 0 || !r.recap || !r.recap.trim()) return { messages: req.messages, recap: "", droppedCount: 0 };
      const tail = req.messages.slice(tailStart);
      // recap+anchors 영속(cross-session) — fire-and-forget + no-throw(저장이 턴을 차단/실패시키지 않음).
      compaction.attachHandoff({ sessionId: req.sessionId ?? "default", recap: r.recap, anchors: [], trigger: "budget", turnCount: req.messages.length, totalTokens: est })
        .catch((e) => this.safeDiag("compaction attachHandoff 실패(턴 유지)", e));
      return { messages: tail, recap: r.recap, droppedCount: r.droppedCount };
    } catch (e) {
      this.safeDiag("compaction 실패(드롭 폴백)", e);
      return { messages: req.messages, recap: "", droppedCount: 0 };
    }
  }

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
    const activeConfig = req.provider ?? this.activeDefaultConfig;
    const costModel = activeConfig?.model ?? ""; // 미설정 = calculateCost("") = 0(크래시 아님)
    const costProvider = activeConfig?.provider; // 구독형(claude-code-cli) = $0 분기용(동일 model ID anthropic 과 구별).
    // terminal 래치(usage 중복 emit 원천 차단 — 두 종결 모두 이 헬퍼만 사용).
    const terminalFinish = () => { if (!sawTerminal) { emit({ kind: "usage", ...totalUsage, cost: calculateCost(costModel, totalUsage.inputTokens, totalUsage.outputTokens, costProvider), model: costModel }); emit({ kind: "finish" }); sawTerminal = true; t.state = "finished"; } };
    const terminalError = (message: string) => { if (!sawTerminal) { emit({ kind: "usage", ...totalUsage, cost: calculateCost(costModel, totalUsage.inputTokens, totalUsage.outputTokens, costProvider), model: costModel }); emit({ kind: "error", message }); sawTerminal = true; t.state = "errored"; } };

    try {
      if (!activeConfig) { terminalError("no provider configured — naia-settings/llm.json 도 wire provider 도 없음"); return; }
      const providerConfig: ProviderConfig = {
        ...activeConfig,
        ...(req.enableThinking !== undefined ? { enableThinking: req.enableThinking } : {}),
        ...(this.d.credentials.get(activeConfig.provider) ?? {}),
      };
      // UC-compaction(FR-COMPACT): assemble 전 예산 압박이면 head 를 memory 가 요약(recap)해 교체(정보보존).
      // 미주입/임계이하/실패 = 원본(budgeted-conversation 이 최종 드롭 가드). recap 은 아래 systemPrompt 에 주입.
      const { messages: preMessages, recap: compactionRecap, droppedCount: compactedCount } = await this.maybeCompact(req, signal);
      // UC-compaction: 압축 발생 시 wire 로 알림(UI 표시용). 비-terminal·무손실 정보 — usage/finish 불변식 무영향.
      if (compactedCount > 0) emit({ kind: "compacted", droppedCount: compactedCount });
      // FR-PERSONA-3: 코어가 워크스페이스 페르소나를 *스스로* 조립(클라가 안 보냄). personaSource 주입 시
      // config.json 1회 읽기(작은 파일, per-turn 허용 — 라이브 편집 즉시 반영) → domain 순수 fn 으로 합성.
      // req.systemPrompt(명시 override: --system 플래그 / naia-os voice-pipeline·discord 의 per-turn 지시) 우선,
      // 없으면 코어 조립값. S4 종착: naia-os 텍스트 채팅은 더는 systemPrompt 를 안 싣고 environmentSegments 만 보냄
      // (persona-baking 두벌 제거). 둘 다 없으면 undefined(generic). personaSource 미주입 = 기존 동작(무회귀).
      const personaProfile = this.d.personaSource ? (this.d.personaSource.load() ?? {}) : undefined;
      const corePersona = personaProfile ? composePersonaPrompt(personaProfile) : "";
      // FR-WORKSPACE: persona 바로 뒤에 워크스페이스 컨텍스트(cwd+프로젝트 이름, 경량 shallow)를 append —
      // 에이전트가 자기 워크스페이스를 인식. snapshot()=undefined(소스 부재)면 빈 입력으로 정규화 → "".
      const coreWs = this.d.workspaceContext ? composeWorkspaceContext(this.d.workspaceContext.snapshot() ?? { cwd: "", projects: [], projectTotal: 0 }) : "";
      // S4(계약 C2): 클라(naia-os) 환경고유 세그먼트(아바타 감정·패널)를 workspace 뒤에 결정론 머지. emotion-tag
      // 예시의 locale 은 코어가 소유한 persona 프로필(config.json locale)에서 취함(클라가 안 보냄 — 권한 모델).
      // CLI 는 빈 배열 → ""(무영향). 화이트리스트 외 kind 는 renderEnvironmentSegments 가 드롭.
      const coreEnv = renderEnvironmentSegments(req.environmentSegments ?? [], personaProfile?.locale);
      // 코어 조립값 = persona ⊕ workspace ⊕ environment(전부 빈 값이면 "" → undefined). req.systemPrompt override 시 전부 무시.
      const coreComposed = [corePersona, coreWs, coreEnv].filter(Boolean).join("\n\n");
      const baseSystemPrompt = req.systemPrompt ?? (coreComposed || undefined);
      this.d.diag.debug?.("persona base 결정", { requestId: req.requestId, override: req.systemPrompt !== undefined, corePersona: corePersona.length > 0, workspace: coreWs.length > 0, environment: coreEnv.length > 0, source: req.systemPrompt !== undefined ? "override" : (coreComposed ? "core" : "none") });
      const asm = this.d.conversation.assemble({ messages: preMessages, systemPrompt: baseSystemPrompt });
      // UC-memory FR-MEM-1: 턴 전 recall → systemPrompt 주입(회상 있으면). 기준 = *이 턴의 새 user
      // 입력* = 메시지 배열의 마지막 메시지가 user 일 때 그것. ⚠️ "마지막 user 를 전체에서 탐색"이 아니라
      // 마지막 메시지여야 한다 — assistant continuation/regenerate(마지막이 assistant) 요청에서 과거
      // user 발화를 query·save 대상으로 재사용하는 오류를 막기 위함. 마지막이 user 가 아니면 이 턴엔 새
      // 입력이 없으므로 recall/save 생략. content="" 도 정상 입력(빈 문자열 truthiness 로 건너뛰지 않음).
      const lastMsg = req.messages.length ? req.messages[req.messages.length - 1] : undefined;
      const currentUserMsg = lastMsg?.role === "user" ? lastMsg : undefined;
      const lastUserText = currentUserMsg?.content ?? "";
      // compaction recap → systemPrompt 주입(leading assistant 메시지 회피, recall 과 동일 패턴). recall 은 이 뒤에 append.
      let memSystemPrompt = compactionRecap
        ? (asm.systemPrompt ? `${asm.systemPrompt}\n\n## 이전 대화 요약(compacted)\n${compactionRecap}` : `## 이전 대화 요약(compacted)\n${compactionRecap}`)
        : asm.systemPrompt;
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
          if (recalled) memSystemPrompt = memSystemPrompt ? `${memSystemPrompt}\n\n${recalled}` : recalled;
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
          // FR-CONV.1: verbatim transcript append(전두엽이 자기 turn 기록 — naia-memory.save 형제). append=no-throw 격리라
          // turn/finish/usage 불변식 무영향(save 와 동일 무방출). sessionId 누락="default"(단일 fallback, FR-CONV.2).
          if (this.d.conversationLog && currentUserMsg) {
            try {
              await this.d.conversationLog.append({ sessionId: req.sessionId ?? "default", userText: lastUserText, assistantText: assistantTurnParts.join("\n") });
            } catch (e) { this.safeDiag("transcript append 실패(턴 유지)", e); }
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
              emit({ kind: "approvalRequest", toolCallId: cid, toolName: call.name, tier, args: call.args, description: tools.find((s) => s.name === call.name)?.description ?? "" }); // 등록 후 emit; args/description=승인 페이로드(UC1 리뷰)
              decision = await promise;
            } catch { decision = "reject"; } finally { dispose(); } // abort→catch→(f) cancelled; 비-abort reject=거부
            if (signal.aborted) { terminalError("cancelled"); cancelled = true; break; } // (f) await 후 가드
            if (decision === "reject") {
              const out = "도구 호출이 거부되었습니다";
              emit({ kind: "toolResult", toolCallId: cid, output: out, toolName: call.name, success: false });           // 거부도 toolResult 쌍(I6); success=false(UC1 리뷰)
              results.push({ output: out, isError: true });
              continue;                                                             // 실행 안 함 — 다음 call
            }
          }
          // approve 또는 비-gated → 실행:
          let r: { output: string; isError?: boolean };
          try {
            if (exec) {
              // UC5 리뷰 fix(liveness): per-tool deadline race(memory 와 동일). 무응답 도구가 turn 영구 hang 못 하게.
              const res = await raceAbort(exec.execute({ ...call, id: cid }, { signal, requestId: req.requestId }), signal, this.d.toolTimeoutMs ?? TOOL_EXEC_TIMEOUT_MS); // requestId=UC-PANEL: panel 도구가 panel_tool_call 을 이 chat 스트림으로 위임
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
          emit({ kind: "toolResult", toolCallId: cid, output: r.output, toolName: call.name, success: !r.isError });           // toolUse 와 쌍(cid); success=!isError(UC1 리뷰)
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
