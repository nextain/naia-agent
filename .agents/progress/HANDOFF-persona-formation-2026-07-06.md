---
session_id_origin: ed6b7ccc-5cb7-49a3-b4d8-0ef998fcb205
topic: HANDOFF — naia-memory = 인격(persona) 형성 아키텍처 실험 (기억 연상 다음 단계)
date: 2026-07-06
status: design-captured, not-started (별도 집중 세션)
cross_repo: naia-memory + naia-model-infra (로컬 LLM + LoRA) + naia-agent
sot: projects/naia-agent/.agents/context/naia-behavior-emergent-not-filtered.md
---

# HANDOFF: naia-memory가 인격(나다움)을 형성하는 아키텍처 실험

세션 ed6b7ccc(2026-07-06) 인간다움 기억/감정 벤치 작업 끝에 루크가 방향을 전환·확정.
**먼저 SoT `naia-behavior-emergent-not-filtered.md` 를 반드시 정독할 것** (이 실험의 헌장).
형제 이력 = `emotion-salience-earning-bench-2026-07-06.md`(기억 연상·salience 실험).

## 0. 왜 이 실험인가 (앞 실험이 도달한 벽)
기억 연상·salience 실험(HL-5/6)에서 배운 것:
- 감정 회상의 병목은 검색이 아니라 **선택성**("이 맥락에 이 기억을 꺼낼까"). 그런데—
- **"부적절하면 억제" 같은 필터로 선택성을 강제하는 건 편향**이고 루크 사상의 정반대(SoT).
  선택은 강제할 규칙이 아니라 naia의 **사고**여야 한다. 결과가 warm/무뚝뚝/가끔 못됨이든 그게
  그 naia — **변동성이 인간다움**.
- 그럼 **누구의 사고인가?** 현 구조(frozen gemini + RAG)에선 선택하는 주체가 **gemini의
  페르소나**다. 기억은 *무엇을* 떠올릴지만 바꾸고 *누가* 판단하는지는 안 바꾼다 → 나다움이
  창발 안 함. **페르소나 프롬프트 = 역할 플레이지 실제 모델이 아님**(루크).

## 1. 방향 (루크 2026-07-06)
- **나다움은 기억의 스파이크(salience) 그 이상이 필요하다.** 기억만으론 자아가 안 된다.
- **gemini에 안 먹히려면 = 로컬 LLM 기반 + 사용자와의 관계로 지속 LoRA/FT.** cloud gemini는
  재료·언어능력엔 써도 자아는 될 수 없다(강한 RLHF 페르소나가 지배). 자아는 **온프레미스
  소유형 로컬 모델**이 관계로 계속 적응해 담아야 함 ([[project_naia_alpha_vision_why]] 온프레미스 소유 사상,
  [[reference_naia_local_serve]] 로컬 serving).
- **메커니즘 후보 = 꿈 + LoRA**: 오프라인 consolidation(꿈, [[project_naia_dreaming_offline_consolidation]]
  "반응한 것만 공고화 = 평균회귀 막는 중력")이 관계·경험을 **작은 LoRA/adapter로 증류**해
  "선택하는 자아·가치"를 담는다. 검증 base 동결 + 소형 델타=자아 → no-FT-base 사상과 화해.
- **naia-memory가 이 역할을 할 아키텍처**를 실험하고 싶음(루크). memory = 재료 제공을 넘어,
  consolidation을 통해 **인격 형성의 substrate**가 되는 구조.

## 2. 실험 목표 (measure 무엇을)
- **가설**: 같은 로컬 base라도, 사용자와의 관계 경험을 consolidation→LoRA로 증류하면, 그
  naia의 **선택·목소리·가치가 관계에 따라 서로 다르게** 형성된다(A 사용자의 naia ≠ B 사용자의 naia).
- **측정(주의: SoT — 도덕/규칙 매칭 채점 금지)**: "생각하는 사람 같았나 + 이 관계에서 형성될
  법한 naia인가". 필터 pass/fail 아님. 판정에도 정답-도덕 심지 말 것.
- 반증 축: LoRA 없이(프롬프트 페르소나만) vs LoRA 형성 — 후자가 관계-특이적 자아를 보이나.

## 3. 재사용 인프라 (있음)
- naia-memory: **1급 reaction 신호**(emotion encode override, 커밋 0a2c667) + **recall salience 노출**
  (8ce3e35) + consolidation(consolidateNow, decay, importance/maxEmotion). = 인격 형성의 입력.
- naia-model-infra: 로컬 LLM serving(3090×2), RunPod, LoRA 학습 경로 = 자아 델타의 집.
- 벤치 인프라(naia-agent): 5-stab 다회 러너 + salience 노출 배선 + 시나리오. **단 필터 부분 재설계
  필요**(§4).
- dreaming 사상 [[project_naia_dreaming_offline_consolidation]] = 꿈→LoRA의 이론 토대.

## 4. ⚠ 먼저 정리할 편향 (SoT 위반, 이번 세션 감사 결과)
인간다움 벤치가 **설계자-도덕을 채점에 심은 필터**를 갖고 있음. 인격-형성 실험 전 재설계:
- ✅ **제거됨**: HL-6 suppress 지시 프롬프트("부적절하면 억제해라") → salience는 정보로만.
- **재설계 대상(아직)**: (a) `scenarios.ts` forbiddenRecalls 기반 negative probe (b) `pipeline.ts`
  `forced-inappropriate` 결정론 채점(=creepy 실패) (c) `judge.ts` `appropriateness(적절성)` 축.
  이 셋은 "부적절 회상=실패"라는 **내 도덕을 벤치에 심은 편향**. 인격-형성 실험의 측정으로
  옮길 때 **"규칙 매칭 → 사람다움/관계-적합"**으로 갈아끼울 것. (지금 삭제 안 함 = 커밋된 결정론
  코어+테스트 보존, 별도 재설계.)

## 6. 검증 설계 — 상대 앵커 (2026-07-06 논의, "돌려서 결정" 대상)
절대 "인간다움 점수"를 매기려던 지난 벤치가 필터/편향으로 미끄러진 근본 원인 = **절대 척도**.
검증을 쉽게(+편향 안 심게) 하려면 축을 **상대/예측**으로 바꾼다. 외부 SOTA 경쟁자도, 절대
rubric 도 필요 없음 — baseline 대비 ablation 이 핵심.

- **① 예측 앵커 (제일 값짐 · 과적합 해독제 · 우리 KPI).** naia(기억·자아 O) vs memoryless
  baseline 이 사용자의 **다음 취향·반응을 누가 더 맞히나** (held-out). 객관 숫자 + 이미
  [[project_naia_cognitive_predictive_entrainment]] KPI. **held-out 이라 과적합(표면 암기)과
  진짜 길들임(일반화 예측)을 구분** — 루크의 과적합 우려에 직접 답. `naia-with-X vs without-X`
  ablation 자체가 baseline. ⚠ **단, 예측=proxy이지 telos 아님**(SoT): 바닥 증거로만, 그게
  naia 라 착각 금지. 절대 rubric 화 금지.
  - **first-probe + v2 완료(2026-07-06)** = `prediction-anchor-first-probe-2026-07-06.md` +
    `examples/prediction-anchor-bench.ts`. v2(9 시나리오·보기순서 무작위): **A(memory) 45/45
    100% vs B(blind) 44%≈chance, lift +56pp**, blind pickedA 51%=위치편향 중화 확인. 메모리는
    취향이 평균과 갈리는 6/9 에서 lift, 일치하는 3/9 는 중립. **앵커 유효·과적합 아님**.
    v3 필요: 미묘/충돌/잡음 seed 로 난도↑(메모리 100% 천장 깨기)·자아특이성(A-naia 가 B-사용자
    예측 못 하나).
- **② 쌍-선호 앵커 (인간다움 축, 쉬움).** 같은 대화에서 naia vs baseline(생성 어시스턴트 /
  mem0-backed / reaction-off) 중 "**나를 기억하는 친구 같은 쪽**"을 판정/사람이 고름. 절대 점수
  아닌 A/B 선호 → 검증 쉽고, "옳은가"(도덕) 아닌 "사람 같은가"만 물어 필터 함정 회피.
- **③ 자아-구별 앵커 (persona 형성 전용).** A 사용자의 naia 와 B 사용자의 naia 를 분류기가
  구별 가능한가 + 각자 일관 = "구분되는 자아 형성"의 객관 증거. morality rubric 없이 측정.
- **④ 회상 바닥 앵커 (신뢰용, 목표 아님).** LongMemEval/LoCoMo 로 "기본 회상은 남만큼". 우리
  목표는 아님(과적합 함정) — 대외 신뢰 floor 로만. 흔적: `migration/judge-longmemeval-korean`.

**결론**: "타 기억 대비 우수"라는 절대·경쟁 프레임이 아니라 **ablation + 예측 + 쌍선호**가
검증을 쉽게 만든다. 특히 ①예측이 객관적·on-KPI·과적합 판별까지 하므로 **다음 실험의 1순위 앵커**.
persona 형성도 "그 자아가 사용자를 더 잘 예측하나 / baseline 보다 친구 같나 / 구별되나"로
**검증 가능한 실험**이 됨.

## 5. 시작 체크리스트 (새 세션)
1. **SoT `naia-behavior-emergent-not-filtered.md` 정독** (헌장 — 필터=편향, 선택=창발적 사고).
2. 형제 `emotion-salience-earning-bench-2026-07-06.md` + 이 문서 정독.
3. naia-memory consolidation/importance 현황 + naia-model-infra LoRA 학습 경로 파악.
4. 착수 순서 권고: **작은 로컬 base + 짧은 관계 로그 → consolidation → LoRA → 자아 변화 측정**의
   최소 수직 슬라이스. 프롬프트-페르소나(역할극) baseline 대비.
5. §4 편향 재설계(규칙→사람다움)를 측정 정의와 함께. Claude 드리프트("올바른 기계") 경계 — SoT 재독.
