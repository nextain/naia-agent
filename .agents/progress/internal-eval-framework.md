# Internal Eval Framework — 압축 알고리즘 객관 평가 체계

**Status**: ACTIVE — R8.0 commit (R7 인프라 정리)
**위치**: `packages/benchmarks/`

---

## 1. 평가 체계의 의미

압축 알고리즘 (LLM-based, deterministic, prune, etc) 을 객관 측정하기
위한 framework. **ship 의 객관적 검증 기준** + **회귀 측정** 두 목적.

> 사용자 directive: "평가가 없으면 개선할수 없잖아" (2026-05-21)

---

## 2. 구성 요소

### 2.1 공유 visible context 빌더 — `src/visible-context.ts`

같은 fixture 에 같은 strategy 적용 시 **같은 visible string** 생성 보장.
runner.ts (deterministic 평가) + mini-bench-judge.ts (LLM 평가) 양쪽
호출. divergence 봉쇄.

### 2.2 Probe stress 분류 — `classifyProbeStress`

각 task-accuracy probe 가 **strategy 를 진짜로 stress 하는지** 분류:

| 분류 | 의미 |
|---|---|
| `recap-only` | 답을 위한 fact 가 모두 recap range 안 → strategy 가 정말 압축 잘 해야 함 |
| `tail-trivial` | fact 가 preserved tail 안에도 있음 → strategy 무관 답 가능 |
| `no-compaction` | compactionPoint 미달 → 압축 자체 안 일어남 |
| `unclassified` | factTurns 미명시 (abstention 등) |

→ **"recap-only" 컬럼만 strategy quality 신호**. 나머지는 보조.

### 2.3 4-judge LLM ensemble — `src/judges/`

GLM HTTP + opencode/codex/gemini CLI 4 judge 동시 호출. majority-of-valid
vote. infra-error (timeout 등) 는 denominator 에서 제외.

### 2.4 Strategy 별 명시 라벨

| Flag | 의미 |
|---|---|
| `recapNoOp: true` | 압축 호출했으나 recap 비어있음 — 측정 결과 의심 |
| `vercelNoOp: true` | (특수) Vercel pruneMessages 가 undefined 반환 |

→ no-op artefact 가 결과 표에 자동 노출.

### 2.5 Fixture 셋

| 카테고리 | 개수 | 비고 |
|---|---:|---|
| 한국어 (F-KR-*) | 5 | 5 ability (IE/MS/TR/KU/AB) × 1-2 task probe |
| 영문 tool-heavy (F-EN-TH-01) | 1 | thinking/tool_use 마커 포함 |
| LongMemEval-S sample (F-LME-*) | 3 | 영문, 2-5 turn 짧음 (smoke only) |
| **총** | **9** | 9/9 validate pass |

각 fixture 의 task-accuracy probe 에 `factTurns` 명시 (1-based 인덱스).
strict validateFixture 가 `afterTurn ≤ turns.length + 1`, `factTurns[i] ≤ turns.length`, `compactionPoint ≤ turns.length` 강제.

### 2.6 적대 audit harness — `scripts/adversarial-audit.ts`

verdict-mode 폐기. raw code/test audit primary. 매 ship 전 자동 호출.
`--target` + `--files` 인자로 audit 대상 명시.

---

## 3. Strategy 슬롯 (R8 에서 채울)

| ID | 정체 | LLM | 상태 |
|---|---|:---:|:---:|
| `off` | 압축 안 함 + 1200-char cap | - | 유지 (baseline) |
| `vercel-prune` | Vercel cookbook `pruneMessages` (R7 의 reactive-vercel rename 권장) | ✗ | 유지 (prune-only 라벨) |
| **R8 후보 1** | (조사 결과로 채워질 LLM-based summarization 1) | ✓ | 차후 |
| **R8 후보 2** | (조사 결과로 채워질 LLM-based 2) | ✓ | 차후 |
| **R8 후보 N** | ... | ✓ | 차후 |
| **`naia-realtime`** ★ | naia-memory + 차용 압축 통합 | ✓ | R8.3 |

→ R7 의 `reactive` (deterministic naia-memory) + `realtime` (deterministic rolling) 은 폐기 또는 baseline 으로 강등.

---

## 4. 측정 protocol

### 4.1 단일 fixture 측정

```bash
source /home/luke/alpha-adk/data-private/llm-keys/llm.env
pnpm --filter @nextain/agent-benchmarks exec tsx \
  scripts/mini-bench-judge.ts F-KR-IE-01-information-extraction
```

생성: `reports/<date>-mini-bench-judge-<fxid>.md`

### 4.2 전체 fixture 측정

`.agents/work/r7-final-aggregate.sh` 같은 wrapper.

### 4.3 결과 표

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 |

→ **recap-only 컬럼만 strategy quality 신호**.

### 4.4 적대 audit (ship 전 필수)

```bash
pnpm --filter @nextain/agent-benchmarks exec tsx \
  scripts/adversarial-audit.ts \
  --target "R8.X-ship-check" \
  --files "<관련 코드 파일들>"
```

생성: `reports/adversarial-audit-<timestamp>.md`. 2/4 valid AI + Claude
subagent 권장.

---

## 5. 알려진 한계

| 한계 | 영향 | 대응 |
|---|---|---|
| **N=1 per cell** | judge 1번 timeout 시 PASS↔FAIL flip | N≥3 replication R8 에서 도입 권장 |
| **naia-memory deterministic recap 한국어 fact-empty** | reactive (R7 구) 측정 무의미 | R8 의 LLM-based strategy 들로 대체 |
| **LongMemEval-S 3 sample = smoke** | strategy 측정 불가 | HF dataset 다운로드 시 측정 가능 |
| **judge prompt "simulate mentally"** | inter-judge variance 가능 | R8.2 측정 결과 모니터링 |
| **fixture N=9** | 일반화 어려움 | naia-os ship 시 추가 fixture 작성 |

---

## 6. R7 결과의 평가

| R7 자산 | 평가 framework 에서 가치 |
|---|---|
| `buildVisibleContext` | **핵심 인프라** ✓ |
| `classifyProbeStress` | **핵심 인프라** ✓ |
| Fixture 9개 + factTurns | **테스트 자산** ✓ |
| 4-judge ensemble | **핵심 인프라** ✓ |
| `adversarial-audit.ts` | **검증 인프라** ✓ |
| R7 4-strategy 비교 표 | ❌ 폐기 (LLM-less stub 비교) |
| R7 코드 자산 일부 | `createLLMMessagePrepareCompact` 등 helper 는 유지, `reactive`/`realtime` deterministic 구현은 폐기 |

→ **인프라 valid, 결과 표 invalid**. R8 에서 인프라 재사용.

---

## 7. ship 기준

naia-os 에 컴팩션 ship 하려면 ≥3 개 조건 만족:

1. **선택 strategy 가 평가 framework 의 recap-only 컬럼에서 baseline (off) 이상**
2. **`recapNoOp: true` 가 0 fixture** (실제로 압축 동작)
3. **적대 audit 결과 HALT 0 / MAJOR ≤2** (해결책 명시)

→ 객관 검증 없이는 ship 안 함.

---

## 8. 다음

- R8.1 조사 결과 (BG cross-review) → 후보 strategy 식별
- R8.2 후보들 strategy 슬롯에 wire-in + 평가 측정
- R8.3 최선 + naia-memory 통합 설계
- R8.4 naia-os ship + 평가 framework 로 ship 검증
