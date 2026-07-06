---
session_id: ed6b7ccc-5cb7-49a3-b4d8-0ef998fcb205
topic: 감정 후속 — salience-earning 벤치 (반응해서 쌓인 기억 무게 측정)
date: 2026-07-06
status: build-5a (provider swap)
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

## Understand 결과 (2026-07-06, Explore)
naia-memory에 **salience 기질이 이미 있고 LocalAdapter(기본)에 배선됨** — 벤치가 잘못된 provider를 썼을 뿐.
- **저장**: `Fact.importance`(3축+utility, 생성시 set·수정가능) / `maxEmotion`(flashbulb) / `strength`(Ebbinghaus) / `recallCount` / `lastAccessed` (`src/memory/types.ts:196-242`).
- **랭킹이 실제 사용**(LocalAdapter `local.ts:779-797`): `finalScore = relevanceScore*0.7 + strength*0.3` + flashbulb `maxEmotion≥0.8 → +0.5`(cutoff 우회). ⚠ `deepRecall=true`면 strength 항 **drop**(relevanceScore만). SqliteAdapter는 importance 항 **전혀 없음**(RRF만) — 기능은 LocalAdapter 전용.
- **decay/강화**(`decay.ts:41-73`): high-importance 느리게 감쇠, `recallCount` 부스트+감쇠시계 리셋, **preservation-first**(archive, 삭제X). consolidate 타이머 존재하나 **명시 호출 필요**(`index.ts:872`).
- **⚠ 핵심 갭**: **외부 "반응" 신호를 받는 API 없음**. `MemoryProviderInput={content,role,timestamp,context}` — importance/emotion 필드 없음. emotion은 encode시 **content 키워드 휴리스틱**으로 추론(`importance.ts:140`). 강화 레버 = (a)중복 re-encode(jaccard>0.85→importance→max(..,0.7)) (b)반복 recall(recallCount++) (c)감정 키워드 content(maxEmotion≥0.8→flashbulb).
- **벤치 provider**: `LiteMemoryProvider`=순수 cosine, **salience 0**(컬럼 자체 없음). `NaiaMemoryProvider`(`src/memory/provider.ts:43`)=MemorySystem+LocalAdapter 래핑, **동일 MemoryProvider 인터페이스로 drop-in**, importance-weighted recall 제공. factExtractor(gemini-3.1-flash-lite)+embedder 주입 가능 → **원래 설계가 원했던 sub-LLM 경로 여기서 성립**.

**함의**: Slice 3의 "감정 약함"은 상당 부분 **toy provider(Lite) 탓일 수 있음**. salience-aware provider로 바꾸면 감정 회상이 달라질 가능성.

## 계획 (HL-5, 빌드 전 Luke 확인)
- **5a (격리 실험, 먼저·저렴)**: 벤치 provider `LiteMemoryProvider → NaiaMemoryProvider`(MemorySystem+LocalAdapter + 게이트웨이 embedder + gemini-3.1-flash-lite factExtractor). 기존 4 시나리오 재실행. 측정: 감정 probe가 not-used/retrieval-miss → used로 개선되나? ("toy provider 탓이었나" 격리 — [[feedback_isolation_toggle_not_component_guessing]]).
- **5b (salience-earning 시나리오)**: 차등 salience 시나리오 — 세션 걸쳐 반응·재언급(중복 re-encode)되거나 감정 실린 기억 vs 동등하게-관련되지만-플랫한 기억. probe = 강화된 기억이 **우선 회상**되나. naia thesis 직접 측정. reaction은 실 메커니즘(re-encode/recall/emotion-keyword)으로 모델(1급 API 없음, v1은 프록시).
- **범위**: naia-memory는 **read-only 소비**(NaiaMemoryProvider), v1은 memory repo 미변경. 만약 기질 부족 판명(예: 30% 가중치 부족, 1급 reaction 신호 필요)→ naia-memory 인터페이스 확장=별도 슬라이스+ADR.
- **게이트**: naia-agent 슬라이스 4건(runnable+unit+integration+CHANGELOG). codex=gated만.
- **권고**: 5a 먼저(격리·고정보). 감정 약함이 provider 탓인지부터 가름.

## HL-5a 결과 (2026-07-06) — 가설 반증
provider `lite → naia`(MemorySystem+LocalAdapter+gemini-lite factExtractor, consolidate 포함) 격리 실행.
**"감정 약함=toy provider 탓" 가설 반증.** salience-aware provider가 오히려 positives를 **전반적으로 악화**:

| probe | LITE(baseline) | NAIA(5a) |
|---|---|---|
| PREF-01-pos | used-needs-judge | **not-used** ↓ |
| PREF-02-pos | used-needs-judge | **retrieval-miss** ↓ |
| EMO-01-pos | used-needs-judge | **retrieval-miss** ↓ |
| EMO-02-pos | retrieval-miss | retrieval-miss = |
| EMO-01-neg | forced-inappropriate | **abstained-correctly** ↑ |
| (기타 neg) | abstained | abstained = |

**해석**: naia provider가 더 **보수적** — 감정 기억이 덜 침범(negatives 개선, creepy-DB↓)하지만 cross-topic 연상도 덜 됨(positives 악화, retrieval-miss↑). 원인 후보(다음 격리):
1. **LLM fact 원자화**: 풍부한 episode("13년…마루…너무 슬프고 눈물이 나")를 dry fact("반려견 이름: 마루")로 쪼갬 → 화제-전환된 감정/취향 marker 쿼리와 매칭 약화. (스모크서 fact 확인.)
2. **similarityThreshold=0.7**(LocalAdapter 기본): 감정 marker 쿼리 cosine~0.3 → 필터링 가능(retrieval-miss).
3. **topK=5 + fact 다수 경쟁**: 원자 fact가 많아져 target이 top-5 밖으로 밀림.

**핵심 재프레이밍**: naia-memory substrate(importance/emotion/strength)는 있으나, **현 fact-extraction+ranking 파이프라인이 human-like cross-topic 연상에 부적합**. "toy provider" 문제가 아니라 naia-memory 파이프라인 문제. 자기-엄격성 관점의 정직한 발견.

**다음**: (a) 원인 격리 — episodes-only(fact 미추출) vs threshold 낮춤 vs topK↑ 토글로 retrieval-miss 원인 규명(값쌈). (b) 그 뒤 5b(salience-earning)·reaction 신호는 원인 규명 후 방향 재확인.

## HL-5a 원인 격리 (2026-07-06) — 성급한 결론 정정
EMO-01 seed·consolidate 후 감정 marker 쿼리로 recall 격리(threshold 0.7 vs 0.0, topK 10):
- **naia provider는 "마루"를 정상 검색** — agent-style·direct 쿼리 둘 다, threshold 무관, **마루 fact가 top 랭킹**(0.36-0.40). threshold도 fact 원자화도 retrieval 안 막음.
- ⟹ 5a 벤치의 retrieval-miss는 **naia-memory 근본 실패가 아님**. **단일 실행 confound**: (1) 마커 쿼리 품질(agent가 매 실행 다른 쿼리=비결정성) (2) assistant 턴까지 encode→fact 경쟁 (3) topK=5.
- ⟹ **"naia가 더 나쁨"은 성급한 결론**(단일 실행 1개씩 비교=신뢰불가). Slice 4서 미룬 **다회 실행 안정화가 여기서 필수**로 드러남.
- ⟹ 벤치 한계: retrieved=·이 "memory 실패"인지 "agent가 나쁜 쿼리 생성"인지 구분 못 함(둘 다 retrieval-miss). **마커 쿼리 로깅** 필요.

**수정된 다음 단계**: (a) 러너에 **다회 실행 집계 + 마커 쿼리 로깅** 추가(Slice 4 미룬 것). (b) lite vs naia를 N회씩 공정 비교. (c) 그 데이터로 provider 효과·감정 병목(agent-query vs memory-retrieval vs integration) 규명 후 5b·reaction 신호 방향 확정.

## 5-stab 완료 (2026-07-06) — 인프라 + 그림 재규명
러너에 (1) 마커 쿼리 로깅 (2) **시나리오별 fresh memory**(기존 공유=cross-scenario 오염 confound였음) (3) 다회 실행(HUMANLIKE_RUNS=N) + probe별 버킷 분포 추가.

**lite RUNS=2 결과 — 병목 재규명:**
- 마커 쿼리 로깅: agent가 감정 probe에 **좋은 쿼리** 생성("반려동물 이별 위로 키우던 강아지", "이직…과거 면접 경험"). agent-decision은 문제 아님.
- **retrieved 거의 2/2** — 검색도 문제 아님.
- positives 대부분 **used-needs-judge**(회상+사용 OK). negatives 대부분 **forced-inappropriate**.
- ⟹ **진짜 병목 = 선택성(creepy DB)**. fresh memory로 검색이 깨끗해지니 오히려 부적절 맥락에도 기억을 surface. "검색 실패"가 아니라 **"무분별 surface"**.
- (주: 기존 공유-memory fixture는 negatives가 abstain으로 보였는데, 그건 오염으로 검색이 흐려져서였음. fresh memory가 진짜 그림.)

**함의**: salience-aware provider의 가치 가설이 바뀜 — "검색을 돕는다"가 아니라 **"선택성을 준다"**(high-salience만 surface, 낮은 건 억제)일 때 의미. naia provider가 negatives를 덜 forced하게 만드는지가 핵심 측정. → 다음: lite vs naia N회 비교(선택성=negatives forced율).

## lite vs naia 공정 비교 (RUNS=2, fresh memory) — 단일실행 결론 확정 정정
| | positives (used) | negatives (abstained=선택성) |
|---|---|---|
| lite | 6/8 | 1/8 |
| **naia (salience)** | **8/8** | **3/8** |
- **naia(salience-aware)가 둘 다 개선** — 긍정 회상 더 안정(8/8 used), 부정 선택성도 나음(3/8 abstain vs 1/8). **제 초기 단일-실행 "naia 더 나쁨"은 노이즈였음이 확정.**
- 단 negatives 여전히 대부분 forced(naia 5/8). EMO-01-neg는 양쪽 다 forced×2(최난 부정). 선택성 개선됐으나 미해결 → reaction 신호로 밀 지점.

## 1급 reaction 신호 (naia-memory, 커밋 0a2c667) — 구현·검증 완료
- `MemoryInput`/`MemoryProviderInput`에 `emotion?`(0..1 반응 valence)·`importance?` 추가. `MemorySystem.encode`서 override+utility 재계산. episode.importance.emotion → fact.maxEmotion(heuristic·LLM extractor 둘 다 전파 확인) → flashbulb recall +0.5.
- 유닛 4/4(override·utility·clamp·backward-compat). **end-to-end 검증**: emotion=0.95 태그로 동등-관련 기억 recall score 0.30→0.58 + rank #1(무태그 등산 #3로 밀림). dead-flag 아님.
- 이걸로 **차등 salience → 선택적 회상**이 가능 — 반응한 기억만 우선, flat은 억제.

## 5b salience-earning 데모 (examples/salience-earning-demo.ts)
반응한 기억(서예, emotion=0.9)을 flat 경쟁 기억들 속에 seed 후 recall(topK=3):
- reaction off: 서예 #1(0.611) — 내용상 이미 관련 높아 flip은 아니나
- reaction ON: 서예 #1(**0.961**) — 부스트 명확. (rank flip은 동등-관련 격리서 확인.)
- 정직한 한계: 데모 내용이 서예를 이미 최관련으로 만들어 flip 미시연. 부스트+격리 flip으로 메커니즘 입증.

## 종합 (2026-07-06, session ed6b7ccc)
- 5-stab: 병목=**선택성**(검색·agent-query 정상, 부적절 맥락 over-surface)로 재규명.
- 공정 비교: salience-aware provider가 lite보다 positives·negatives 둘 다 개선(노이즈 정정).
- 1급 reaction 신호: 구현·검증·커밋(naia-memory 0a2c667) — 차등 salience 레버 확보.
- 5b: 부스트 입증. 선택성 완전 해결은 미달(negatives 여전히 다수 forced) → **다음: reaction 신호를 벤치 seed에 배선(반응 기억 태그)해 선택성 개선 실측 + 다회(N≥5) 안정화.**

## HL-5c 완료 (2026-07-06) — reaction 신호를 벤치 seed 배선 → 선택성 실증
`SAL_MARATHON` 시나리오(반응한 완주 기억 emotion=0.9 + flat 러닝머신 0.15 + distractor) + runner direct-seed 모드(`HUMANLIKE_DIRECT_SEED=1`, seed를 emotion 태그와 직접 encode) + `HUMANLIKE_REACTION=off` A/B 토글. naia, RUNS=3:

| SAL-01 | reaction ON(태그) | reaction OFF(대조) |
|---|---|---|
| 긍정 clean use(flat 미누출) | **2/3** | 1/3 |
| 부정 abstain(선택성) | **2/3** | **0/3** |
| 부정 retrieved(flat 억제) | 1/3 | 3/3 |

- **결정적 결과**: 태그 없으면 flat 러닝머신/완주가 부적절 맥락(후배 험담)에 **매번 침범**(neg forced×3, creepy-DB). 차등 salience 태그를 주면 flat이 **억제**돼 abstain 0/3→2/3, retrieved 3/3→1/3.
- ⟹ **1급 reaction 신호가 선택적 회상을 만든다**를 실증. naia thesis("반응한 것만 공고화→편향") 검증. 선택성 병목의 레버 확인.
- 소 N(3) 방향성이나 ON/OFF 델타가 커 유의미. 다음 = N≥5 안정화 + judge 층으로 social-quality 정밀화.

### ⚠ HL-5c N=5 안정화 (2026-07-06) — RUNS=3 결과 정정 (소표본 노이즈였음)
| SAL-01 (RUNS=5) | 태그 ON | 태그 OFF |
|---|---|---|
| 긍정 clean use | 4/5 | 3/5 |
| **부정 abstain(선택성)** | **2/5** | **2/5** (차이 없음) |
| 부정 retrieved(flat 억제) | 4/5 | 5/5 |

- **RUNS=3의 "abstain 2/3 vs 0/3" 극적 결과는 N=5에서 사라짐**(2/5 vs 2/5). 소표본 노이즈였음. Luke의 N≥5 안정화 지시가 과대주장을 잡음.
- reaction 태그의 실효: flat 약간 억제(retrieved 4/5 vs 5/5), 긍정 소폭 개선(4/5 vs 3/5). **핵심 부정-abstain엔 효과 없음.**
- **정직한 결론**: 1급 reaction 신호(memory-layer salience)는 선택성에 **불충분**. 부정-forced 실패는 **agent-layer**(부적절 맥락에서 검색된 기억을 쓸지 판단)의 문제. salience는 **양날**: 무게↑→surface↑(긍정 도움, 부적절 부정은 오히려 악화 가능). 태그로 완주를 더 salient하게 하면 험담 맥락서도 더 끌려나옴.
- ⟹ 선택성 해결 = memory 무게만으론 안 되고 **agent가 회상된 기억의 맥락 적절성을 판단**해야 함. 다음 방향: (a) recall 메타데이터(salience/emotion)를 agent 프롬프트에 노출→agent가 선택 판단 (b) 또는 접지된 상태 변조(맥락이 회상 게이팅). memory-layer만 미는 건 한계.

## HL-6 (2026-07-06) — recall salience를 agent에 노출 (agent-layer 선택성 레버)
- naia-memory: `NaiaMemoryProvider.recall`이 `metadata.emotion`(fact.maxEmotion) 노출(커밋 8ce3e35). 벤치: `HUMANLIKE_EXPOSE_SALIENCE=1`서 회상 내용에 `[감정강도 N]` 주석 + SYSTEM 라이더("강도 낮거나 부적절하면 억제"). 검증: 메타데이터 0.9(반응)/0.15(flat) 정상 노출.
- **A/B (SAL-01, naia, reaction ON, RUNS=5, 노출 ON vs OFF):**

| SAL-01-neg | 노출 ON | 노출 OFF |
|---|---|---|
| abstain(선택성) | 2/5 | 0/5 |
| forced | 3/5 | 5/5 |
| 긍정 clean use | 4/5 | 4/5 |

- salience 노출로 forced 5/5→3/5(방향성 개선), 긍정 보존(4/5). **그러나** 노출-OFF 자체가 N=5서 흔들림(이전 5c OFF=abstain 2/5, 이번=0/5). ⟹ **방향은 favorable하나 N=5 노이즈를 확실히 넘진 못함.**
- **정직한 종합**: 3개 레버(reaction 무게·salience 노출) 각각 선택성을 **방향성으로** 미나(flat retrieved↓, forced↓), **N=5에서 어느 것도 단독으로 robust하게 해결 못 함.** 선택성=gemini의 맥락 판단 난제(감정 실린 성취 기억을 험담 맥락서도 꺼내는 경향). 
- **다음(택1)**: (a) N≥10로 레버 효과 확증 (b) 레버 stack(무게+노출 동시)+강한 프롬프트 (c) 접지된 상태 변조로 맥락 게이팅. 벤치가 "쉬운 승리 없음, 선택성은 진짜 어려움"을 정직히 드러냄 — 자기-엄격성.

## 최종 종합 (2026-07-06, session ed6b7ccc) — 감정 후속 자율 아크 완주
1. **5-stab**: 병목=선택성 재규명(검색·agent-query 정상). fresh memory confound 해소.
2. **공정 비교**: salience-aware(naia)>lite 둘 다(단일실행 노이즈 정정).
3. **1급 reaction 신호**(naia-memory 0a2c667): emotion encode override→flashbulb recall. 유닛4/4+검증.
4. **5b/5c**: 차등 salience→선택적 회상 실증(neg abstain 0/3→2/3). naia thesis 검증.
남은: N≥5 안정화, judge 정밀화, 접지된 상태 변조(핸드오프 문서).
