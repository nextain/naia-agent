# Naia 코딩 오케스트레이션 드리프트 방지 종합보고서

## 정렬된 목표

naia-agent의 목표는 Codex나 Claude보다 강한 완전 독립 코딩 모델을 만드는 것이 아니다. 사용자와 대화하는 Naia가 여러 프로젝트·이슈를 다중 세션으로 나누고, 역할과 비용 프로파일에 맞는 Codex·Claude·OpenCode·Pi/Naia 작업자에게 시키며, 진행·검증·비용을 정직하게 보고하는 오케스트레이터가 되는 것이다.

현재 단계는 naia-agent 단독 CLI/stdio에서 그 처리 계층을 검증하는 단계다. Discord 실제 ingress와 naia-shell UI 결합은 범위 밖이며, 이를 완료로 오인하지 않는다.

## 발견하고 차단한 드리프트

| 드리프트 유형 | 실패 형태 | 차단/수정 | 남은 경계 |
|---|---|---|---|
| 제품 목표 | OpenCode 대체용 완전 코딩도구로 과확장 | 세션 계약을 “비서형 다중 이슈 오케스트레이션 + Pi 진입장벽 완화”로 재고정 | naia-shell 사용자 표면은 후속 |
| 런타임 의존성 | Pi-only 경로가 OpenCode import/spawn/fallback에 다시 의존 | import closure와 별도 detector self-test로 OpenCode runtime edge 0 검증 | 레거시 OpenCode 어댑터는 명시 선택 시에만 존치 |
| 활성 모델 설정 | Discord 역할 위임이 시작 시점 설정을 계속 사용 | workspace 변경·settings reload 뒤 expert/main/sub 역할을 다시 해석 | 실제 Discord bot ingress smoke 미실행 |
| 처리정책 | delegated sub-LLM 호출이 어느 provider/model로 처리되는지 승인·공개되지 않음 | 역할별 `sub_llm` processing plan을 실행 전에 공개하고 fail-closed 승인 | Shell UI disclosure는 후속 |
| 승인/실행 TOCTOU | 이전 모델을 승인한 뒤 reload된 새 모델이 실행될 수 있음 | 승인된 processing plan을 실행 직전 활성 plan과 재비교 | 외부 provider 자체 변경은 영수증 검증 필요 |
| Codex native tool | processing metadata가 있는 `delegate_agent`가 Codex app-server 도구 목록에서 사라짐 | tier-none processing tool을 노출하고 native callback에도 동일 승인 경로 적용 | Claude Code main의 custom Agent tool 광고는 별도 갭 |
| provider identity | Codex 역할이 `openai` API-key 경로로 잘못 매핑 | Pi의 `openai-codex` OAuth/account 경로로 고정 | 실제 계정 로그인 live smoke 필요 |
| 모델 capability | 분석 전용 DeepSeek가 파일을 수정할 수 있는 것처럼 실행 | DeepSeek V4 Flash/Pro를 `--no-tools`, 구현자만 workspace write | 모델 catalog 변경 시 capability 재검증 |
| secret 경계 | Naia 키가 설정/로그/부모 환경에 남거나 child에 전달되지 않음 | OS keychain에서 읽어 child-only env로 spawn, 직렬화·로그 금지 | 실제 운영 키로 smoke하지 않음 |
| gateway 모델 | 요청 모델과 응답 모델이 달라도 비용·품질 증거로 채택 | exact model mismatch 즉시 거부 | gateway 서버 서명은 아직 없음 |
| 예산 우회 | Pi tool-loop의 후속 gateway 호출이 최초 예약 밖에서 과소계상 | gateway request별 공유 durable pre-fetch budget 예약 | live 가격 version pin 필요 |
| 중복 과금 | timeout/restart/retry가 같은 유료 효과를 재실행 | stable idempotency, lease/checkpoint, unknown outcome 보존, settled retry 거부 | 공급자 측 idempotency 보장은 별도 확인 |
| 초과 사용 은폐 | 실제 사용량이 예약을 넘으면 실패하면서 소비 증거도 사라짐 | 초과 영수증을 먼저 commit한 뒤 작업 실패 | 미정산 공급자 응답은 unavailable 유지 |
| 부분 실패 은폐 | runner/setup/SQLite/출력 충돌 뒤 결과 파일이 사라짐 | exclusive output ownership, durable partial/unavailable 결과 | 디스크 자체 손상은 운영 복구 범위 |
| 재시작 위장 | 같은 프로세스에서 hash만 다시 읽고 “재시작 복구” 주장 | 독립 프로세스 reopen과 exact checkpoint 비교 | 장시간 실제 장애 주입은 확대 필요 |
| 역할/쓰기 경계 | reviewer/explorer가 수정하거나 역할 receipt identity가 섞임 | implementer 단독 write, 나머지 read-only, receipt identity 분리 | 외부 CLI sandbox 실동등성 지속 검증 |
| 검증 드리프트 | 모델 자기보고를 성공으로 신뢰 | 로컬 결정론 verifier, 변경 파일 allowlist, hard gate 전부 통과 시에만 완료 | 실제 프로젝트별 test/build 계약 필요 |
| source/dist | 오래된 dist를 실행하고 최신 source 결과로 보고 | 실행 artifact digest와 source import closure 결박 | 현재 미커밋 후보는 최종 재생성 필요 |
| 비용 주장 | fixture/추정가/time-window 로그를 실제 절감으로 발표 | gateway 공급자 보고 토큰과 고정 Azure 단가로 live 원가를 계산하고 금융 영수증 주장과 분리 | 운영 versioned billing 미활성으로 고객 청구 영수증 검증은 남음 |
| 운영 배포 드리프트 | 소스에는 versioned billing이 있지만 운영 응답에는 금융 필드가 없음 | 운영 설정 `versioned_billing_enabled=false`를 확인하고 Azure 원가 증거로 범위를 축소 | 전체 사용자 영향 검토 없이 운영 과금 모드 활성화 금지 |
| 안전 필터 오탐 | Grok 구현 프롬프트가 Azure `Jailbreak` 필터로 중단 | 과제 의미를 유지하며 과도한 명령형 메타 문구를 제거하고 실패 시도는 paired 분모에서 제외; runner는 실행 전 출력 선점 후 호출마다 부분 증거 저장 | 공급자 오류가 토큰을 누락하면 해당 실패 비용은 unknown 유지 |
| 범위 침범 | Discord token/등록/UI까지 이번 완료로 포함 | 실제 ingress·enrollment·naia-shell UI를 명시적 non-goal로 유지 | 후속 계약 필요 |
| 완료 선언 | 테스트 일부 통과만으로 merge-ready 주장 | 동일 후보 외부 적대리뷰 2회 연속 Clean 요구 | Clean이어도 인증된 live-pair 등 운영 전제조건이 남아 merge-ready 아님 |

## 벤치마크가 직접 검증한 복구 알고리즘

드리프트를 지적하는 것만으로는 부족하므로 상태 전이를 결정론 게이트로 만들었다.

1. 요청과 역할 프로파일을 checkpoint에 고정한다.
2. 유료 호출 전에 actor attempt와 gateway request 예산을 예약한다.
3. 실행 결과가 모호하면 성공/실패로 꾸미지 않고 `unknown`을 보존한다.
4. 같은 idempotency key의 유료 효과를 자동 재생하지 않는다.
5. 검증 실패만 제한된 repair cycle로 되돌린다.
6. Clean 리뷰 요구 횟수와 repair 상한에 도달하면 terminal 상태로 닫는다.
7. 재시작 뒤 checkpoint, receipt, budget을 다시 읽어 중복 없이 이어간다.
8. 활성 모델·processing plan이 승인 시점과 다르면 spawn 전에 거부한다.

결정론 결과는 restart exact, duplicate blocked, exhaustion blocked, receipt conflict blocked, drift blocked and reserved, repair observed, verification failure preserved, no OpenCode edge를 모두 true로 기록한다.

## 현재 신뢰할 수 있는 결론

- Codex 내부 역할 분리는 작은 고정 과제의 유효 paired 2회에서 전 역할 Sol 대비 **50.17% 비용 절감**, 품질 동률, 지연시간 사실상 동률이었다.
- Pi-only 다중 이슈/역할 하네스는 재시작·중복·예산·쓰기 경계·검증 실패를 결정론적으로 다룬다.
- Discord 역할 서브에이전트가 활성 설정과 승인된 processing plan을 따르도록 코드·계약 테스트를 보강했다.
- DeepSeek–Grok 혼합 경로는 엄격 live paired 1회에서 Azure 단가 정규화 비용 74.03% 절감과 제안 내용·tester·reviewer 게이트 동률을 보였지만 31.66% 느렸다. Grok 4.3 직접 meter가 없어 가격은 proxy다.
- Azure 벤치 runner·가격 snapshot·정본 결과·보고서 변경분은 응답 모델 결박, 실패 영속, 품질 게이트, 가격 출처, Pi 경계를 수정한 뒤 독립 적대 검토 2회에서 각각 `CLEAN`을 받았다. 이는 이 벤치 변경분의 판정이며 전체 브랜치 merge-ready 판정을 대신하지 않는다.
- GPU1 사용자 소유 모델의 3레이어 자격 검증은 완료됐지만, 실제 Discord ingress, Claude Code main custom-tool 경로, Codex OAuth live auth, 인증된 live-pair 전제조건이 남아 있으므로 외부 Clean 여부와 별개로 현재 브랜치를 REQ-024 전체 완료나 main merge-ready로 표시하면 안 된다.

## 다음 증명 순서

1. 변경 없는 후보를 고정하고 source/dist digest를 재생성한다.
2. Codex 계정 인증 경로와 Claude Code main 도구 노출 범위를 별도 smoke로 확인한다.
3. 운영 versioned billing 활성화는 별도 배포 검토로 다루고, 활성화 전에는 Azure 원가와 고객 청구 영수증을 혼동하지 않는다.
4. 다중 파일·실패 수리·모호한 요구·병렬 이슈 코퍼스로 Codex 및 DeepSeek–Grok 역할 조합을 확대한다.
5. 외부 적대리뷰 2회 연속 Clean은 코드 후보의 필수조건으로 유지하되, 인증된 운영 전제조건까지 닫힌 뒤에만 merge 판정을 갱신한다.

근거:

- [`REQ-024 review record`](../../.agents/reviews/r-req-024-pi-continuous-loop-2026-08-04.json)
- [`Pi loop deterministic result`](../results/pi-continuous-loop-deterministic.json)
- [`Issue-team deterministic result`](../results/issue-team-deterministic.json)
- [`Codex 역할별 조합 보고서`](02-codex-role-combination.md)
- [`Pi/Naia 혼합 조합 보고서`](03-pi-naia-mixed-combination.md)
