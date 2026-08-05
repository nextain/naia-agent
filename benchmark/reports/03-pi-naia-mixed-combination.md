# 벤치마크 3 — Pi/Naia 혼합 조합

## 목적

Codex 계정만으로 구성한 경로를 넘어, naia-agent 내장 Pi가 Naia 계정 모델과 외부 코딩 에이전트를 역할별로 조합할 수 있는지, 그리고 비용 비교를 과장 없이 수행할 준비가 됐는지 평가한다.

## 평가 대상

### A. 비용 비교 후보

| 역할 | 후보 | 대조군 |
|---|---|---|
| facing/moderator/explorer/tester/reviewer/reporter | `deepseek-v4-flash` | `grok-4.3` |
| implementer | `grok-4.3` | `grok-4.3` |
| live 모델 비교 runtime | Naia 계정 + gateway direct API(Pi 미포함) | Naia 계정 + gateway direct API(Pi 미포함) |

별도 Pi 결정론 구조에서는 DeepSeek V4 Flash가 분석 전용 `--no-tools`, Grok 구현자만 workspace write를 가진다. 이번 live 모델 비교는 Pi와 workspace 도구를 실행하지 않고 제안 코드 문자열만 평가한다. 비교 계약은 후보가 대조군보다 품질 비열등이고 최소 10% 절감할 때만 성공을 허용한다.

### B. 다중 코딩 에이전트 하네스

별도의 결정론 issue-team 하네스는 Codex, OpenCode, Pi 프로파일을 명시적으로 선택하고 역할 순서, 읽기/쓰기 경계, 수리 1회 후 Clean 2회, 재시작, 중복 방지, 영수증 identity를 검증한다. 이는 “혼합 실행 구조가 동작한다”는 증거이지 각 외부 모델의 실제 코딩 품질이나 시장 비용 증거는 아니다.

## 현재 결과

| 영역 | 결과 | 해석 |
|---|---|---|
| Pi 지속 루프 결정론 게이트 | 전부 true | 재시작, 중복, 예산 소진, 영수증 충돌, 드리프트 차단, OpenCode 비의존 경로 검증 |
| issue-team 결정론 게이트 | 전부 true | 역할 순서·쓰기 경계·수리/리뷰 수렴·재시작·비용 합계 계약 검증 |
| 다중 이슈 결정론 게이트 | 전부 true | 4개 이슈, 동시성 2, FIFO 시작, 격리, 재시작 중복 0, 가시성 검증 |
| 엄격 게이트 유효 live paired | 1/1 | 양쪽 모두 exact 제안 내용 + tester 2 PASS + reviewer 2 CLEAN |
| 유효 paired gateway 호출 | 18 | candidate 9회 + control 9회 |
| DeepSeek–Grok Azure 단가 정규화 절감률 | **74.03%** | DeepSeek는 직접 meter, Grok 4.3은 운영 단가와 일치하는 Grok 4.2 Global meter proxy |
| 지연시간 | 혼합 `67.963초`, Grok `51.621초` | 혼합 조합이 **31.66% 느림** |

결정론 fixture의 `$0.008` 일치값은 비용 회계 로직의 합산 정확성을 검사하는 합성값이다. 실제 Naia/Azure 청구 비용이 아니므로 절감률에 사용하지 않는다.

## Azure 원가 기준

비용 비교는 2026-08-04 Azure Retail Prices API의 Korea Central meter로 정규화한다. 100만 토큰당 단가는 다음과 같다.

| 모델 | 비캐시 입력 | 캐시 입력 | 출력 |
|---|---:|---:|---:|
| DeepSeek V4 Flash | `$0.19` | `$0.028` | `$0.51` |
| Grok 4.3 배포 proxy | `$1.25` | `$1.25` | `$2.50` |

DeepSeek V4 Flash는 Azure Retail Prices API의 해당 모델 meter ID에 직접 결박했다. Azure API에는 조회 시점 기준 Grok 4.3 meter가 없었다. Grok은 운영 gateway 설정과 일치하는 Grok 4.2 Global 입력·출력 meter를 가격 proxy로 사용하며, 별도 캐시 meter가 없어 캐시 입력도 일반 입력 단가로 보수 계산한다. 따라서 결과는 **Azure 단가 정규화 추정치**이지 Grok 4.3 Azure 청구 확정액이 아니다.

naia-gateway 고객가는 구성상 원가에 10%를 가산하지만, 운영 gateway의 현재 `versioned_billing_enabled=false` 배포는 요청별 `customer_cost`와 `price_version_id`를 응답하지 않는다. 이번 결과를 gateway 고객 청구 영수증으로 주장하지 않는다.

### DeepSeek–Grok live paired 결과

2026-08-04 운영 `api.nextain.io`를 통해 같은 9개 역할 과제를 실행했다. 후보는 구현자만 Grok 4.3, 나머지 역할은 DeepSeek V4 Flash이고, 대조군은 전 역할 Grok 4.3이다.

이 live runner는 모델 조합의 품질·비용·지연시간을 격리하기 위해 gateway를 직접 호출한다. Pi 프로세스와 도구 루프의 동작 증거는 별도 결정론 하네스가 담당한다. 따라서 두 증거를 합쳐 “구조와 모델 조합을 각각 검증했다”고는 할 수 있지만, 아직 “같은 실행에서 Pi 전체 루프와 live 모델 조합을 end-to-end 검증했다”고 주장하지 않는다.

| 실행 | 후보 Azure 원가 | 전 역할 Grok 원가 | 절감률 | 후보 지연 | Grok 지연 | 품질 |
|---|---:|---:|---:|---:|---:|---|
| 엄격 R1 | `$0.00022628` | `$0.00087125` | **74.03%** | `67.963초` | `51.621초` | 양쪽 exact 제안 내용, tester 2 PASS, reviewer 2 CLEAN |

비용은 크게 줄었지만 속도는 개선되지 않았다. 후보가 대조군보다 **31.66% 느렸다**. 따라서 이 프로파일은 비용 우선 후보이지 지연시간 우선 기본값으로 승격할 근거는 없다. 또한 유효 반복이 1회뿐이므로 일반화하지 않는다.

최초 예비 실행은 Grok 구현자 요청이 Azure 콘텐츠 필터의 `Jailbreak` 라벨에 오탐되어 중단됐다. 뒤의 두 실행은 구현 제안 문자열만 보던 옛 품질 게이트에서는 통과했지만, reviewer가 각각 결함을 보고했으므로 엄격 게이트에서는 무효다. runner를 응답 모델 exact match, tester 2 PASS, reviewer 2 CLEAN, 호출 전 in-flight 영속으로 보강한 뒤 엄격 R1을 실행했다. 운영 로그를 수동 집계하면 가격 탐색 1회, 예비 4회, 옛 게이트 36회, 엄격 R1 18회로 총 59호출이어서 추가 반복을 중지했다. 별도 Azure runner는 실행당 18회만 결정론적으로 제한하며 여러 프로세스에 걸친 60회 누적 상한을 강제하지 않으므로, 59회는 검증된 공유 ledger가 아니라 보수적 운영 집계다. 무효 실행 비용은 0으로 처리하지 않으며 유효 paired 분모에서는 제외한다.

2026-08-04 현재 후보 재검증에서는 Pi 지속 루프와 비용 runner 계약 12개가 통과했다. issue-team·다중 이슈 22개는 자식 `git merge-base`가 샌드박스 `EPERM`으로 차단되어 provenance 선행 검사에서 멈췄다. 그러므로 표의 issue-team·다중 이슈 결과는 고정 산출물에 대한 보고이며, 현재 후보의 독립 재실행 완료 주장이 아니다.

## 금융 영수증 기준의 남은 한계

live 계약은 다음 항목이 모두 있어야 유료 호출을 시작한다.

- DeepSeek V4 Flash와 Grok 4.3의 정확한 gateway `priceVersionId`
- 32바이트 이상 외부 HMAC journal key와 고정 key ID
- 요청별 gateway request ID, 정산 상태, 토큰, customer cost 영수증
- 후보와 대조군의 동일 과제·동일 역할 횟수·동일 Git baseline
- 합산 최대 `$0.50`, 60 gateway calls, 80K input/10K output 사전 상한

현재 운영 gateway는 versioned billing 응답 계약을 활성화하지 않아 정본 계약의 price version과 journal key pin을 채울 수 없다. 기존 금융 영수증 runner는 계속 유료 호출 0건으로 `unavailable`을 반환한다. 이번 별도 Azure live runner는 이 게이트를 약화하지 않고, 공급자 보고 토큰과 고정 Azure 단가라는 더 좁은 근거로만 비용을 계산했다.

## 결론

- **구조 효율:** 증명됨. 하나의 Pi-only 지속 루프가 다중 이슈, 역할 분리, 쓰기 단일화, 수리/리뷰 수렴, 예산·재시작을 관리한다.
- **비용 효율:** 고정 소형 과제의 엄격 live paired 1회에서 Azure 단가 정규화 비용을 74.03% 줄였다. Grok 4.3 직접 meter가 없어 proxy 추정치다.
- **성능 효율:** 같은 실행에서 혼합 조합이 31.66% 느렸다. 비용 절감이 처리 효율 전체의 개선을 뜻하지 않는다.

원시 증거:

- [`pi-cost-comparison.json`](../orchestration/pi-cost-comparison.json)
- [`azure-price-snapshot-2026-08-01.json`](../orchestration/azure-price-snapshot-2026-08-01.json)
- [`azure-model-pair-live-2026-08-04-v2-r1.json`](../results/azure-model-pair-live-2026-08-04-v2-r1.json) — 엄격 게이트 유효
- [`azure-model-pair-live-2026-08-04.json`](../results/azure-model-pair-live-2026-08-04.json) — 옛 품질 게이트 무효
- [`azure-model-pair-live-2026-08-04-r2.json`](../results/azure-model-pair-live-2026-08-04-r2.json) — 옛 품질 게이트 무효
- [`pi-continuous-loop-deterministic.json`](../results/pi-continuous-loop-deterministic.json)
- [`issue-team-deterministic.json`](../results/issue-team-deterministic.json)
- [`multi-issue-deterministic.json`](../results/multi-issue-deterministic.json)
- [드리프트 방지 종합보고서](04-drift-prevention-summary.md)
