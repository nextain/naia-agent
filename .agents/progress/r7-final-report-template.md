# R7 Final Measurement Report — Slice 3-XR-Compact v2 (#56)

**Status**: DRAFT (R7 final measurement in progress)
**Branch**: `migration/slice-compact-v2`, HEAD: `b97a7d7`

---

## 1. 무엇을 측정하는가

### 측정 대상

| Strategy | 실제 동작 |
|---|---|
| `off` | host-side compaction 없음, 1200-char cap 적용 (provider truncate 시뮬) |
| `reactive` | naia-memory `compact()` deterministic recap (R7 audit: 한국어 fact-empty 경향) |
| `reactive-vercel` | Vercel AI SDK `pruneMessages` cookbook recipe (R7 audit: plain-text 에서 no-op) |
| `realtime` | naia-memory `compact()` + per-turn `encode()` (R7 audit: 한국어 fact-empty 경향 동일) |

**`anthropic-native` 는 R7 에서 제거** — R1-R5 동안 `return undefined` sentinel 이었음.

### Fixture set (9개)

| ID | Domain | 비고 |
|---|---|---|
| F-KR-IE-01 | information-extraction | 한국어, 4 task probes (3 stress class) |
| F-KR-MS-01 | multi-session | 한국어, 2 task probes |
| F-KR-TR-01 | temporal-reasoning | 한국어, 1 recap-only probe (cleanest) |
| F-KR-KU-01 | knowledge-update | 한국어, 2 task probes |
| F-KR-AB-01 | abstention | 한국어, 1 abstention + 1 recap-only |
| F-EN-TH-01 | tool-heavy | 영문, 2 task probes (LCH-id tail / weather recap) |
| F-LME-test-001/002/003 | LongMemEval-S sample | 영문, 2-5 turns (smoke only) |

### Probe stress 분류 (R7 Phase A4)

- **recap-only**: fact 가 모두 recap range 안 → strategy 가 진짜 압축 필요
- **tail-trivial**: fact 일부가 preserved tail 안 → strategy 무관 답 가능
- **unclassified**: factTurns=[] (abstention 등)
- **no-compaction**: compactionPoint 미달

---

## 2. R1-R5 가 INVALID 였던 이유 (요약)

R6 audit + R7 final audit 가 발견:

| 항목 | R1-R5 | R7 |
|---|---|---|
| `anthropic-native` row | byte-identical w/ `off`, 5 라운드 동안 unnoticed | 제거 |
| `reactive-vercel` no-op | silent fallback to off-shape | 명시 `recapNoOp` flag |
| visible context | runner/mini-bench divergent paths | 공유 `buildVisibleContext()` |
| probe 의 fact 위치 | 명시 안 됨 → tail 안에 답 있어도 측정 | `factTurns` + `classifyProbeStress` |
| validator | lax — 0 probe fixture 도 통과 | strict, task-accuracy + question 필수 |
| domain anchor | 영문 only, 한국어 fixture 항상 fail | factTurns-based 검사로 교체 |

---

## 3. R7 측정 결과

[INSERT R7 RESULTS TABLE]

---

## 4. 정직한 caveat (R7 에서도 미해결)

| 항목 | 의미 |
|---|---|
| **naia-memory 한국어 recap fact-empty** | ASCII regex + 40-char floor → `reactive` / `realtime` 의 한국어 recap = header 만. `recapNoOp` flag 가 측정 보고서에 명시. naia-memory 별 repo 수정 필요. |
| **`reactive-vercel` plain-text 에서 no-op** | cookbook prune 룰이 reasoning/tool 블록 strip. plain text 는 strip 할 게 없음. `recapNoOp` flag 가 명시. F-EN-TH-01 만 실제 prune 적용. |
| **N=1 per cell** | 9 fixture × N=1 ~ N=4 task probes. judge timeout 1번이 PASS↔FAIL flip 가능. confidence interval 없음. |
| **외부 baseline 다운로드 안 됨** | LongMemEval-S 500 question 다운로드는 HF token + ~수GB. 본 측정은 3 sample 만 (smoke). 직접 published OMEGA 95.4% / Memoria ~89% / RetainDB 79% 와 비교 불가. |
| **F-LME-test-* 2-5 turns** | 너무 짧음. strategy 측정 의미 X. adapter 인프라 sanity 만. |
| **deterministic taskAccuracy** | R7 에서 "context-non-empty" sanity 로 격하. strategy quality 는 LLM judge ensemble 만 authoritative. |
| **judge prompt "simulate mentally"** | F7 fix 가 category mismatch 완화했으나 inter-judge variance 발생 가능. |

---

## 5. 결론

[INSERT VERDICT — strategy quality 비교 가능 여부 + caveat 명시]

---

## 6. 다음 단계

1. naia-memory 한국어 recap fix (별 repo PR — Phase B 의 후속)
2. LongMemEval-S full 500 question 다운로드 + 측정 (HF token 필요)
3. Per-fixture multi-probe (N≥3) 보강 — judge variance 측정 가능
4. R7 final audit 의 잔여 MAJOR/MINOR fix (BVC-08 contract test, hard-question 섹션, codex sandbox read-only)
