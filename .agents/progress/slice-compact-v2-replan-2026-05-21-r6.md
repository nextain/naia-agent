# Slice 3-XR-Compact v2 — R6 Replan (R1-R5 invalidate, 재출발)

**Status**: PLAN — R6 code/test audit verdict 후 재계획
**Worktree**: `migration/slice-compact-v2`
**R6 commit**: `b579831`

---

## 1. 무엇이 무효화됐나

R6 audit 결과 (glm + gemini convergent):

| 측정 결과 | 신뢰도 | 이유 |
|---|---|---|
| `anthropic-native` 행 5라운드 전체 | ❌ INVALID | 코드가 `return undefined` sentinel — `off` 와 byte-identical |
| `reactive-vercel` 행 5라운드 전체 | ❌ INVALID | KR plain-text fixture 에서 pruneMessages no-op. recap empty fallback 으로 effectively `off`. 0.92 우월 결과 = 측정 artifact |
| F-EN-TH-01 의 LCH/RES-J probe | ❌ INVALID | 답이 preserved tail (turns 11-18) 안 — strategy 무관 답 가능 |
| F-EN-TH-01 의 weather probe | ⚠️ MAYBE | 답이 recap 범위 (turns 3-4) — 진짜 stress, 그러나 N=1 |
| F-KR-TR (temporal reasoning) | ⚠️ MAYBE | 답 turn 6-7 in recap 범위 — 진짜 stress, N=1 |
| F-KR-MS (multi-session) | ⚠️ PARTIAL | "100만원" recap / "5일" tail — 답 만들기엔 두 정보 필요. N=1 |
| F-KR-IE / F-KR-KU / F-KR-AB | ❌ INVALID | 답이 tail 안에 있어 strategy stress 안 됨 |

→ **R5 의 "reactive-vercel 0.92" 결론 = 완전 무효**. Vercel pruneMessages 는 KR plain-text 에서 거의 동작 안 함.

또 무효:
- **5-round adversarial review verdicts** = verdict-mode framing 으로 root cause 못 봄
- **R2-R5 의 code fixes** = 위 잘못된 측정 위에 쌓은 patch. 코드는 살아있지만 측정 의미는 없음.

---

## 2. 무엇이 살릴 수 있나

| 자산 | 살릴 수 있는가 |
|---|---|
| **Phase 1.1 helper** (`createVercelCompactionPrepareStep`) | ✅ Vercel SDK 차용 자체는 OK. 코드 자체는 라이브 |
| **Phase 1.2 `Agent.prepareCompact` hook** | ✅ Architecture clean. core/runtime 분리 정상 |
| **`--reactive-vercel` flag** | ✅ Wiring 정상 |
| **`createLLMMessagePrepareCompact` factory + 어댑터** | ⚠️ 코드 살아있으나 plain-text fixture 에서 무효 — fixture 가 reasoning/tool blocks 가질 때만 의미 |
| **4-judge ensemble harness** | ✅ infra OK. opencode/codex CLI timeout 만 별 문제 |
| **`mini-bench-judge.ts` 구조** | ⚠️ 살리려면 evaluateProbe 통합 + recap-only 평가로 재작성 |
| **6 KR fixture** | ❌ 4/6 이 strategy stress 안 함. 재작성 필요 |
| **F-EN-TH-01 fixture** | ⚠️ 절반 (weather probe) 만 살릴 가치 |
| **R1-R5 측정 보고서** | ❌ 표기상 "preliminary, do not cite" 라벨 강제 |

---

## 3. R7 계획 — 정직한 측정으로 재출발

### Phase A — 측정 인프라 재설계 (코드 레벨)

| 작업 | 우선순위 | 목적 |
|---|---|---|
| **A1**. `anthropic-native` strategy 제거 OR 실 API 호출 구현 | P0 | placebo 제거. plan §3 원안 따르면 `@ai-sdk/anthropic` + beta header `compact-2026-01-12` 실 호출 |
| **A2**. `off` 의 진짜 시뮬 (provider hard-truncate / 4xx) 명시 | P0 | "no compaction baseline" 의미 분명화 |
| **A3**. `runner.ts evaluateProbe` 와 `mini-bench-judge.ts extractVisibleContext` 를 **단일 공유 함수**로 통합 | P0 | byte-identical visible context. divergence 봉쇄 |
| **A4**. `evaluateProbe` 가 **recap range fact 만 평가** (tail-only fact 자동 reject 또는 별 라벨) | P0 | strategy stress 보장 |
| **A5**. `validateFixture` strict — task-accuracy probe 0 = error | P1 | silent fallback 봉쇄 |
| **A6**. `keepTail` / `CONTEXT_WINDOW_CHARS` / `compactAfterTokens` shared config | P1 | 4 라운드 동안 drift 함 |
| **A7**. `reactive-vercel` no-op 처리 — pruneMessages 가 undefined 반환 시 명시적 "N/A" 또는 정직한 fail | P1 | fallback 으로 off 흉내내기 봉쇄 |

### Phase B — Fixture 재작성

| 작업 | 우선순위 |
|---|---|
| **B1**. 기존 KR fixture 6개 중 4개 (IE/KU/AB/MS) 의 probe 수정 — 답이 **반드시 recap range 안에만** 있도록 | P0 |
| **B2**. KR fixture 에 `[thinking]` / `[tool_use]` / `[tool_result]` 마커 추가 → Vercel pruneMessages 가 실제로 strip 할 게 있게 만듦 | P0 — reactive-vercel 측정 의미 살리기 |
| **B3**. Per-fixture **5+ task-accuracy probes** (N>1) | P1 |
| **B4**. F-EN-TH-01 의 LCH/RES-J probe 제거 또는 fact 를 recap range 로 이동 | P0 |

### Phase C — 외부 baseline 비교

| 작업 | 우선순위 |
|---|---|
| **C1**. LongMemEval-S 영문 subset (10-20 question) 차용 + 동일 harness 적용 | P1 |
| **C2**. published OMEGA/Memoria/RetainDB 와 직접 비교 가능 표 | P2 — C1 후 |

### Phase D — 적대 리뷰 framing 영구 개선

| 작업 | 우선순위 |
|---|---|
| **D1**. `r6-audit-prompt.md` 를 표준 cross-review prompt 템플릿으로 승격 | P0 |
| **D2**. verdict-mode prompt (REMAINS/FIXED/PUBLISHABLE) 폐기 | P0 |
| **D3**. 매 round 시작 시 "이전 round 결과 trust 평가" 도 audit prompt 안에 포함 | P1 |

---

## 4. Phase 1.3 처리

- **R5 결과를 발표/외부 공유 → 절대 금지** (verdict = INVALID)
- 보고서들에 **"R6 audit invalidated"** 라벨 추가
- 측정 표 commit message 에 "do not cite" 명시

---

## 5. 다음 즉시 액션 (사용자 결정 대기)

R7 plan 의 어디부터 시작할지:

| 옵션 | 의미 | 소요 |
|---|---|---|
| **A: Phase A 부터 (인프라 재설계 → 깨끗한 측정 기반)** | A1-A4 P0 fix 먼저. fixture 재작성 후 측정 | 큰 작업 (~1-2일) |
| **B: Phase B 부터 (fixture 재작성 → 기존 harness 로 측정)** | 시간 적게 들지만 harness divergence 안 풀림. 측정만 의미있음 | 중간 (~반일) |
| **C: 단순히 R5 invalidate 라벨만 명시 + Phase 1.3 종결** | 측정 없이 인정. Phase 2 (`realtime`) 진입 | 작음 (~시간) |

사용자 결정 필요. 

---

## 6. 메타 교훈

- **Verdict-mode prompt 는 적대 리뷰가 아니다**. "내가 정의한 후보가 fix 됐냐" 검증은 안전한 review 가 됨. 진짜 결함은 자유 audit 에서만 잡힘.
- **5 라운드 = 신뢰의 증가가 아니라 framing bias 의 누적**. 같은 framing 으로 같은 측정을 5번 본다고 신뢰 안 늘어남.
- **사용자가 표 한 번 보고 "왜 같지?" 한 마디로 잡은 결함**을 4-AI × 5라운드 = 20 review 가 못 잡은 것은 ratio 가 아니라 framing 의 문제.
- **메모리에 남길 교훈**: cross-review prompt 에 "결과 verdict" 보다 "코드/테스트 raw audit" 가 primary task 가 되어야 함.
