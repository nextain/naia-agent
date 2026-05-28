# Cross-model coding-bench 비교 — 2026-05-28

#69 의 max_hops sweep 후, 동일 harness (`coding-bench.test.ts`, `max_hops 30`) 로 4 라인업 default 후보 + 외부 모델 sequential 측정.

## 1. 측정 환경

- **Harness**: `packages/runtime/src/__tests__/coding-bench.test.ts`
- **`max_hops`**: **30** (sweet spot, #69 sweep 도출)
- **`testTimeout`**: 2400s
- **Suite**: C (Code Gen, 10 task / 49 점) + R (Reasoning, 6 task / 14 점) + A (Agent Tool Use, 5 task / 18 점) = **총 81 점 만점** (정상 측정 시)
- **Provider 분기**: bench framework 가 env 별 자동 — `GEMINI_API_KEY` → Vercel AI SDK Google, `GLM_API_KEY` → BIGMODEL OpenAI-compat, `OPENAI_API_KEY + OPENAI_BASE_URL` → 일반 OpenAI-compat (호스트 vLLM / ollama 등)

## 2. 결과 — 측정 완료 5 모델

| 모델 | Provider | C / 49 | R / 14 | A / 18 | Total | Duration | Cost | 비고 |
|---|---|---|---|---|---|---|---|---|
| **24g-coding** Qwen3.6-27B-AWQ-INT4 (max_hops 60, 최고치) | vLLM 호스트 GPU 1 | 40 (82%) | 9 (64%) | 15 (83%) | **64/81 = 79%** | 1690 s | $0 (로컬) | tool 강함, reasoning thinking 잔재로 C/R 손해 |
| **24g-audio** Gemma 4 E4B Q8_0 | ollama 호스트 GPU 0 | 49 (100%) | 13 (93%) | 10 (56%) | **72/81 = 89%** | 1473 s | $0 (로컬) | thinking 모드 없음 → C/R 만점급, tool 약함 |
| gemini-2.5-flash | Google API | 49 (100%) | 8 (57%) | **0 (skip)** | **57/63 = 90%** | 119 s | $0.00516 | A 측정 누락 |
| gemini-3.1-flash-lite | Google API | 49 (100%) | 14 (100%) | **0 (skip)** | **63/63 = 100%** | **22 s** ★ | $0 | A 측정 누락, 가장 빠름 |
| gemini-3.5-flash | Google API | 49 (100%) | 14 (100%) | **0 (skip)** | **63/63 = 100%** | 121 s | $0 | A 측정 누락 |

### Suite A skip 이슈 — Gemini 측 일관 발생

`gemini-*` 3 모델 모두 Suite A (BM-B2) 가 **실행 0건** — denominator 가 63 (max 81 에서 -18 = Suite A 빠짐). bench framework 의 Gemini provider 분기 (`@ai-sdk/google`) 가 tool calling 흐름과 비호환 가능성. 별 issue 로 진단 + 수정 필요.

## 3. 표준화 비교 — Suite C+R 만 (63 점 만점)

Gemini 의 Suite A 결손 보정 위해 C+R 만으로 비교:

| 모델 | C+R / 63 | Pct | Duration | 비고 |
|---|---|---|---|---|
| gemini-3.1-flash-lite | 63/63 | **100%** ★ | 22 s | 빠르고 정확 |
| gemini-3.5-flash | 63/63 | **100%** | 121 s | 동률, 더 느림 |
| 24g-audio Gemma 4 E4B | 62/63 | **98%** ★ | (Suite C/R 부분 ~600 s) | 로컬 무료, 거의 만점 |
| gemini-2.5-flash | 57/63 | 90% | 119 s | R 57% 가 발목 |
| 24g-coding Qwen3.6-27B (max_hops 30 동조건) | (사전 측정 = 73% total, C 61%, R ~57%) | ~73% | 1735 s | reasoning thinking 잔재 손해 |

**관찰:**

1. **Gemini 3.x 세대 (3.1-lite + 3.5-flash) 가 우리 코딩 벤치 만점급** — 클라우드 SOTA 의 강력함 확인.
2. **24g-audio Gemma 4 E4B 가 의외로 강함 (98%)** — thinking 모드 없음 → 코드 추출 깔끔 → 우리 환경에서 페널티 없음. 단 tool 약 (A 56%).
3. **24g-coding Qwen3.6-27B (4비트) 가 우리 환경에서 페널티** — reasoning thinking 흔적이 C-09/10 같은 task 코드에 섞임. SWE-bench 77.2 의 base 능력은 살아있지만 ext racted 점수는 동위 환경 모델 (E4B) 보다 낮아짐.
4. **Cost** — Gemini 3.x 는 free tier 처리 ($0), 로컬 = $0. 2.5-flash 만 paid ($0.005/run).
5. **Speed** — Gemini 3.1-lite 22 s 가 가장 빠름. 로컬 vLLM 의 30분 vs 22 s = **80× 차이** — cloud API + LLM 인프라 효율.

## 4. 측정 미완 모델

| 모델 | 사유 | 게이트 |
|---|---|---|
| **glm-4.7** | 잔액 부족 (`1113: 余额不足或无可用资源包`) | 사용자 BIGMODEL 충전 |
| **glm-5.1** | 동일 | 동일 |
| **Claude CLI** (구독 SDK) | bench framework 에 `claude-code` backend 분기 미통합 | 별 commit — `NAIA_AGENT_CLAUDECODE_LIVE` env hook (Slice 3-XR-H/M) 재사용 |
| **48g-coding A40** (Qwen3.6-27B 4비트/8비트) | RunPod Pod 미생성 | 사용자 직접 Pod 생성 + endpoint URL |
| **48g-audio A40** omni | RunPod Pod 미생성 | 사용자 직접 |

## 5. naia-coding 라인업 default 결정 함의

| 라인업 | 후보 모델 | 본 측정 점수 | 권장 |
|---|---|---|---|
| **24g-coding** (단일 24G) | Qwen3.6-27B-AWQ-INT4 | C+R 78% / A 83% (max_hops 60) | **유지** — tool 강함 (codegraph 워크플로 정합) |
| **24g-audio** (단일 24G + cascade) | Gemma 4 E4B | C+R 98% (no-tool 강함) | **유지** — voice cascade 의 small LLM 정합 |
| **48g-coding** (A40 단일) | 후보: Qwen3.6-27B 4비트 / 8비트 / 35B-A3B | 미측정 | **사용자 Pod 측정 후 결정** |
| **48g-audio** (A40 omni) | 후보: Whisper + Qwen3.6-27B + VoxCPM2 | 미측정 | **사용자 Pod 측정 후 결정** |

본 측정 결과는 24g-coding 의 default Qwen3.6-27B 결정 (lineup-2026-05-28.md §2) 을 검증함. tool calling 강점이 우리 워크플로 (codegraph, 에이전트) 정합.

## 6. 알려진 issue (별 fix 항목)

1. **Suite A 가 Gemini provider 에서 실행 0건** — bench framework 의 `@ai-sdk/google` 분기에서 BM-B2 가 skip 되는 원인 파악 필요. tool calling 호출 미동작 또는 chunked tool message 누락 가능성.
2. **vLLM 의 usage capture 0 표시** — In/Out tok 가 모두 0 — stream 의 마지막 usage chunk 를 bench framework 가 못 캡처. vLLM stream usage 옵션 (`stream_options.include_usage: true`) 추가 또는 framework 측 fallback 필요.
3. **24g-coding C-09/C-10 의 thinking residue syntax** — reasoning thinking 흔적이 코드 본문에 섞이는 케이스. 3-5 run 반복으로 randomness 분간 후 vLLM parser fix vs client-side code-extraction hardening 결정.
4. **Suite A 의 vitest 1500 s timeout** — 호스트 vLLM 측정 시 A-04/A-05 일부 미실행 — `testTimeout 2400-3000 s` 격상 권장 (#69 commit 0d31317 의 후속 권장사항 그대로 유효).

## 7. 후속 측정 plan

1. **GLM 충전 후 측정** — glm-4.7 + glm-5.1 (사용자 게이트)
2. **Claude CLI 통합** — bench framework 에 `claude-code` 분기 추가 (Slice 3-XR-H/M 의 NAIA_AGENT_CLAUDECODE_LIVE env hook 재사용) + 측정. 별 commit.
3. **48g 라인업** — 사용자 RunPod A40 Pod 생성 후 동일 harness 로 측정. Qwen3.6-27B 4비트 vs 8비트 vs 35B-A3B 비교.
4. **Suite A Gemini issue fix** — bench framework 의 Google AI SDK 분기에서 Suite A 실행 안 되는 원인 파악 + 수정. fix 후 Gemini 측 81 점 만점으로 재측정.
5. **vLLM usage capture fix** — In/Out tok 정상 표시 위해 stream_options 또는 framework fallback.

## 8. 백업 파일 (모델 별 raw bench report)

- `coding-bench-24g-audio-gemma4-e4b-2026-05-28.md`
- `coding-bench-gemini-2.5-flash-2026-05-28.md`
- `coding-bench-gemini-3.1-flash-lite-2026-05-28.md`
- `coding-bench-gemini-3.5-flash-2026-05-28.md`
- `coding-bench-glm-4.7-2026-05-28.md` (잔액 부족 fail 흔적, denominator 미산정)
- `coding-bench-2026-05-28.md` (마지막 차 = glm-4.7 fail, 본 commit 시점)

24g-coding (Qwen3.6-27B) 의 raw 는 #69 의 commit `0d31317` 에 들어간 `coding-bench-2026-05-28.md` (max_hops 100, 7차) — 그 직전 max_hops 60 (6차) = 79% 가 본 보고서의 24g-coding 점수.

## 9. Related

- naia-agent #69 — bench: swap naia-coding → Qwen3.6 + sweep — **CLOSED 2026-05-28**
- `bench-tuning-2026-05-28.md` (max_hops sweep, #69 의 종합)
- `lineup-2026-05-28.md` (naia-model-infra, 4-라인업 spec — §8 cross-model 비교 plan)
