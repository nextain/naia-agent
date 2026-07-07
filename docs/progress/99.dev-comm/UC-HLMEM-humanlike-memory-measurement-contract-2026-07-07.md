# UC-HLMEM — 인간유사 기억 측정 (memory-as-user-model) 계약서

작성 2026-07-07 (세션 ed6b7ccc). 권위 계약서(P01→P03 근거). 옛 packages/ 계보의 human-like
bench(예측앵커·자아특이성)를 정본 헥사고날 naia-agent 로 **계약기반 이식**하기 위한 계약.
상위 통합 플랜 = `alpha-adk/.agents/progress/naia-4repo-humanlike-integration-2026-07-07.md`.

## 0. 목적 (북극성)
장기기억의 가치는 "완벽 회상"이 아니라 **그 사용자를 예측하는 사용자-특이 모델이 되는 것**이다
([[project_naia_memory_bench_northstar_humanlike]], [[project_naia_cognitive_predictive_entrainment]]).
측정은 **예측정확도(proxy, telos 아님 — [[project_naia_behavior_emergent_not_filtered]])**:
held-out 선택을 ablation(기억 有/無/타인기억)으로 예측.

가족(family) 순서 = **취향 먼저, 감정 나중**(HANDOFF):
- **F1 preference/taste** — 기억이 held-out 취향 선택 예측을 끌어올리나 (matched vs blind).
- **F2 self-specificity** — 본인 기억이 예측하고(matched) 타인 기억은 오도하나(mismatched<blind).
- **F3 emotion-association** — salience 가중 회상 (P6, MemoryPort salience widen 필요).

## 1. 정본 seam 계약 (반드시 준수 — 땜빵 금지)
1. **recall 은 자동이다.** 정본은 턴 전 `MemoryPort.recall(query)`(FR-MEM-1)를 **자동** 호출한다.
   옛 벤치의 모델발화 `<recall>마커>` 프로토콜·"no-recall-attempt/agent-decision" 버킷은 정본에
   **대응 개념이 없다 → 폐기.** trace 는 자동 recall 결과 기준으로 재정의(§3).
2. **주입은 formatRecalledMemory 로만.** 회상→프롬프트 주입은 `domain/memory.ts formatRecalledMemory()`
   신뢰경계(FR-MEM-7/8/10, 출처 fail-safe)로만. 벤치가 재프레이밍 금지.
3. **라이브 예측은 ProviderPort/SubLlmPort 로만.** raw VercelClient/LLMClient 금지(옛 계보 잔재).
   `@nextain/agent-providers`·`@nextain/agent-types`·naia-memory FS 절대경로 import 금지
   (import-boundary.contract.test 위반). `packages/benchmarks` 재도입 금지.
4. **SUT 는 실 MemoryPort.** `makeNaiaMemory`(project-scoped strict) 로 save/recall. seed=save,
   회상=recall→formatter. read-your-writes(save resolve 후 recall 가시) 준수, throw=fail-open.

## 2. 데이터 모델 (benchmark/src, 신규 fixture 스키마)
기존 Fixture(fact-recall/task-accuracy)로 표현 불가 → 신규:
```
HumanlikeScenario {
  id; family: 'preference'|'self-spec'|'emotion';
  users: HumanlikeUser[];              // F2 는 2인(반대취향), F1/F3 는 1인
  situation: string;                   // held-out 상황 stem
  options: { correctFor: userId; text }[2];  // A/B (순서 무작위화=위치편향 제어)
}
HumanlikeUser { id; seed: SeedTurn[]; }   // seed = save 할 과거 발화(명시/암시)
SeedTurn { userText; assistantText?; emotion?; importance? }  // emotion=valence 0..1(F3)
```
condition ∈ {matched(본인 seed), mismatched(타인 seed, F2), blind(seed 없음)}.

## 3. PipelineTrace (재정의 — 자동 recall 기준)
probe 1건, 조건 1개당:
```
HumanlikeTrace {
  seedSaved: bool;            // MemoryPort.save 완료
  recallReturnedTarget: bool; // 자동 recall 이 seed 근거를 회상했나(회상실패 분리)
  memoryInjected: bool;       // formatRecalledMemory 가 비어있지 않은 블록 생성
  predictionParsed: bool;     // 응답에서 '예측: A|B' 파싱됨
  predictionCorrect: bool;    // 예측 == 정답 라벨(무작위화된 옵션 배정 기준)
  outcome: 'correct'|'wrong'|'no-recall'|'exec-error';
}
```
- **exec-error**(빈/축퇴 응답)는 clean outcome 아님 — infra 실패로 분리(라이브 빈 completion=자격/토큰
  문제, 예측실패로 오분류 금지).
- 옛 5-버킷(no-recall-attempt/retrieval-miss/not-used/used-needs-judge/abstained/forced-inappropriate)
  중 **마커·"부적절=실패" 도덕 채점 계열 폐기**(필터=편향, SoT). 남는 축=회상성공·예측정확도.

## 4. 지표 (metrics.ts 추가)
- `predictionAccuracy(results, condition)` = correct/total.
- `selfSpecificity` = acc(matched) − acc(mismatched). mismatched<blind = 타인기억 적극 오도.
- 위치편향 제어: 옵션→A/B 배정 trial 마다 무작위, blind pickedA≈50% 로 중화 확인.
- 옛 지표(taskAccuracy/factRecall/driftScore/latency) 보존(직교).

## 5. 결정론/CI
- fixture-replay: 라이브 관측(응답 텍스트)을 fixture 로 녹화 → CI 는 순수 파싱·채점 재생(모델·키 無,
  G15). 라이브=opt-in(`NAIA_PROD_KEY` + 게이트웨이, max_tokens≥32, main=vertexai:gemini-3.5-flash).
- verified-runtime "done"=실 e2e 라이브 1회(matched>blind), 유닛 pass-count 아님.

## 6. 비목표 / 게이트
- F3(감정)·salience widen = **P6**(MemoryPort/RecalledMemory widen + naia-memory arousal-flashbulb).
- naia-os shell 표면화 = **P7 사람 게이트**(transport 정합·STRUCTURE.md).
- process-status.json 게이트 상태 갱신 = charter-immutable → 사람 승인 마커 필요.

## 7. 추적성
UC-HLMEM → FR-HLMEM-1..N(requirements.md) → benchmark/src 유닛(fixture-replay) + 라이브 SUT(P5).
반증 축(리뷰): 자동 recall 재정의 정합 / formatter 경유 / ProviderPort 경유 / import-boundary /
위치편향 중화 / exec-error 분리.
