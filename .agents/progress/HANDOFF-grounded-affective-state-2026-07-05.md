---
session_id_origin: ed6b7ccc-5cb7-49a3-b4d8-0ef998fcb205
topic: HANDOFF — 접지된 상태 변조 + 감정 salience 공고화 (인간다움 기억 벤치 후속)
date: 2026-07-05
status: design-captured, not-started (별도 집중 세션에서 착수)
audience: 새 세션 (이 대화 컨텍스트 없이 시작)
cross_repo: naia-agent + naia-memory (emotion gating을 실제로 켬)
---

# HANDOFF: 접지된 상태 변조 + 감정 salience 공고화

인간다움 기억 벤치 4-슬라이스(HL-1~HL-4) 완료 후, 루크와의 설계 논의(2026-07-05)에서
나온 다음 방향. 이 문서 하나로 새 세션에서 착수 가능하게 자족 작성. 먼저 형제 파일
`humanlike-memory-experience-bench-2026-07-04.md`(벤치 이력)를 읽을 것.

## 0. 왜 이 작업인가 (벤치가 드러낸 것)
HL-1~HL-4 벤치 실측: **취향 축은 naia가 신뢰성 있게 작동, 감정 축은 확연히 약함**
(감정연상 긍정 probe가 not-used/retrieval-miss로 흔들리고, 부정은 forced-inappropriate).
근본 진단(루크): 감정 회상은 **누적된 무게 없이 흉내낼 수 없다**. 현 벤치의 기억 층
(LiteMemoryProvider)은 순수 임베딩 유사도만 봐서 모든 seed 기억이 동일 무게 → naia가
"감정으로 연결된" 걸 꺼낼 근거 자체가 없음. 즉 "감정 약함"은 버그가 아니라, 감정 무게
메커니즘을 안 켠 콜드 셋업에서 측정한 **불공정한(그러나 정직한) 결과**.

## 1. 핵심 설계 — 감정은 정의하는 게 아니라 3겹으로 조립된다
"감정"을 크리스프하게 정의하려 하지 말 것. 북극성 = **인간다움·경험만족**이지 완벽회상
아님([[project_naia_memory_bench_northstar_humanlike]]). 정의 대신 세 겹의 곱:

1. **누적 기억 무게 (장기)** — 반응해서 공고화된 기억일수록 더 쉽게 떠오름. = naia의
   꿈/오프라인 공고화 thesis([[project_naia_dreaming_offline_consolidation]], "AI는 평균회귀,
   막는 중력=기억, 반응한 것만 공고화"). 감정 편향 = 그 중력 그 자체.
2. **접지된 현재 상황 (단기)** — 지금 대화 맥락 + naia가 실제로 아는 신호(시각, 날씨,
   최근 대화에서 사용자가 가라앉아 보였는지). 온프렘·상시·소유형이라 이건 시뮬레이션이
   아니라 **실제 컨텍스트**([[project_naia_alpha_vision_why]]).
3. **느린 창발 상태 (컨디션)** — 위 ①②에서 창발하는 천천히 흐르는 내부 상태. 같은 기억도
   좋은 날엔 따뜻하게, 지친 날엔 안 나옴.

회상·표현 = (기억 무게) × (현재 맥락) × (지금 상태). 앞의 두 개만이 아니다.

## 2. 절대 지킬 아키텍처 규율 (gimmick 함정 회피)
### (a) 상태는 표현 층만 변조, 능력 층은 불변
사람도 컨디션 나쁜 날 실력이 사라지진 않음 — 말투·따뜻함·먼저 꺼내는 정도만 바뀜.
- **변조 OK (판정 층 영역)**: 기억을 먼저 volunteer할지(적극성 문턱), 톤, 따뜻함, 풀어 말하는 정도.
- **불변 필수 (결정론 영역)**: 물어보면 사실 정확히 회상, 도움 요청엔 컨디션 탓 답 나빠지면 안 됨.
- 우리 2층 벤치와 정확히 매핑: **결정론 5-버킷(검색·사용)=상태 무관 안정**, **social-quality
  판정(적절·자연·따뜻함)=상태가 legitimately 사는 자리**. mood가 검색 정확도를 흔들면 = 고장난 도구.

### (b) 접지된(grounded) 변조 > 떠 있는(simulated) mood
- **접지**: 실제 신호(시각/날씨/최근 상호작용)로 변조. 늦은 밤→부드럽게, 요 며칠 사용자
  힘들어 보임→조심스럽게. 진짜 메커니즘.
- **떠 있는 mood**: 무작위로 흔들리는 사적 기분 = 주사위. anthropomorphic 함정 + 검증 불가. **지양.**
- "컨디션"은 실제 신호 + 최근 상호작용의 **느린 집계로 창발**시킬 것. (가창에서 오디오
  통계복제 말고 성대 물리제어로 간 것과 같은 결 — [[feedback_singing_physical_control_not_statistical_replication]].)

### (c) 비결정성 재프레이밍 — 변주를 없애지 말고 legible하게
HL-4의 "감정 케이스 비결정성 안정화" 목표는 반쯤 틀렸음. 매번 똑같은 결정론 로봇은 인간답지
않음. **나쁜 변주 = 샘플링 주사위 / 좋은 변주 = 상태에서 나온 것.** 목표 = 무작위 변주를
**상태 기반 legible 변주로 갈아끼우기**. (스택의 두 번째 줄기 = 결정 신호, [[reference_harness_second_stream_not_llm]] 결과 정합.)

## 3. 벤치 방향 (측정으로 어떻게 잡나)
### 3a. Salience-earning 벤치 (①번 무게)
- seed 기억에 차등: 어떤 건 여러 세션 걸쳐 강하게 반응·반복(높은 salience), 어떤 건 한 번 스침(플랫).
- 세션 사이 **공고화 스텝(꿈)** 삽입 → 반응한 기억 무게 상승.
- probe: "감정 무게 높은 기억이 동등하게-관련되지만-플랫한 기억보다 **우선** 떠오르나".
- → "한 번 심은 걸 검색하나"(현재)가 아니라 **naia thesis(반응한 것만 공고화→편향)**를 측정.

### 3b. 접지된 상태 변조 벤치 (②③번 상태)
- **같은 probe를 다른 접지 상태에서** 실행 → 늦은 밤엔 더 부드러워지나(긍정),
  그리고 **능력 불변 대조**(컨디션 나빠도 사실 회상·정확도 유지 = 부정 대조).
- 판정: 변주가 따뜻함으로 읽히면 pass, 도구가 withholding하거나 나빠진 걸로 읽히면 fail.
  판정자(경험 만족)가 가드레일.

## 4. 재사용 인프라 (HL-1~HL-4에서 이미 있음)
- 결정론 5-버킷 코어 + observe/pipeline + 무응답 가드 (`packages/benchmarks/src/humanlike/`).
- social-quality 판정(codex+claude, 3축 median, 충실성=실검색기억 grounding) (`humanlike/judge.ts`).
- fixture record/replay + report (`humanlike/fixture.ts`). **다회 실행/상태 변주도 이 픽스처 포맷 확장.**
- 4 시나리오(취향2+감정2) + 앵커 규율 (`humanlike/scenarios.ts`).
- 라이브 러너(gemini + 실 embedder + LiteMemoryProvider + 격리 recall 스파이) (`examples/humanlike-memory-bench.ts`).

## 5. naia-memory 걸침 (이게 왜 별도 세션인가)
①번 무게 메커니즘 = naia-memory의 **flashbulb-emotion gating · importance**를 실제로 켜는 것.
현재 SqliteAdapter 쪽에 있으나 **LocalAdapter parity 미달**(naia-memory CLAUDE.md), 그리고 벤치가
쓴 경량 LiteMemoryProvider 경로엔 아예 안 붙음. 즉 이 작업은 naia-memory repo까지 걸쳐서
[적대적 리뷰 → memory 층에 salience/공고화 배선 → 벤치로 검증] 루프. 긴 세션 끝 강행 금지,
깨끗한 집중 세션에서 시작([[feedback_deploy_separate_session]] 취지).

## 6. 시작 체크리스트 (새 세션)
1. naia-agent AGENTS.md + agents-rules.json 재독. 세션을 progress 파일에 바인딩.
2. 형제 `humanlike-memory-experience-bench-2026-07-04.md`(벤치 이력) + 이 문서 정독.
3. naia-memory GEMINI.md + emotion gating/importance 현황 파악(SqliteAdapter vs LocalAdapter parity).
4. 착수 순서 권고: **3a(salience-earning) 먼저** — ①번 무게가 ②③ 상태 변조의 토대이고 더 객관적.
   3b(상태 변조)는 그 뒤. (취향→감정 순으로 갔던 것과 같은 "객관적인 것부터" 원칙.)
5. 규율 §2 (표현층만 변조·능력 불변 / 접지>시뮬 / legible 변주) 위반 경계.

## ⟳ 2026-07-06 UPDATE — 3a(salience) 완료, 다음 세션은 3b(접지 상태 게이팅)
§3a(salience-earning)를 세션 ed6b7ccc에서 끝까지 돌렸다. 상세 = `emotion-salience-earning-bench-2026-07-06.md`. 요지:
- **병목 재규명**: 감정 회상의 문제는 검색이 아니라 **선택성**(부적절 맥락에 기억 over-surface = creepy-DB). agent는 좋은 쿼리를 내고 검색도 정상.
- **레버 2개 빌드·검증**: (1) naia-memory **1급 reaction 신호**(`emotion` on encode → episode→fact.maxEmotion→flashbulb recall, 커밋 0a2c667) (2) **recall salience를 agent에 노출**(metadata.emotion + 프롬프트 힌트, 커밋 8ce3e35 + 벤치 a91cbe6). 둘 다 기계적으로 작동.
- **핵심 결론(자기-엄격)**: 두 레버 각각 선택성을 **방향성으론** 개선(flat 억제·forced 감소)하나, **N=5에서 어느 것도 단독으로 robust하게 해결 못 함**. 선택성 = memory 무게/힌트로 완전히 못 막는 **모델의 맥락 판단 난제**. (RUNS=3의 극적 결과는 소표본 노이즈였고 N=5가 잡음 — 다회 안정화 필수 교훈.)
- ⟹ **다음 세션 = 3b(접지된 상태 변조)에 집중.** 선택성을 memory/agent 힌트가 아니라 **"현재 맥락·상태가 회상을 게이팅"**하는 방향으로. §2 규율(표현층만·접지>시뮬·legible 변주) + §3b 그대로. 재사용 인프라: 5-stab 다회 러너 + salience 노출 배선 + reaction 신호 + SAL/감정 시나리오 전부 있음(N≥5 default로).
- 남은 옵션(3b 전 원하면): N≥10 레버 확증 / 레버 stack(무게+노출+강프롬프트). 단 N=5가 이미 "레버 한계"를 보여 3b가 더 값짐(루크 결정 2026-07-06).
