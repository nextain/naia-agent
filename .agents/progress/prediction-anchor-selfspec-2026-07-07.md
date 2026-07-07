---
session_id: ed6b7ccc-5cb7-49a3-b4d8-0ef998fcb205
topic: 예측 앵커 — 자아특이성 (그 기억이 그 사람의 것인가) = 진짜 persona 측정
date: 2026-07-07
status: run complete — strong clean signal + honest "explicit-seed" caveat
runner: examples/prediction-anchor-selfspec.ts (PREDICT_LIVE=1)
prev: prediction-anchor-v3-hard-2026-07-07.md, prediction-anchor-first-probe-2026-07-06.md
sot: naia-behavior-emergent-not-filtered.md / HANDOFF-persona-formation §6
---

# 예측 앵커 — 자아특이성 (2026-07-07, 루크 "자아특이성으로 진행해")

## 0. 왜 = 진짜 persona 측정
"메모리가 예측을 돕는다"(v1~v3)를 넘어 **"그 naia 가 그 사람의 것인가"** 를 묻는다. 반대 취향
사용자 쌍을 만들어, 각 사용자 X 의 held-out 선택을 세 조건으로 예측:
- **matched**: X 본인 기억 → 맞아야 함
- **mismatched**: **상대방 기억** → 틀린 사람 기억이 오도하나 (probe 보기 = 두 사용자의 선호안이라
  오답 = 기억주인 선호를 예측한 것)
- **blind**: 기억 없음 → 기본 prior baseline

## 1. 결과 (6 쌍 × 2 사용자 × N=3, 보기순서 무작위)
| 조건 | 정확도 |
|---|---|
| **matched (본인 기억)** | **36/36 (100%)** |
| **mismatched (상대 기억)** | **0/36 (0%)** |
| **blind (기억 없음)** | **15/36 (42%)** |

- **자아특이성 = matched − mismatched = +100pp**
- **mismatched 가 blind 보다 42pp 아래** → 틀린 사람 기억은 도움 안 되는 정도가 아니라
  **적극적으로 오도**(예측을 반대 사람 선호로 뒤집음).
- per-pair 완전 일관: 6쌍 모두 matched 6/6, mismatched 0/6, blind 1~3/6.

## 2. 해석 — 무엇을 증명했나
- **메모리는 완전히 사용자-특이(user-specific).** 예측을 이끄는 인과 동력이 generic prior 가
  아니라 **주입된 기억 내용**임이 확정됨 — 다른 사람 기억을 넣으면 예측이 정반대로 뒤집힌다.
  "기억이 곧 그 사람" 을 깨끗이 실증.
- mismatched=0 < blind=42% = 강한 신호: 기억이 없을 때보다 **틀린 기억이 있을 때 더 틀린다**.
  기억이 출력을 지배(dominate)한다는 뜻.

## 3. 정직한 한계 — 메커니즘 vs 창발적 자아
- 이건 **강하지만 쉬운** 데모다. seed 가 **명시적 반대 취향**("나 채식" vs "나 육식")이라,
  결과는 사실상 "주입된 명시 선호가 출력을 지배하나 = 예" 를 보인 것. 거의 정의상 강하게 나온다.
- 따라서 증명된 것 = **측정 하네스가 작동하고, 메모리 주입이 예측을 인과적으로·사용자-특이하게
  지배한다**. 증명 안 된 것 = **창발적으로 *형성된* 자아**(프롬프트 주입이 아닌 dream→LoRA 로
  관계에서 증류된 자아)가 같은 특이성을 보이나. 그건 frozen base + 로컬 LoRA 실험의 몫
  ([[project_naia_dreaming_offline_consolidation]], HANDOFF-persona-formation §1).
- 즉 **이 selfspec 은 그 실험의 측정자(측정 도구)로 검증됐다.** LoRA-형성 자아에 이 지표
  (matched−mismatched, mismatched<blind)를 그대로 적용하는 게 진짜 다음 단계.

## 4. 예측 앵커 아크 요약 (v1 → selfspec)
| 실험 | 물음 | 결과 |
|---|---|---|
| v1 | 메모리가 held-out 예측을 돕나 | +positive, blind 위치편향 confound 발견 |
| v2 | (confound 수정) | +56pp, blind≈chance, 편향 중화 |
| v3 | 난도 올리면 천장 깨지나 | 안 깨짐(메모리 강건), 진짜 난도축=divergence/회상stress 진단 |
| **selfspec** | **그 기억이 그 사람 것인가** | **+100pp, 틀린 기억은 적극 오도(=user-specific 확정)** |

## 5. 남은 것 (루크 결정)
- **진짜 persona 형성**: dream→LoRA 로 관계에서 자아 증류 → 이 selfspec 지표로 측정
  (frozen base + 로컬 LoRA, naia-model-infra). = HANDOFF-persona-formation 본 실험.
- (선택) 난도 천장 깨기: 적대적 회상 / 취향 충돌 (v3 §4).

## 6. 커밋
- examples/prediction-anchor-selfspec.ts (신규, opt-in). 라이브 36×3조건 검증.
- 이 문서. HANDOFF §6 업데이트.
