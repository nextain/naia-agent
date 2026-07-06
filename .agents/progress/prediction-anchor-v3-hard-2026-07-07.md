---
session_id: ed6b7ccc-5cb7-49a3-b4d8-0ef998fcb205
topic: 예측 앵커 v3 — 난도 올려 100% 천장 깨기 시도 (결과: 천장 유지, 진짜 난도 축 진단)
date: 2026-07-07
status: run complete (base) + stress partial (transient fail) — ceiling NOT broken, diagnosis captured
runner: examples/prediction-anchor-v3.ts (PREDICT_LIVE=1, PREDICT_NOISE=N knob)
prev: prediction-anchor-first-probe-2026-07-06.md (v1/v2)
---

# 예측 앵커 v3 (난도↑) — 2026-07-07

## 0. 목표 (루크 "v3로 난도 올려서 진행해")
v2 가 memory=100% 천장을 친 이유 = seed 가 취향을 **명시**하고 상황이 **뻔한 적용**. v3 는 네
레버로 난도↑: **암시(행동서 추론)·잡음(신호 매장)·recency(취향 변화→최신 우선)·nuance(단순
적용하면 오답)**. 목표 = A<100% 밴드를 열어 persona 형성의 *정도(gradient)* 측정 준비.

## 1. base 결과 (8 시나리오, N=5, 보기순서 무작위)
| | 정확도 | pickedA |
|---|---|---|
| A memory-injected | **40/40 (100%)** | 50% |
| B blind baseline | **30/40 (75%)** | 60% |
| lift | **+25pp** | |

signal 회상: **8개 전부 5/5**(H-07 noise-buried[8 distractor] 포함). per-scenario blind:
H-01채식 0 · H-05다이어트override 0 · 나머지 6개 5/5.

## 2. 정직한 결론 — 천장 안 깨짐, 그러나 더 중요한 진단
- **메모리는 암시·recency·nuance·잡음(8)을 전부 100% 처리.** gemini+메모리가 행동에서 취향을
  추론하고, 최신 상태를 쓰고, 맥락 nuance("일=계획/여행=즉흥")를 구분함. 강건함의 증거지만,
  내 난도 레버가 **메모리 조건을 못 흔들었다**.
- **진짜 변수는 메모리가 아니라 baseline.** lift 는 **취향이 population 기본값과 갈리는 2개**
  (암시적 채식·다이어트 override)에서만 발생 — 거기선 blind 0/5, 메모리 5/5. 나머지 6개는 정답이
  gemini 의 상식적 기본값과 **우연히 일치**해 blind 가 공짜(75%). v2(44%)→v3(75%)로 blind 가
  오른 건 시나리오가 우연히 기본값-정렬됐기 때문.
- **회상 축은 안 건드려짐.** signal 5/5 = Lite cosine 이 신호를 안 놓침.

## 3. stress 패스 (PREDICT_NOISE=30) — partial, transient 실패
generic filler 30개를 매 시나리오에 매장해 회상을 굶기려 시도. **전 구간 sig=Y**(12+ trial 관측)
후 embed ~1400콜 중 게이트웨이 **"fetch failed"(일시 네트워크)**로 중단. 로직 오류 아님.
- **소견**: generic 잡음 30개로도 Lite cosine 은 신호를 안 놓침(recallQuery 가 신호와 의미적으로
  가깝고 filler 는 무관해 코사인이 쉽게 분리). **회상을 굶기려면 generic 잡음 증량으론 부족.**
- **재실행 안 함**(cost-awareness): embed 1400콜 재소모 + flaky. partial + base 로 결론 충분.

## 4. 진단 = 천장을 깨려면 (v4 후보, 루크 결정)
"추론을 더 어렵게" 는 유능한 모델엔 안 통함. 메모리 <100% 밴드를 여는 진짜 축:
- **(a) 적대적 회상(adversarial retrieval)**: recallQuery 와 **의미적으로 가깝지만 취향과 무관한**
  distractor 로 top-k 를 오염 → 신호가 실제로 밀려남 → 회상실패로 메모리 하락. 실 메모리시스템
  속성(규모/혼동 하 회상) 시험. sig-tracking 으로 회상실패 vs 사용실패 분리 가능.
- **(b) 진짜 취향 충돌(genuine conflict)**: 두 취향이 probe 에서 상충, 둘 다 회상됨 → 모델이
  *가중*해야 함. ground-truth 는 seed 의 명시적 우선순위로 객관화(모호성 관리 필요).
- **(c) 자아특이성(self-specificity, 진짜 persona 측정)**: A 사용자로 형성된 메모리로 A 를
  예측(high) vs B 를 예측(low, 틀린 사람 기억이 오히려 오도) 교차 행렬. 메모리가 **사용자-특이**
  임을 증명 — persona 형성의 핵심 측정.

## 5. 커밋
- examples/prediction-anchor-v3.ts (HARD 8 시나리오 + PREDICT_NOISE 스트레스 노브). base 라이브
  40×2 검증, stress partial.
- 이 문서.

## 6. 한 줄
난도를 "추론 어려움" 으로 올린 v3 는 메모리의 강건함만 재확인시켰다. 천장을 깨는 건 **적대적
회상 / 취향 충돌 / 자아특이성** — 셋 다 설계 판단이 필요해 루크에게 넘긴다.
