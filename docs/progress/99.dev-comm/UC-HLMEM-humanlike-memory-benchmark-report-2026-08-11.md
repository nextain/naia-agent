# UC-HLMEM 인간다운 기억 벤치마크 재개 보고서 (2026-08-11)

## 1. 목적과 판정 원칙

이번 작업은 `naia-memory`의 완전 암기율이 아니라, 과거 대화에서 형성된 감정적 연상·성향·선호를 현재 선택 예측에 적절히 사용하는지를 측정하는 `UC-HLMEM` 실험을 재개한다. 핵심 비교는 같은 probe에 대한 `matched(본인 기억)`, `mismatched(다른 사용자 기억)`, `blind(기억 없음)` 조건이다.

정확도는 proxy일 뿐 최종 목적(telos)이 아니다. 공급자 호출이 실패한 표본은 `exec-error`이며 정확도 분모에서 제외한다. 필수 조건에 채점 가능한 표본이 없거나 호출 오류가 하나라도 있으면 해당 실행은 성능 증거가 아닌 `invalid-infrastructure`로 판정한다.

## 2. 재개 시점 기준선

- 기준 HEAD: `d60680e` (`chore(benchmark): update humanlike model default`)
- 시나리오: F1 선호 3개, F2 자기특이성 6개(양쪽 사용자), 1회 실행 시 총 42개 예측
- 기본 모델: `vertexai:gemini-3.6-flash`
- 실제 `MemoryPort` + keyword-only 검색의 기존 결정론 실행: 12/12 검색 결과가 비어 있지 않음
- 라이브 기준선: 샌드박스 네트워크 차단으로 42/42 `fetch failed`, 채점 가능 표본 0개
- 기준선 결함: 위 라이브 실행이 종료 코드 0과 `verified-runtime` 문구를 출력했고, `Math.random()` 선택지 배치와 구조화 증적 부재로 동일 실행을 재현할 수 없었음

사전 저장소 검사에서도 작업과 무관한 기존 차단 요인을 확인했다.

- `bash scripts/enforce-root-structure.sh`: 미등록 `projects/` 디렉터리 때문에 실패
- `node --test src/test/ci-verify-*.test.mjs`: `ci-verify-completion.test.mjs` 1개 실패(나머지 3개 통과)
- 시스템 `pnpm test`: 저장소 요구 버전 10.33.0 대신 9.0.0이어서 시작 전 중단

기존 파일이나 디렉터리는 삭제·수정하지 않았다. 이후 검증에는 로컬 실행 파일을 사용했다. `10.33.0` 경로의 Corepack 캐시가 실제로는 pnpm 9.0.0 CLI를 실행하는 환경 이상도 별도로 확인했다.

## 3. 루프 1 — 재현성과 fail-closed 판정

### 가설

라이브 환경 장애를 성능 결과와 분리하고, 선택지 배치와 원시 관측을 재현 가능하게 만들면 잘못된 성능 결론을 막을 수 있다.

### 변경

- `HUMANLIKE_SEED`와 SHA-256 기반 trial key로 정답 A/B 위치를 결정론적으로 배치
- 모든 필수 조건에 채점 결과가 있고 `exec-error=0`일 때만 `complete` 판정
- 불완전 실행은 종료 코드 1과 `runtime-unverified`로 종료
- `HUMANLIKE_OUTPUT` 아래에 설정, 배치 비율, validity, summary, 오류, replay fixture를 덮어쓰기 방지 JSON으로 신규 저장
- `mismatched` 기억을 target 기억 검색 성공으로 표시하던 trace 의미 오류 수정

### 평가

| 항목 | 기준선 | 변경 후 |
|---|---:|---:|
| deterministic 실제 MemoryPort 검색 | 12/12 | 12/12 |
| 라이브 채점 가능 표본 | 0/42 | 0/42 |
| 라이브 종료 코드 | 0 (오판) | 1 (fail-closed) |
| 실행 판정 | `verified-runtime` (오판) | `invalid-infrastructure` |
| A 정답 배치 | 기록/재현 불가 | 8/15 (53.3%), seed `20260811` |
| 구조화 증적 | 없음 | deterministic + live JSON |
| 관련 계약 테스트 | 23개 | 26개 모두 통과 |

네트워크가 차단된 현재 실행 환경에서는 모델 정확도, memory lift, self-specificity를 측정할 수 없다. 이 값들은 모두 `null`이며 0%로 해석하면 안 된다. 이번 루프에서 개선된 것은 모델/검색 성능 수치가 아니라 벤치마크의 판정 신뢰성과 재현성이다.

증적:

- `benchmark/reports/humanlike/2026-08-11-deterministic.json`
- `benchmark/reports/humanlike/2026-08-11-live-attempt.json`

## 4. 루프 2 — topical distractor와 target recall

### 가설

기존 12/12는 사용자별 저장소에 관련 seed만 있고 F1이 빠진 쉬운 조건이다. 같은 저장소에 probe 주제와 겹치는 비관련 대화를 넣고 실제 seed 문장이 반환됐는지 판정하면 숨겨진 검색 실패를 드러낼 수 있다.

### 변경

- F1 3개 사용자까지 포함해 검색 대상 12개에서 15개로 확대
- 저장소마다 음식·카페인·시간대·사교·기온·매운맛 등 topical distractor 8개 추가
- `injected.length > 0` 대신 반환 episode가 실제 target seed 문장을 포함하는지 판정
- 라이브 trace도 matched target 검색 여부와 단순 memory injection 여부를 분리

### 평가

| 항목 | 단순 기준선 | distractor 조건 |
|---|---:|---:|
| 대상 사용자 | F2 12명 | F1+F2 15명 |
| store당 distractor | 0 | 8 |
| 무엇이든 주입됨 | 12/12 | 15/15 |
| 실제 target seed 검색 | 간접 12/12 | 13/15 (86.7%) |
| 실패 | 관측 안 됨 | `F2-spice` 2/2 |
| 계약 테스트 | 26개 | 27개 모두 통과 |

이 루프는 기존 지표의 false positive를 실제로 드러냈다. `F2-spice`에서는 “매운 음식과 순한 음식” distractor가 넓은 keyword-only query와 경쟁해, 결과 블록은 생성됐지만 두 사용자의 실제 성향 seed가 topK에 들지 못했다. 따라서 `any-injection=100%`를 target recall로 해석하면 안 된다.

증적: `benchmark/reports/humanlike/2026-08-11-distractor.json`

## 5. 루프 3 — topK 민감도와 문맥 비용

### 가설

`F2-spice`의 누락이 경쟁 후보에 밀린 결과라면 `topK=5`를 8로 늘릴 때 target recall이 개선될 수 있다. 단, 더 많은 기억을 넣는 비용을 함께 측정해야 한다.

### 변경

- `HUMANLIKE_TOP_K`로 1~50 범위의 검색 폭을 지정
- 아티팩트에 topK, 사용자별 target 판정, 주입 문자 수, 평균·최대 주입 문자 수 기록
- seed `20260811`, store당 distractor 8개, 동일한 15개 target을 고정하고 topK만 5와 8로 비교

### 평가

| 항목 | topK=5 control | topK=8 candidate | 판정 |
|---|---:|---:|---|
| target recall | 13/15 (86.7%) | 13/15 (86.7%) | 개선 없음 |
| any injection | 15/15 | 15/15 | 동일 |
| 평균 주입 문자 | 322.0 | 418.4 | +96.4 (+29.9%) |
| 최대 주입 문자 | 346 | 457 | +111 (+32.1%) |
| 누락 | `F2-spice` 2건 | `F2-spice` 2건 | 동일 |

가설은 기각했다. 검색 폭 확대는 target을 한 건도 더 찾지 못하면서 프롬프트 문맥만 약 30% 늘렸다. 따라서 프로덕션 기본 topK는 변경하지 않았다.

증적:

- `benchmark/reports/humanlike/2026-08-11-topk5-control.json`
- `benchmark/reports/humanlike/2026-08-11-topk8-candidate.json`

## 6. 루프 4 — 한국어 맛 합성어 정규화

### 원인 분석과 가설

실패 query의 핵심 token은 `매운맛`이지만 seed 문장의 핵심 token은 `매운`이었다. keyword-only 검색에서 두 token의 교집합이 없어 점수가 0이므로, topK를 늘려도 후보 자체에 들어오지 않았다. 생산적인 `맛` 합성어를 원형과 어간으로 함께 확장하면 `매운맛 ↔ 매운`을 연결하면서 기존 정확한 token도 보존할 수 있다고 판단했다.

### 제품 변경

`naia-memory`의 한국어 정규화에서 길이 2 이상인 `*맛` token을 원형과 어간으로 확장했다. 예를 들어 `매운맛`은 `[매운맛, 매운]`, `감칠맛`은 `[감칠맛, 감칠]`로 정규화한다. 두 사례를 회귀 테스트로 고정했다.

- 제품 커밋: `8ab6283` (`fix(recall): expand Korean taste compounds`)
- `naia-memory` 빌드 통과
- `naia-memory` 전체 테스트 24 files, 391 tests 통과

### 동일 조건 재평가

빌드된 `naia-memory/dist`와 `naia-agent`가 해석한 설치 패키지 파일의 SHA-256이 동일함을 확인한 뒤, control과 같은 topK=5·seed·distractor 조건으로 재실행했다.

| 항목 | 수정 전 control | 정규화 수정 후 | 변화 |
|---|---:|---:|---:|
| target recall | 13/15 (86.7%) | 15/15 (100%) | +2건, +13.3%p |
| any injection | 15/15 | 15/15 | 동일 |
| 평균 주입 문자 | 322.0 | 328.7 | +6.7 (+2.1%) |
| 최대 주입 문자 | 346 | 350 | +4 (+1.2%) |
| `F2-spice` recall | 0/2 | 2/2 | +2건 |

이번 fixture에서는 검색 폭을 늘리지 않고 누락 2건을 모두 복구했다. 문맥 길이의 소폭 증가는 새로 회수된 target episode가 프롬프트에 포함된 결과다. 이 수치는 **15개 고정 fixture의 keyword-only target recall**이며, 일반적인 완전 회수율이나 LLM 응답 품질 100%를 뜻하지 않는다.

증적: `benchmark/reports/humanlike/2026-08-11-ko-compound-candidate.json`

## 7. 최종 검증 상태

| 검증 | 결과 |
|---|---|
| benchmark TypeScript compile | 통과 |
| 관련 계약 테스트 | 27/27 통과 |
| `naia-agent` TypeScript compile | 통과 |
| `naia-agent` 전체 Vitest | 1,368 통과, 12 실패, 9 skip |
| root structure | 기존 미등록 `projects/` 때문에 실패 |
| CI verify | 3 통과, 기존 completion 1 실패 |

전체 Vitest의 12개 실패는 6개 파일에 있으며, 샌드박스의 `spawnSync git EPERM`, localhost `listen EPERM`, 자식 프로세스 조기 종료에 걸린 subprocess/gRPC 통합 테스트다. 관련 벤치마크 테스트와 양 저장소 TypeScript 컴파일, `naia-memory` 전체 테스트는 통과했다. 따라서 이번 변경 범위의 회귀는 관측되지 않았지만, 전체 suite를 통과했다고 기록하지는 않는다.

로컬 파일 의존성 갱신 과정에서는 워크스페이스 전체 오프라인 설치가 무관한 dashboard의 `fsevents` 캐시 부재로, 독립 설치가 현재 배치와 맞지 않는 기존 `file:../../naia-kb-compiler` 경로로 각각 중단됐다. package.json과 lockfile은 변경하지 않았으며, 최종 실험은 설치된 패키지 파일과 제품 빌드의 체크섬 일치를 확인하고 수행했다.

## 8. 네트워크 재확인과 운영 게이트웨이 라이브 시도

사용자가 네트워크를 열어 준 뒤 기존 라이브 기준선의 주소부터 다시 확인했다. 하네스에 남아 있던 Cloud Run 주소 `naia-gateway-181404717065.asia-northeast3.run.app`는 `/`, `/health`, `/healthz`, `/v1`, `/v1/models`, `/v1/chat/completions`에서 모두 404였다. 현재 운영 게이트웨이 `https://api.nextain.io`는 `/health`와 `/v1/models`가 200이며, 모델 목록에서 `gemini-3.1-flash-lite`를 확인했다. 짧은 비스트리밍 4회와 스트리밍 4회 직접 호출도 모두 200이었다. 비밀키 값은 기록하지 않았다.

이에 하네스 기본값을 운영 주소와 `gemini-3.1-flash-lite`로 교정하고, 라이브 호출마다 bounded abort timeout·최대 재시도·선택적 호출 간격을 기록하도록 했다. 그러나 42-call 전체 경로는 짧은 직접 probe와 달리 후반부 스트림에서 반복적으로 끊겼다.

| 실행 | 설정 | 결과 | 판정 |
|---|---|---|---|
| corrected 1-run | timeout/retry 미지정, topK=5 | matched 15/15, mismatched 0/12, blind 6/14, exec-error 1 (`terminated`) | `invalid-infrastructure` |
| throttled 1-run | timeout 15s, retry 1, 간격 1s | matched 12/15 채점, mismatched 9/12 채점, blind 11/15 채점, exec-error 10 | `invalid-infrastructure` |
| slow 1-run | timeout 60s, retry 0, 간격 2s | `F2-chrono` 이후 연속 timeout; 수동 중단 | artifact 미생성, 성능 증거 아님 |

첫 실행의 `matched=100%`, `memory lift=57pp`, `self-specificity=100pp` 등은 1개 호출 오류가 있는 무효 실행에서 나온 proxy이므로 성능 수치로 사용하지 않는다. timeout/retry 변경은 무한 대기를 막았지만 운영 스트림 불안정을 해소하지 못했다. 현재 근거로는 엔드포인트 자체가 죽었다고 단정할 수 없고, 짧은 probe는 정상인 반면 42개 순차 요청의 스트림 세션 안정성이 확보되지 않았다고만 결론 내린다.

증적:

- `benchmark/reports/humanlike/2026-08-11-live-3run-network-open.json` (구 주소 404, 126/126 오류)
- `benchmark/reports/humanlike/2026-08-11-live-api-nextain-gemini31-1run.json`
- `benchmark/reports/humanlike/2026-08-11-live-api-nextain-gemini31-1run-throttled.json`
- `benchmark/run-humanlike-bench.mjs`의 `HUMANLIKE_CALL_TIMEOUT_MS`, `HUMANLIKE_CALL_RETRIES`, `HUMANLIKE_CALL_DELAY_MS`

이번 네트워크 재확인 단계의 benchmark 커밋은 `fbe8458`이다. 앞선 제품 수정 커밋은 `8ab6283`이며, 그 전의 재현성·distractor·topK 평가 커밋은 각각 `9fd5253`, `6a52cb1`, `1d9890b`이다.

## 9. 결론과 다음 실험

이번 반복에서는 먼저 쉬운 `any-injection` 지표의 false positive를 제거했고, 단순 topK 확대가 효과 없이 문맥만 늘린다는 음성 결과를 남긴 다음, 실제 token 불일치를 제품 계층에서 수정했다. 고정 fixture target recall은 같은 topK에서 86.7%에서 100%로 개선됐다.

다음 우선순위는 다음과 같다.

1. `맛` 이외의 한국어 합성 명사·활용 불일치 corpus를 추가해 규칙의 precision과 recall을 함께 측정한다.
2. 같은 fixture에서 keyword-only와 embedding 검색을 비교해 lexical rule의 적용 범위를 정한다.
3. 네트워크 가능한 환경에서 동일 seed·모델로 matched/mismatched/blind 라이브 실행을 3회 이상 반복한다.
4. 지연시간이나 scale 개선을 주장하려면 `naia-memory` 규칙에 따라 100k 기억 규모에서 별도 부하 실험을 수행한다.

현재 운영 게이트웨이의 짧은 호출은 가능하지만 42-call 라이브 실행은 모두 `invalid-infrastructure`이거나 중단되었다. 따라서 LLM의 인간다운 기억 성능이나 memory lift가 개선됐다는 주장은 계속 보류한다. 재개 시에는 게이트웨이 운영자 측의 스트림 세션/요청 제한 로그를 확인하거나, 동일 ProviderPort 계약을 유지하는 안정적인 batch 평가 경로를 먼저 확보해야 한다.
