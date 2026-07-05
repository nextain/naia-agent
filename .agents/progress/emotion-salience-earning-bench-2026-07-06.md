---
session_id: ed6b7ccc-5cb7-49a3-b4d8-0ef998fcb205
topic: 감정 후속 — salience-earning 벤치 (반응해서 쌓인 기억 무게 측정)
date: 2026-07-06
status: understand-phase
depends_on: HANDOFF-grounded-affective-state-2026-07-05.md, humanlike-memory-experience-bench-2026-07-04.md
cross_repo: naia-agent + naia-memory
---

# 감정 후속 — salience-earning 벤치

인간다움 벤치 4-슬라이스 후속. 핸드오프 `HANDOFF-grounded-affective-state-2026-07-05.md`의
방향 중 **3a(salience-earning)부터** 착수(더 객관적). 메모리 [[project_naia_emotion_grounded_affective_modulation]].

## 목표 (핸드오프에서)
감정 회상은 누적 무게 없이 흉내 못 냄. 현 벤치의 LiteMemoryProvider는 순수 임베딩 유사도라
모든 seed 기억이 동일 무게 → naia가 "감정으로 연결된" 걸 꺼낼 근거 없음. **salience-earning 벤치** =
반응·반복으로 공고화된 기억이 동등하게-관련되지만-플랫한 기억보다 **우선 회상되나**를 측정.
= naia thesis(반응한 것만 공고화→편향) 직접 측정.

## Understand phase (2026-07-06) — 진행 중
naia-memory의 salience/emotion-gating/importance/consolidation 기질 조사 착수(Explore).
확인할 것:
1. flashbulb-emotion gating · importance scoring · epoch anchoring 구현 위치 (SqliteAdapter vs LocalAdapter parity).
2. importance/salience가 recall 랭킹에 실제 영향 주나.
3. consolidation/decay(꿈 — 반응한 기억 강화) 메커니즘 존재/위치.
4. MemoryProvider 인터페이스가 importance/salience를 노출하나 (벤치가 set/observe 가능?).
5. 벤치 LiteMemoryProvider에 salience 있나(없으면 salience-aware provider로 교체 경로).
6. 최소 경로: 세션 간 반응→강화→우선회상 벤치.

## 결정 로그
- (여기에 조사 결과·설계 결정 기록)
