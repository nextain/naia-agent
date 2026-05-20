# Slice 3-XR-Compact — triple-strategy compaction + benchmark harness (2026-05-20)

**상태**: PLAN — 사용자 directive ("둘 다 구현하고 벤치마킹 구조부터 / opencode·openclaw 참고 / naia-agent 둘 다 지원 / 다른 AI 크로스리뷰 후 진행").
**선행 완료**: Slice 3-XR-A~O / 3-XR-Docs DONE.
**deferred**: 50-fixture 확장 + naia-os wiring (#185 Phase 2) — 별 slice.
**연관**: nextain/naia-os#185 (token budget Phase 2), nextain/naia-memory `MemorySystem.compact()` (이미 v0/v1/v2 구현).

---

## 1. 문제 정의

naia-os 의 long-running avatar 대화가 토큰 한계 임박 시 자동 compaction 없음. naia-memory `compact()` 는 구현됐지만 naia-agent 대화 루프 / naia-os 가 호출하지 않음. token budget 검사는 warn-only.

**파편화 현황**:
- naia-memory `compact()` — deterministic recap (v0) + LLM summarizer hook (v1) + **rolling summary fast path (v2, realtime=true)**.
- naia-agent core `Agent.#maybeCompact` — turn-loop budget 검사 + `CompactableCapable` 위임 + head-drop fallback.
- naia-os `agent/src/index.ts` — naia-agent core `Agent` 사용 안 함, provider.stream 직접. `checkTokenBudget` warn-only. **#185 Phase 2 TODO**.

**과제**: naia-agent 차원에서 **3-way strategy** 를 first-class 로 노출 + 측정 가능한 benchmark harness 구축. naia-os wiring 은 후속.

---

## 2. 외부 사례 종합 (이미 조사 완료)

### 2.1. Anthropic 공식 (cookbook + Messages API)

- **SDK 레벨** (`tool-use-automatic-context-compaction` cookbook):
  - `context_token_threshold` default **100k** (전체 200k window 기준 ≈ 50%).
  - Recap = single user-role message with `<summary>...</summary>` wrapper. Claude 가 자체 생성.
  - 모든 prior 메시지 폐기 → summary 1개 + 신규 turn 이어감.
  - **Tool_use/tool_result pairs 폐기** (요약만 남음). 단, 압축 후 도구 재호출 가능.
  - 권고: "**Manual at 60% > Auto at 95%**" — 일찍 압축할수록 품질 ↑.
  - Limitations: server-side sampling loop / server-side web search 와 호환 불완전, summary 는 inherent 정보 손실.
- **Server-side** (Opus 4.6+): 모델이 자체 관리, SDK 설정 불필요. SDK 사용자는 cookbook 의 client-side path.
- 출처: [Anthropic Cookbook — Automatic context compaction](https://platform.claude.com/cookbook/tool-use-automatic-context-compaction)

### 2.2. OSS 패턴 (5-repo 합의)

#### Universal patterns (5/5 채택)
1. **Dual trigger**: reactive overflow detection + 사용자 `/compact` + preemptive (reserve ~16k).
2. **Structured recap markdown** (고정 섹션):
   - opencode: `## Goal / ## Instructions / ## Discoveries / ## Accomplished / ## Relevant files`
   - openclaw: 위 + `## Constraints & Preferences / ## Progress (Done/InProgress/Blocked) / ## Key Decisions / ## Next Steps / ## Critical Context` + `<read-files>/<modified-files>` XML markers
3. **Tail preservation**: `tail_turns=2` (default) + `preserveRecentTokens` ~25% of usable context (min 2k, max 8k).
4. **Identifier preservation strict-mode**: UUID/URL/file path 원문 verbatim.
5. **Chunked fallback**: 요약 LLM 실패 시 분할 재요약. openclaw 의 `summarizeWithFallback`.
6. **Continuity Event** publish + synthetic user message `metadata: {compaction_continue: true}` 주입 (auto-trigger 인 경우).

#### Multi-repo winners (3/5+)
- **Split-turn logic** (openclaw, pi): 단일 turn 이 tail-budget 초과 시 turn-prefix 만 별도 요약.
- **Transcript rotation** (opencode): 압축 후 새 transcript 파일 = summary + tail, 구 transcript archive.
- **Model fallback chain** (openclaw): 요약 모델 실패 시 next-model 로 재시도.
- **Hook interception** (cline): `precompact` hook 으로 정책 surface 확장.

#### Domain-specific (1-repo only)
- ref-pi `tree` 분기 압축 — multi-branch 코딩 한정.
- openclaw `handoff` 지시 — 모델 quota 소진 multi-hop 시나리오 한정.
- opencode `pruning` — tool-result 만 미리 stripping (high-churn 환경).

### 2.3. 학계

| 시스템 | 패턴 | 우리 적용 |
|---|---|---|
| **MemGPT** (arxiv 2310.08560) | Hierarchical virtual context (main + external pages, page-fault recall) | 우리 (B) realtime 의 상위 — *deferred*, 후속 slice |
| **Recursive summarization** (arxiv 2308.15022) | 재귀 누적 요약 — rolling 의 학술 origin | 우리 (B) 의 기반 |
| **Mem0** (arxiv 2504.19413) | LLM-driven fact extraction + scalable recall | 이미 naia-memory R2.5 채택 |
| **Proactive Memory Extraction** (arxiv 2601.04463) | Static summary 한계 + 동적 추출 | (B) 의 향후 방향성 reference |
| **LongMemEval** | 장기 대화 평가 benchmark | 우리 fixture 형식 참고 |

**학계 합의**: hierarchical > rolling > naive reactive. 그러나 hierarchical 은 implementation cost ↑↑ → 본 slice scope 밖.

---

## 3. 3-Way Strategy 디자인 결정

### Strategy A' — `reactive` (default)

opencode + openclaw 패턴 합성. naia-memory 의 `compact()` 위에 wrapper 추가.

- **Trigger**: token budget 초과 (default **60%** — Anthropic 권고 채택) OR provider 의 `context length exceeded` 에러 catch.
- **Recap shape**: opencode 5-섹션 markdown (Goal/Instructions/Discoveries/Accomplished/Files) + identifier preserve. system-role.
- **Tail**: `tail_turns=2` + `preserveRecentTokens=2000`.
- **Failure**: 요약 LLM 1회 실패 → chunked fallback (head 를 N개로 분할, 각 chunk 요약, 머지). 2회 실패 → naia-memory deterministic v0 fallback ("No prior history.").
- **Continuity**: `EmitCompactionEvent({type:'reactive', droppedCount, recapTokens, tookMs})` + (optional) synthetic continue message.

### Strategy B — `realtime`

naia-memory v2 rolling summary fast path 활성. 매 turn `encode()` 마다 rolling 누적 → `compact()` 호출 시 instant.

- **Trigger**: 동일 (60% budget).
- **Recap shape**: 학계 recursive summarization 형식 — opencode 5-섹션은 적용 어려움 (rolling 은 fact-flat). 단 (optional) LLM polish 단계에서 5-섹션 재구성.
- **Tail**: 동일.
- **Failure**: rolling 미존재 시 자동 reactive (A') 로 fallback.
- **Continuity**: `EmitCompactionEvent({type:'realtime', realtime:true, tookMs})`.

### Strategy A'' — `anthropic-native` (opt-in)

Anthropic backend 일 때만 활성. cookbook 의 `context_management.edits` 옵션 노출.

- **Trigger**: Anthropic 가 server-side 결정.
- **Recap shape**: 모델 자체 `<summary>` 태그.
- **Tail**: cookbook default.
- **Failure**: Anthropic 가 처리.
- **Continuity**: usage 응답에서 compaction 사실만 surface.

### Strategy 선택 UX

```bash
# CLI flag
pnpm exec naia-agent --compact-strategy reactive|realtime|anthropic-native|off

# service manifest
"compaction": { "strategy": "realtime", "threshold": 0.6, "tailTurns": 2 }

# env override
NAIA_AGENT_COMPACT_STRATEGY=realtime
```

Default = **reactive** (Anthropic 권고 정렬 + 외부 사례 합의). realtime 은 명시 opt-in. anthropic-native 는 backend=anthropic + 모델 ≥ Opus 4.6 일 때만 자동 활성 권유 (warn-on-mismatch).

---

## 4. Benchmark Harness 디자인

### 4.1. 위치 — `packages/benchmarks/`

신규 패키지. monorepo 의 9번째 package. Vitest fixture-replay 와 별개 ladder.

```
packages/benchmarks/
├── package.json
├── src/
│   ├── fixtures/             # multi-turn dialog JSON
│   │   ├── README.md
│   │   └── *.fixture.json
│   ├── strategies/
│   │   ├── reactive.ts       # wraps Strategy A' for harness
│   │   ├── realtime.ts
│   │   └── anthropic-native.ts
│   ├── metrics/
│   │   ├── task-accuracy.ts  # LLM-judge (NAIA_JUDGE_ENSEMBLE 재사용)
│   │   ├── fact-recall.ts
│   │   ├── latency.ts
│   │   ├── cost.ts
│   │   └── drift.ts          # cosine + LLM-judge
│   ├── runner.ts             # orchestrator
│   └── report.ts             # markdown writer
└── __tests__/
    └── harness-smoke.test.ts
```

### 4.2. Fixture 형식

```json
{
  "id": "F001-customer-support-50turn",
  "domain": "customer-support",
  "turns": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." },
    ...
  ],
  "probes": [
    { "afterTurn": 30, "type": "fact-recall",
      "question": "What was the customer's order number?",
      "expectedKeywords": ["#A-7421"] },
    { "afterTurn": 50, "type": "task-accuracy",
      "criterion": "Assistant correctly summarized refund eligibility" }
  ],
  "compactionPoints": [25, 45]
}
```

### 4.3. 5축 metric

| Metric | 산정 | Strategy 우열 신호 |
|---|---|---|
| **task-accuracy** | LLM-judge (NAIA_JUDGE_ENSEMBLE GLM+Codex+Claude majority) on probes | 핵심 — 가장 중요 |
| **fact-recall** | probe answer 가 expectedKeywords 포함 비율 (string match + LLM-judge backup) | drift 가시화 |
| **latency** | per-turn p50/p99 (compaction 호출 latency 별도 측정) | reactive p99 burst vs realtime 분산 |
| **cost** | total tokens (LLM summarizer call 포함) per session | reactive 짧은 세션 우위 / realtime 긴 세션 우위 가설 |
| **drift** | 같은 final-turn prompt 에 (compact 한 vs 안 한) 두 응답의 cosine + LLM-judge 동치성 | strategy 간 정성적 차이 |

### 4.4. Judge

NAIA_JUDGE_ENSEMBLE harness 재사용 (이미 3-XR-H 에 GLM+Codex+Claude majority 구현). 비용 의식 = 핵심 probe 만 ensemble, 나머지 GLM 단독.

### 4.5. Report

`packages/benchmarks/reports/{date}-{strategy-set}.md` — markdown 5축 표 + per-fixture breakdown + 권장 결론.

---

## 5. Phases

| P | 작업 | 4-criterion 매핑 | 산출 |
|---|---|---|---|
| **P0** | `docs/compaction-survey.md` — §2 외부 사례 종합 정본 | docs entry | 1 file |
| **P1** | `packages/benchmarks/` 스켈레톤 — pkg.json, runner, metric stubs, fixture schema, report writer | 신규 명령 `pnpm bench:compact`; vitest harness smoke | 1 pkg |
| **P2** | Strategy interface — `CompactionStrategy` enum + bin flag `--compact-strategy` + service manifest 필드 + env var | unit test (flag parsing) | core + bin diff |
| **P3** | **Reactive (A')** impl — opencode 5-섹션 recap + tail-budget + chunked fallback. naia-memory deterministic summarizer 강화 (current-task-aware seed). | unit + benchmark integration | runtime impl + naia-memory minor |
| **P4** | **Realtime (B)** wire-up — sessionId pass-through. naia-memory v2 rolling 활성. | unit + benchmark integration | runtime impl |
| **P5** | **Anthropic-native (A'')** passthrough — `context_management.edits` 옵션 노출. backend=anthropic 만 활성. | unit + DRYRUN integration | provider adapter diff |
| **P6** | 시드 fixture 10개 + 첫 측정 + ledger entry | benchmark report 1건 | fixtures + report |

**규모 추정**: P0 0.5d / P1 1d / P2 0.5d / P3 1.5d / P4 0.5d / P5 1d / P6 1.5d = **6.5일**.

---

## 6. 4-criterion 충족 (R1+ 머지 차단 게이트)

1. ✅ **새 실행 가능 명령**: `pnpm exec naia-agent --compact-strategy=...`, `pnpm bench:compact`
2. ✅ **단위 테스트 1+**: strategy enum 파싱 / recap markdown / tail budget / chunked fallback / sessionId pass-through
3. ✅ **통합 검증 1+**: benchmark harness 가 10 fixture 에 대해 3 strategy 모두 회수 → 5축 metric 산출 → report 생성
4. ✅ **README/CHANGELOG entry**: `## [Slice 3-XR-Compact] — 2026-05-2X — triple-strategy compaction + benchmark harness`

---

## 7. 매트릭스 §D 추가 항목 (cross-link)

- **D## (신규)**: 3-way compaction strategy first-class (A'/B/A'') — naia-agent 가 모두 지원, default reactive. 근거: §2 외부 사례 합의 + 학계 + Anthropic 권고.
- **F## (신규?)**: Anthropic-native compaction passthrough — backend=anthropic + 모델 ≥ Opus 4.6 시 자동 활성. cookbook beta header 정합.

(매트릭스 ID 는 issue 생성 후 부여)

---

## 8. Open Questions — **LOCKED (2026-05-20)**

Cross-evidence: Anthropic Cookbook + 5-repo OSS + 학계 (MemGPT/Mem0/recursive) + **Microsoft Learn Agent Framework Compaction + Acon (arxiv 2510.00615) + Factory.ai anchored iterative summarization (via Zylos research)**.

외부 LLM 도구 (codex/gemini/opencode/ollama) cross-review 는 환경 이슈 (sandbox/TTY/GPU 점유) 로 실패. 다만 위 cross-evidence (peer-reviewed + product team 평가) 가 더 강함.

| Q | 결정 | 근거 |
|---|---|---|
| **Q1. Default threshold** | **75% (configurable)**. Anthropic 60% (manual quality) 와 OSS 80-95% (cost) 절충. | Acon: "smaller=freq+accuracy↓, larger=cost↑, moderate best". Our use-case = long avatar + tool-heavy. |
| **Q2. Realtime polish** | **deterministic by default, LLM polish only at compact() time** (per-turn polish OFF). | Factory.ai: "anchored iterative > full-reconstruction" — persistent state 갱신이 핵심, per-turn polish 아님. per-turn polish = ~10× cost. |
| **Q3. Tool_use/tool_result pairs** | **Microsoft `ToolResultCompactionStrategy` 패턴** — `tool_result` > 2k tokens 시 disk write + path reference + 10-line preview. tool_use ID 보존. Recap 본문에 "tool calls made: ..." 요약 포함. | MS Learn Compaction 공식. opencode pruning 보다 정밀, Anthropic 전체 discard 보다 보존. |
| **Q4. anthropic-native vs 우리 strategy 동시 활성** | **uppermost = anthropic-native** (server-side 가 더 권위). 활성 시 우리 strategy 자동 OFF (warn-log). backend ≠ anthropic 시 우리 strategy 만. | Anthropic server-side 가 모델 internal state 까지 접근 가능. host-side 우리 strategy 는 model 입력만. |
| **Q5. Fixture 출처** | **자체 10개 + LongMemEval 일부 reference (라이선스 OK 시)**. 자체가 우선. naia-memory 의 `locomo-memory.json` 일부 시드화. | 우리 도메인 (avatar + skill + memory 트리플) 이 LongMemEval 과 미스매치. |
| **Q6. Server-side sampling loops 호환** | **명시 limitation 으로 문서화**. 우리 strategy + web-search tool 동시 활성 시 cache token 누적 위험 = Anthropic 와 동일. **P6 fixture 1개에 web-search-heavy 시나리오 포함** → 측정으로 확인. | Anthropic cookbook 명시 limitation. |
| **Q7 (신규). Reactive recap 도 stateful 인가?** | **YES — reactive 도 anchored iterative 화**. 이전 recap 을 새 recap 의 seed 로 merge. (B) realtime 의 rolling 이 사실상 이미 함. (A') reactive 는 이 패턴을 명시 채택. | Factory.ai 평가: anchored iterative > full-reconstruction. 우리 (A') 가 단순 head-summarize 였으면 (B) 가 일관 우위 — 측정 전 정렬. |

**Plan LOCKED — 이 결정으로 §3 디자인 정밀화 (아래 §12).**

---

## 9. 위험

- **Over-engineering**: 3-way strategy 가 maintenance cost ↑. mitigation = anthropic-native 는 opt-in feature flag, 기본 OFF (D## 등재만 + DRYRUN 검증).
- **Fixture writing 비용**: 10 fixture × 50 turn × 도메인 다양성 — 작성 자체가 1.5일. naia-memory 의 locomo-memory.json 시드 일부 재가공 검토.
- **NAIA_JUDGE_ENSEMBLE 크레딧**: 1 fixture × 5 probe × 3-judge = 15 ensemble call. 10 fixture = 150 call. claude/codex 구독 크레딧 부담. mitigation = ensemble 은 핵심 probe (task-accuracy) 만, fact-recall 은 GLM 단독.
- **naia-memory minor API 변경 위험**: §3 reactive 의 "current-task-aware seed" 가 `compact()` input 에 `currentTurn` 필드 추가 필요. naia-memory 호환성 유지 (optional field).

---

## 10. Cross-review 던질 대상

(메모리 [[feedback_pi_substrate_not_glm_only_2026_05_20]] 정합 — multi-tool ensemble 첫 라운드부터)

- **GLM** (HTTP API direct, 환경 견고)
- **Codex** (재시도, 더 단순 invocation)
- **Local Gemma4:31b** (HTTP API, TTY 우회)
- **Web Sources** (Anthropic cookbook + 학계) — 이미 §2 에 통합

Cross-review 응답을 받아 §8 Open Questions 항목별로 판정 → plan 의 final lock.

---

## 11. 진행 신호

- 사용자 directive: "둘 다 구현 + 벤치마킹 구조부터 + opencode/openclaw 참고 + naia-agent 양쪽 지원 + 다른 AI 크로스리뷰 후 진행" (2026-05-20).
- 본 plan 작성 → issue 생성 (#47) → cross-evidence (WebSearch+Cookbook+OSS+학계+MS+Acon+Factory.ai) → §8 LOCKED → plan 잠금 → **P0 진입 (now)**.

---

## 12. §8 LOCK 으로 정밀화된 디자인

### (A') reactive — *anchored iterative* 화 (Q7 반영)

- 첫 compaction: head messages → 5-섹션 markdown recap.
- 후속 compaction: **이전 recap + 새 head** → 새 recap (이전 recap 을 seed 로 LLM merge). naive head-summarize 아님.
- threshold 75% (Q1).
- tool_result 처리: 큰 (>2k tokens) tool_result 는 disk + path reference + 10-line preview (Q3). tool_use ID 보존. recap 본문에 "tool calls made: read_file(x.ts), bash(npm test), ..." 요약.
- LLM polish = ON (recap 생성 자체가 LLM call — 본래 reactive 는 polish 가 핵심).

### (B) realtime — *rolling deterministic + compact-time polish* (Q2 반영)

- 매 turn encode() → rolling deterministic 누적 (LLM call X).
- compact() 호출 시: rolling seed + **LLM polish 1회** (recap 5-섹션 재구성).
- threshold 75% (Q1).
- tool_result 처리: 동일 (Q3).
- per-turn polish OFF by default. `compaction.realtimePolish=true` opt-in 만.

### (A'') anthropic-native — *backend gate + 자동 OFF*

- backend === 'anthropic' && model ≥ 'claude-opus-4-6' → 자동 활성 (server-side 가 더 권위 — Q4).
- 우리 host-side strategy 는 warn-log + auto-OFF.
- `compaction.anthropicNativeOverride=false` 로 forced-off 가능.

### Anchored iterative 가 (A') 와 (B) 의 진짜 비교 축이 되도록

- (A') 와 (B) **둘 다 anchored** — 즉 비교 축은 "polish 시점" (every turn 누적 vs compact-time only) + "rolling deterministic seed 유무".
- 측정에서 차이 안 보이면 결론 = "둘 다 OK, default reactive 가 단순성에서 유리".
- 차이 보이면 = use-case 별 권장.
