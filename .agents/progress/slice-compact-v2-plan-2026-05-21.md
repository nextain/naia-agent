# Slice 3-XR-Compact v2 (재출발) — 외부 검증 base 차용 + 객관 비교 — 2026-05-21

**Status**: PLAN — 사용자 directive (2026-05-21): "객관적 벤치 만들고 비교대상 / reactive = 외부 검증된 로직 차용 / realtime = 외부 유사 개념 + 우리 아이디어 / 외부 baseline 과 비교"
**Worktree**: `migration/slice-compact-v2`
**선행 정리**: 기존 Slice 3-XR-Compact (#47) 및 follow-up (#48) 은 분기 enum + boolean code-path 만 만든 상태. 실 4-way 차이 없음. 보고서 의미 부족 — 사용자 인지.

---

## 1. 사용자 요구 (정확히)

| # | strategy | 사용자 의도 | 현 구현 |
|---|---|---|---|
| 1 | `reactive` | **외부 검증된 로직 차용** (Anthropic Cookbook `compact_20260112`, opencode `processCompaction`, LangChain ConversationSummaryMemory 등) | naia 자체 toy deterministic 5-section ❌ |
| 2 | `realtime` | **외부 유사 개념 base + 우리 아이디어 추가** (MemGPT / Mem0 / Mastra working-memory + naia anchored iterative) | naia 자체 rolling, 외부 base 0 ❌ |
| 3 | `anthropic-native` | Anthropic 의 server-side 자동 압축 (`compact_20260112` beta) 실 호출 | host-side skip 만, API 호출 X ❌ |
| 4 | `off` | 압축 안 함 + production cost (4xx) 시뮬 | host-side skip, hard-truncation 시뮬 X ❌ |

→ **전부 재출발 필요**. enum + 측정 인프라 (4-judge ensemble + 한국어 fixture) 는 valid 재사용.

---

## 2. 4-AI cross-review 시도 + 환경 제약 인지

- 4 CLI (GLM HTTP / opencode / codex / gemini) 호출 시도
- **결과 모두 실패**:
  - GLM = 0 bytes (max_tokens 다 thinking content 에 소진)
  - opencode = "build · glm-5.1" Explore agent 만, 응답 본문 X
  - codex = 2.2 MB stdout 인데 응답 아님, sandbox 안에서 자동 grep 결과 흘림
  - gemini = "Ripgrep not available" 워닝만
- **이전 `smoke:judges:live` 가 4/4 LIVE 였던 이유** = npm script 안 spawn (cli-judge.ts 의 runCli) path. 직접 background bash spawn 은 sandbox/TTY 충돌.
- **대안 = WebSearch + ref-* 실 코드 분석 = "ref 가 cross-review participant 역할"**. ref 들이 검증된 production OSS 라 코드 자체가 evidence.

---

## 3. 외부 검증 base 후보 (받아 놓은 ref-* 분석)

### Reactive (외부 검증 차용 후보)

| 후보 | 위치 | 강점 | 약점 |
|---|---|---|---|
| **Vercel AI SDK `prepareStep` + `pruneMessages`** | `ref-vercel-ai-sdk/content/cookbook/00-guides/08-agent-context-compaction.mdx` | **이미 우리 dep (`ai` ^6.0.0)**. agent loop 표준 pattern. simple, mainstream. | abstraction 얇음, recap 품질은 LLM 호출자 책임 |
| `processCompaction` (opencode) | `ref-opencode/packages/opencode/src/session/compaction.ts` (18 KB) | production 검증, Effect 기반 robust, tool_result pruning + chunked fallback | Effect dep 도입 비용, opencode 의 session 모델 결합 |
| `compaction.ts` (openclaw) | `ref-openclaw/src/agents/compaction.ts` + 8 test 파일 | identifier preserve / retry / token sanitize / tool-result 다 test 됨 | 라이선스 명시 X (cleanroom 인접) |
| ConversationSummaryMemory (LangChain) | npm `@langchain/community` | 학계 baseline 명확 (recursive summary) | 외부 dep 도입 + framework lock |

**채택 권장**: **Vercel AI SDK `prepareStep`** — 이미 dep + 표준 + abstraction 깔끔. recap LLM polish 는 host 가 명시 inject.

### Realtime (외부 유사 개념 + naia 차별화)

| 후보 | 위치 | naia 추가 가치 |
|---|---|---|
| **Mastra working-memory tool** | `ref-mastra/packages/memory/src/tools/working-memory.ts` | LLM 매 turn 갱신하는 Markdown working memory. naia 추가 = anchored iterative + sessionId 통합. |
| Mem0 (외부 npm) | `mem0ai` 또는 `mem0/mem0` | fact extraction. naia 추가 = anchored merge. |
| MemGPT / Letta | `Letta` framework | hierarchical paging. naia 추가 = compact-time 통합. |
| openclaw rolling | `ref-openclaw` 의 별도 file | identifier strict-preserve. naia 추가 = 5-section markdown + 한국어. |

**채택 권장**: **Mastra working-memory tool + Mem0 fact extraction 패턴 합성**. 
- Mastra 의 LLM 매 turn 갱신 Markdown working memory = naia-memory 의 encode() 시점 트리거 자연 정합
- Mem0 의 (subject, predicate, object) extraction = recap 에 inline "Known facts" 명시
- naia 차별화 = anchored iterative (prior recap = next seed) + handoff (cross-session)

### Anthropic-native (실 API 호출)

- **`@ai-sdk/anthropic`** (우리 이미 dep `^2.0.0`) + 베타 header `compact-2026-01-12`
- `context_management.edits` 옵션 노출
- ref-vercel-ai-sdk fixture: `ref-vercel-ai-sdk/packages/anthropic/src/__fixtures__/anthropic-compaction.1.json` (실 응답 fixture)

### Off (hard-truncation 시뮬)

- production reality 시뮬: `visibleText.slice(-budget*4)` (chars 단위)
- 또는 token 단위 — `model.maxInputTokens` 초과 시 truncate

---

## 4. 외부 baseline (published numbers)

### LongMemEval-S (영문, 500 question × 48 session × ~115K token)

| 시스템 | Overall accuracy |
|---|---:|
| **OMEGA** (leaderboard #1) | 95.4% |
| **Memoria** | ~89% |
| **RetainDB** | 79% (overall), 88% (preference) |
| **Claude Opus 4.6** (abstention만) | 93.3% |
| **GPT-4o** (단독, no memory system) | 30-70% |

### LoCoMo (long conversation memory, J-score)

| 시스템 | J-score |
|---|---:|
| **Mem0** (token-efficient) | 92.5 |
| **Zep** | 75.14% |
| Full-context baseline | ~73% |

→ 우리 채택 base 와 동일 fixture 측정해야 head-to-head 비교 valid.

---

## 5. 갭 분석 종합

| 갭 | 우선순위 | 작업 |
|---|---|---|
| `reactive` 가 외부 검증 base 없이 toy | 🔴 P0 | Vercel AI SDK `prepareStep` 차용 → naia-agent 의 `Agent.sendStream` 안에 통합 |
| `realtime` 가 외부 base 없이 자체 rolling | 🔴 P0 | Mastra working-memory tool pattern 차용 + Mem0 fact extraction + naia anchored iterative 합성 |
| `anthropic-native` 가 실 API 안 호출 | 🟠 P1 | `@ai-sdk/anthropic` + 베타 header 활성 |
| `off` 가 production cost 시뮬 X | 🟠 P1 | hard-truncation 시뮬 in `runner.ts evaluateProbe` 또는 strategy 자체에 wire |
| 외부 baseline 비교 없음 | 🟡 P2 | LongMemEval-S 영문 fixture 일부 차용 + 실 측정 |
| 한국어 측정만 = 외부 비교 어려움 | 🟡 P2 | 영문 LongMemEval-S subset 도 측정 (head-to-head 위해) |

---

## 6. 3-주 plan

### Week 1 — `reactive` adoption + measurement

**Phase 1.1**: Vercel AI SDK `prepareStep` + `pruneMessages` 차용
- `packages/runtime/src/compaction/vercel-prepare-step.ts` 신규
- `naia-memory.compact()` 결과를 `pruneMessages` 의 input 으로 변환
- `Agent.sendStream` 안에 `prepareStep` 통합
- **AI 리뷰** (4 CLI, 사용자 셸 또는 wrapper script 통해)

**Phase 1.2**: 측정
- 동일 한국어 5 fixture + 영문 LongMemEval-S 일부 (10 question)
- 4-judge ensemble 사용
- baseline 비교: OMEGA / Memoria / RetainDB 와 head-to-head (가능 범위 내)

### Week 2 — `realtime` adoption + naia 차별화

**Phase 2.1**: Mastra working-memory pattern 차용
- LLM tool `updateWorkingMemory` 등록 (naia-agent skill 으로)
- Markdown working memory state in naia-memory
- **AI 리뷰**

**Phase 2.2**: Mem0 fact extraction 차용
- 매 encode() 시 (subject, predicate, object) 추출
- 추출된 fact 를 `Known facts: ...` inline 으로 recap 에 명시
- **AI 리뷰**

**Phase 2.3**: naia 차별화 (anchored iterative + handoff 통합)
- 기존 priorRecap 패턴 강화: working memory + facts 둘 다 merge
- 측정 + Mem0 92.5 J-score 와 비교 가능 (LoCoMo subset)
- **AI 리뷰**

### Week 3 — `anthropic-native` 활성 + 통합 측정

**Phase 3.1**: `@ai-sdk/anthropic` 베타 header
- `compact-2026-01-12` 활성 옵션
- backend=anthropic + Opus 4.6+ 시 자동 활성

**Phase 3.2**: `off` hard-truncation 시뮬

**Phase 3.3**: 전체 통합 측정
- LongMemEval-S 일부 (50 question 정도) + 한국어 5
- 4 strategy × 4 judge × ~55 fixture = ~880 LLM call (cost-aware)
- 결과 vs published baseline 비교 ledger

---

## 7. Ralph 루프 (사용자 directive)

각 phase 마다:
1. 개발 (외부 base 차용)
2. **AI 리뷰** (4 CLI cross-review, wrapper script 또는 사용자 셸)
3. 리뷰 반영 → 개발 진행
4. **통합 개발 승인** (사용자 게이트)
5. **벤치마크 수행** (4-judge ensemble + 한국어 + 영문 LongMemEval subset)
6. 결과 분석 + 개선
7. 다시 측정 (반복)

2-consec PASS 또는 사용자 OK 까지 반복.

---

## 8. 이슈 + worktree 구조 (다음 액션)

| Resource | 경로 |
|---|---|
| Worktree | `../naia-agent-worktrees/slice-compact-v2/` (`migration/slice-compact-v2` branch) |
| Umbrella issue | nextain/naia-agent#? (신규) — "Slice 3-XR-Compact v2 — 외부 검증 base 차용 + 객관 비교" |
| Phase issues | #?+1 (reactive Vercel adoption), #?+2 (realtime Mastra+Mem0 adoption), #?+3 (anthropic-native 활성), #?+4 (off hard-truncation), #?+5 (외부 baseline 비교 측정) |

---

## 9. 폐기 / 보존

| 보존 | 폐기 |
|---|---|
| 4-judge ensemble harness (GLM thinking fallback + 3 CLI) | 보고서 "compaction wins/loses" 결론 (의미 없음) |
| 한국어 5 fixture (F-KR-IE/MS/TR/KU/AB) | toy 5-section markdown recap (외부 base 로 교체) |
| `--compact-strategy` flag + env 인프라 | naia-memory `compact()` 의 deterministic recap (Vercel `prepareStep` + LLM polish 로 교체) |
| LongMemEval 5-ability taxonomy 차용 | 자체 anchored iterative + 5-section (Mastra + Mem0 patterns 합성으로 교체) |

---

## 10. 진행 신호

사용자 directive (2026-05-21 누적):
- "객관적 벤치 만들고 비교대상"
- "reactive = 외부 검증된 로직 차용"
- "realtime = 외부 유사 개념 + 우리 아이디어 + 최선"
- "다른 ai 와 현재상태/의도 전달 + 갭분석 + 외부조사 + ref 분석 + 3자 토론"
- "naia-agent 워크트리 만들어서 진행"
- "이슈 + 페이스 + Ralph 루프 + 개선 연구"

본 plan 이 그 모두의 시작점. 다음 step = worktree 생성 + 이슈 생성.
