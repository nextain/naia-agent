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

기존 파일이나 디렉터리는 삭제·수정하지 않았다. 이후 검증에는 캐시된 pnpm 10.33.0 또는 로컬 실행 파일을 사용한다.

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

## 5. 다음 루프

현재 어댑터 기본 `topK=5`가 경쟁 후보가 있는 검색에서 target 누락을 만들 수 있다는 가설을 검증한다. 동일한 8개 distractor와 15개 사용자를 유지하고 topK만 변화시켜 recall 개선과 프롬프트 길이 증가를 함께 기록한다. 단일 소규모 fixture 결과만으로 프로덕션 기본값을 즉시 변경하지 않고, 민감도 결과가 일관될 때 별도 회귀 검증 후 반영한다.

라이브 3회 반복은 네트워크 가능한 실행 환경에서 동일 seed와 모델로 수행해야 한다. 유효 실행 전에는 인간다운 기억 성능이 좋아졌다는 주장을 보류한다.
