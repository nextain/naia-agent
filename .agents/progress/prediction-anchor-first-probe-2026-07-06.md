---
session_id: ed6b7ccc-5cb7-49a3-b4d8-0ef998fcb205
topic: 예측 앵커 first-probe — 메모리가 held-out 사용자 선택 예측을 끌어올리나 (과적합 해독제)
date: 2026-07-06
status: first-probe run (positive direction, honest confounds) — NOT a slice
sot: naia-behavior-emergent-not-filtered.md §측정=proxy / HANDOFF-persona-formation §6 ①
runner: examples/prediction-anchor-bench.ts (PREDICT_LIVE=1)
---

# 예측 앵커 first-probe (2026-07-06)

## 0. 왜 (루크 2026-07-06)
"타 기억 대비 우수"라는 절대·경쟁 프레임은 검증이 어렵고 필터로 미끄러진다. 검증을 쉽게
만드는 건 **상대(ablation) + 예측**이다. 루크의 **과적합 우려**에 직접 답하는 축: held-out
에서 메모리가 예측을 끌어올리면 **일반화(진짜 길들임)**, 표면만 외웠으면 과적합 — 이 구분이
측정으로 드러난다. ⚠ 예측정확도는 proxy이지 telos 아님(SoT) — 바닥 증거로만.

## 1. 설계 (examples/prediction-anchor-bench.ts)
- **A = memory-injected**: 사용자의 과거 취향 발화를 Lite(cosine) 회상해 컨텍스트로 주입.
- **B = blind**: 메모리 없음, 같은 probe·같은 모델(gemini-3.5-flash).
- **과적합 가드**: 각 probe 는 seed 와 **어휘가 전혀 안 겹침**(채식 seed → 갈비/수제비 투표
  probe). 맞히려면 취향을 *일반화*해야 함 — 문자매칭 불가.
- **객관 채점**: `예측: A|B` 강제 포맷 파싱 → 취향-일관 선택과 대조. 도덕/적절성 필터 아님,
  순수 예측정확도. 위치편향 완화 = 정답을 B/A/B 로 섞음.
- 3 시나리오: PA-01 채식(정답 B=수제비), PA-02 카페인 민감(정답 A=캐모마일),
  PA-03 아침형(정답 B=아침 등산). N=5, temp 0.7.

## 2. 결과
| | 정확도 | retrieved |
|---|---|---|
| **A memory-injected** | **15/15 (100%)** | 15/15 |
| **B blind baseline** | **5/15 (33%)** | — |
| **memory lift** | **+67pp** | |

per-scenario: PA-01 A5/5 · B0/5 | PA-02 A5/5 · B5/5 | PA-03 A5/5 · B0/5.

## 3. 정직한 해석 (신호 vs 아티팩트)
- **진짜 신호 (PA-01, PA-03)**: 메모리가 novel·비겹침 상황에서 취향을 일반화해 맞힘
  (채식→수제비, 아침형→등산). blind 는 0/5 로 틀림. seed 에 "수제비/등산" 이 없으므로
  **문자매칭이 아니라 일반화** = 과적합 아님. 예측 앵커가 이 구분을 실제로 잡아냄. ✓
- **confound (PA-02)**: blind 가 **매번 "A"만 찍는 위치 편향**을 보임. PA-02 정답이 우연히
  A → blind 5/5 "정답"은 예측이 아니라 편향의 우연. 따라서 blind 의 33% 는 **부풀려진**
  값이고, 실질은 **메모리 3/3 vs blind 1/3(기본옵션 prior)**.
- **표본·검정력 한계**: temp 0.7 이지만 시나리오별 A/B 예측이 5런 내내 동일 → N=5 가 통계적
  변별력을 거의 안 더함. 실질 데이터 = **3 시나리오**. 100% vs 33% 는 3점 위의 값.
- **회상 15/15**: Lite cosine 이 2개짜리 seed 를 안정 회상(당연). 회상 자체는 병목 아님
  (salience 벤치와 동일 결론) — 값은 "회상된 과거가 예측을 바꾸나"에 있음.

## 4. 결론 (이 probe 의 값)
- **방향은 깨끗한 positive**: 사용자의 과거를 주입하면 예측이 generic 기본값 → 취향-일관
  선택으로 뒤집힌다(held-out·비겹침). **메모리 = 사용자의 예측모델**이라는 명제의 첫 실증.
  과적합 가드 통과 = 길들임(일반화)이지 암기가 아님.
- **예측 앵커는 "검증을 쉽게" 해준다**(루크 질문에 대한 답): 객관 정확도 + ablation 이라
  절대 rubric·외부 SOTA 없이 신호가 잡힘. **다음 실험(persona 형성)의 1순위 측정축 확정.**
- **v2 로 강화할 것 (다음 세션)**: (a) blind **위치편향 제거** — 보기 순서 무작위화 +
  중립 prior baseline. (b) 시나리오 **10+** 로 확장(검정력). (c) temp/런 재설계로 진짜 분산.
  (d) naia provider(salience) vs Lite 비교 — 예측엔 회상 내용이 관건이라 차이 작을 것으로 예상.
  (e) 진짜 목표축(persona): "A 사용자로 형성된 naia 가 B 사용자를 예측 못 하나"(자아 특이성).

## 5. 커밋
- examples/prediction-anchor-bench.ts (신규 러너, opt-in PREDICT_LIVE). 라이브 15×2 검증됨.
- 이 문서. HANDOFF §6 ① 에 first-probe 결과 포인터.
