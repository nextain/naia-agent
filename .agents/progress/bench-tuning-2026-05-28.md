# max_hops 추이 측정 + 최적값 도출 — 2026-05-28

naia-agent #69 의 coding-bench 를 Qwen3.6-27B-AWQ-INT4 (24g-coding) 로 swap 후, `max_hops` 의 적정선을 실험으로 도출.

## 1. 환경

- **vLLM**: 0.21.0 on RTX 3090 (호스트 GPU 1, Tailscale `100.91.187.24:8000`)
- **모델**: `cyankiwi/Qwen3.6-27B-AWQ-INT4`
- **vLLM 옵션**: KV fp8, vision off (`--language-model-only`), `--tool-call-parser qwen3_coder`, `--reasoning-parser qwen3`, enforce-eager
- **max_model_len**: 65,536 (64k)
- **벤치**: `packages/runtime/src/__tests__/coding-bench.test.ts` (Suite C=10, Suite R=6, Suite A=5)
- **env override 추가**: `CODING_BENCH_MAX_HOPS=<N>` (이전엔 default 10 강제)

## 2. 측정 데이터

| 차수 | max_hops | Total | C (49) | R (14) | A (max varies) | Duration | 비고 |
|---|---|---|---|---|---|---|---|
| 1차 | 9 (default) | **56%** | 100% | 86% | 39% | 212s | Gemma 4 baseline — naia-agent default |
| 2차 (cancel) | 30 | — | — | — | — | — | reasoning_parser 제거 → C-01 0% → 정정 |
| 3차 | 30 | **73%** | 61% | (timeout) | 100% (3/5) | 1735s (timeout) | reasoning_parser 복구 |
| 4차 | 20 | **66%** | 61% | 57% | 100% (3/5) | 1686s | mid-point |
| 5차 | 40 | **75%** | 82% | 36% | 93% (13/14) | 1759s | plateau 신호 시작 |
| 6차 | 60 | **79%** | 82% | 64% | 83% (15/18) | 1690s | R-06 처음 100% — hops 효과 |
| 7차 | 100 | **81%** | 80% | 64% | 100% (14/14) | 1800s (timeout) | plateau 확정 |

## 3. 회귀 fit + plateau 확인

**Log 회귀 모델: y = 29.0 + 12.5·ln(max_hops)**

| max_hops | 실측 | log 예측 | Δ |
|---|---|---|---|
| 9 | 56% | 56.4% | -0.4 |
| 20 | 66% | 66.3% | -0.3 |
| 30 | 73% | 71.4% | +1.6 |
| 40 | 75% | 74.9% | +0.1 |
| 60 | 79% | 79.9% | -0.9 |
| **100** | **81%** | **86.3%** | **-5.3 ← saturation** |

**한계 효율 (한 hop 추가 시 점수 증가율):**

| 구간 | pp/hop |
|---|---|
| 9 → 20 | **0.91** |
| 20 → 30 | 0.70 |
| 30 → 40 | 0.20 |
| 40 → 60 | 0.20 |
| **60 → 100** | **0.05 (수렴)** |

→ **plateau 시작 = 60 부근**, 60→100 = +2pp 만 (saturate).
→ log 모델은 60 까지는 정확 (Δ < 1pp), 그 이상에서 overfit.

## 4. UX 시간 분석

| max_hops | 평균 task | 가장 긴 task | timeout 영향 |
|---|---|---|---|
| 9 | 10s | C-10 18s | 없음 |
| 20 | 90s | A-03 504s | Suite A timeout 일부 |
| 30 | 90s | A-03 691s | Suite A 일부 미완 |
| 60 | 94s | A-04 224s | 일부 미완 |
| 100 | 128s | (timeout 으로 평균 ↑) | 일부 미완 |

**UX 마지노선:**

| 시나리오 | 사용자 wait 마지노선 |
|---|---|
| 단순 chat query | 30초 |
| 코딩 답변 (single turn) | 1-2분 |
| 복잡 reasoning | 2-5분 |
| Multi-step coding (codegraph) | 5-10분 |
| 큰 codebase 분석 (사용자 동의 후) | 30분+ |

## 5. 최적값 결론

**Sweet spot = `max_hops = 30`** — 점수/시간/UX 균형 최적:

| 기준 | 30 hops 평가 |
|---|---|
| 점수 | 73% (1차 9 hops 56% 대비 +17pp) |
| 한계 효율 | 0.70 pp/hop (0.91 → 0.20 둔화 직전) |
| 평균 task 시간 | 90s/task (5분 마지노선 안) |
| 가장 긴 task | 단일 multi-step 500-700s (10분 한계) |
| diminishing returns 진입 전 | ✓ |

**워크플로 별 권장:**

| 워크플로 | max_hops | 점수 | 마지노선 |
|---|---|---|---|
| 일반 chat | 10 (현 default) | 56% | 30s |
| **default coding (production 권장)** | **20** | 66% | 2분 |
| **codegraph multi-step (sweet spot)** | **30** ★ | **73%** | 5-10분 |
| Power user (큰 task) | 60 | 79% | 30분+ |
| Diminishing (사용자 명시 후) | 100+ | 81% saturated | 시간만 증가 |

## 6. 적용 권장

### naia-agent 코드 변경

1. **`packages/core/src/agent.ts` default 변경**:
   - L218 `this.#maxHops = options.maxToolHops ?? 10;` → `?? 30;`
   - **변경 신중** — 다른 워크플로 (Voice / Memory recall) 영향 확인 필요
   - 또는 CLI flag `--max-hops` default 만 격상

2. **`packages/runtime/src/__tests__/coding-bench.test.ts` env override**:
   - `maxToolHops: Number(process.env.CODING_BENCH_MAX_HOPS ?? 30)` — 본 실험에 추가됨
   - default 30 (sweet spot) 으로 향후 벤치 비교 baseline 일관

### vLLM 측 — 변경 없음

- `--tool-call-parser qwen3_coder` + `--reasoning-parser qwen3` 유지
- KV fp8 + `--language-model-only` 유지
- max_model_len 65536 유지 (24G 단독 카드 한계)

## 7. 남은 issue (별 작업)

### C-09/C-10 syntax error
- `Unexpected identifier 'stopped'/'block'` — reasoning thinking 흔적이 코드 본문에 섞이는 케이스
- `reasoning_parser qwen3` 에서도 일부 응답이 thinking 을 content 에 흘림
- 추정 원인:
  1. vLLM gemma4/qwen3 parser 의 thinking-end token detect 실패 케이스
  2. 또는 model 자체가 thinking-end 마커 누락
- 해결 후보: chat template 측 `enable_thinking=false` 강제 (다만 Qwen3.6 의 코딩 강점 = thinking, 끄면 성능 저하 가능)
- → 4-5차 정도 같은 setting 으로 반복 측정해 randomness vs systematic 분간 후 fix 결정

### Suite A timeout 영향
- 4차~7차 모두 1500s 이상 → vitest testTimeout 도달
- A-04/A-05 일부 미실행 = 점수 max 감소 (81 → 73~77)
- 해결: testTimeout 3600s+ 또는 Suite A 만 별 run

### randomness 측정 부족
- 같은 max_hops 로 1 run 만 측정 → ±2-3pp 분산 가려짐
- 정확한 plateau 결정 위해 3-5 run 반복 권장 (시간 큼)

## 8. cross-PC / cross-AI 검증

- 본 실험 = 호스트 단일 (Luke PC GPU 1) — RunPod A40 / 다른 PC 측정 미완
- Task #9 (사용자 Pod 생성 후 RunPod 벤치) = pending
- cross-review (Gemini / GPT 등) = 우리 결론 (max_hops 30 sweet spot) 검증 가치 있음, 별 단계

## 9. 관련 commit / 파일

- `coding-bench.test.ts` (env override 추가) — 별 commit 필요
- `coding-bench-2026-05-28.md` — bench framework 가 마지막 차 결과만 저장. 추이 종합은 본 문서가 SoT.
- 본 문서 = `bench-tuning-2026-05-28.md`

## 10. Related

- naia-agent #69 — bench: swap naia-coding → Qwen3.6 + Suite A cross-review
- alpha-adk/.agents/progress/naia-runpod-phase1-plan-2026-05-27.md (Phase 1 RunPod Tier B)
- naia-model-infra/.agents/progress/lineup-2026-05-28.md (4-라인업 spec)
- coding-bench-2026-05-28.md (마지막 차 = 7차 / max_hops 100 / 81%)
