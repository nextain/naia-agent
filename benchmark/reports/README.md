# Naia coding orchestration benchmark reports

이 디렉터리는 같은 질문을 서로 다른 증거 수준으로 나눈다.

1. [Codex Sol 기준선](01-codex-sol-baseline.md) — 모든 유료 역할을 Sol로 실행했을 때의 기준 비용과 성공 여부
2. [Codex 역할별 조합](02-codex-role-combination.md) — Luna–Sol–Terra 역할 분리가 Sol 기준선보다 얼마나 절감됐는지
3. [Pi/Naia 혼합 조합](03-pi-naia-mixed-combination.md) — DeepSeek–Grok 및 Codex/OpenCode/Pi 혼합 하네스에서 현재 증명된 것과 아직 증명되지 않은 것
4. [드리프트 방지 종합보고서](04-drift-prevention-summary.md) — 구현·검토 중 발견해 차단한 목표, 모델, 권한, 비용, 재시작 드리프트
5. [사용자 소유 24GB 모델](05-user-owned-24gb-models.md) — GPU1 로컬 모델의 컨텍스트·툴콜·3레이어 완주와 후보별 제품 적합성

## 한눈에 보는 결론

| 비교 | 품질 게이트 | 비용 결론 | 시간 결론 | 증거 등급 |
|---|---:|---:|---:|---|
| 전 역할 Codex Sol | 유효 반복 2/2 통과, 전체 시도 2/3 통과 | 유효 반복 평균 `$0.2244975`/완료 | 유효 반복 평균 `53.993초` | 2026-08-01 실호출 토큰 영수증 + 고정 요율 환산 |
| Codex Luna–Sol–Terra | 유효 반복 2/2 통과, 전체 시도 3/3 통과 | Sol 대비 유효 반복 합산 **50.17% 절감**, 달러당 완료 **2.01배** | Sol 대비 평균 **0.15% 느림** — 사실상 동률 | 동일 과제 paired 실호출 2회 |
| Pi/Naia DeepSeek–Grok | 엄격 live paired 1/1 통과; 이전 2회는 reviewer 결함으로 무효 | Azure 단가 정규화 **74.03% 절감** | 혼합 조합 **31.66% 느림** | DeepSeek 직접 meter + Grok 4.2 Global 가격 proxy; 금융 영수증 필드는 운영 미활성 |

`$` 수치는 실제 청구서가 아니라 정확한 Codex CLI 사용량에 2026-07-29 고정 API 등가 요율을 적용한 분석 환산값이다. 현재 공식 요율도 Sol `$5/$30`, Terra `$2.50/$15`, Luna `$1/$6`(입력/출력 100만 토큰당)로 고정 스냅샷과 일치한다. Codex 계정 크레딧은 동일 토큰 구성에 대해 별도 rate card로 계산해야 한다.

DeepSeek–Grok 비용은 운영 gateway에서 실제 모델을 호출한 공급자 보고 토큰을 Azure Korea Central 단가로 정규화했다. DeepSeek V4 Flash는 직접 meter지만 Azure가 Grok 4.3 meter를 아직 공개하지 않아 Grok은 운영 단가와 일치하는 Grok 4.2 Global meter proxy다. 현재 운영 배포는 versioned billing이 꺼져 있어 `customer_cost`·`price_version_id` 금융 영수증도 없다. 따라서 청구 확정액이 아니라 단가 정규화 추정치다.

## 공통 판정 규칙

- 동일 과제, 동일 변경 허용 범위, 동일 결정론 검증을 통과한 paired 실행만 절감률에 포함한다.
- 완료, 수용 검사, 의무 보존, 독립 actor identity, dispatch 안정성, 요청 프로파일 일치, 전 역할 비용 영수증이 모두 참이어야 한다.
- 실패하거나 영수증이 빠진 실행은 실제 소비 사실은 남기되 절감률 계산에서는 제외한다.
- 작은 코퍼스 한 과제의 결과를 일반적인 코딩 성능 우위로 확대하지 않는다.

## 2026-08-04 재검증 상태

- 단일 이슈 비용 게이트 8개, Pi 지속 루프 1개, Pi live 비용 runner 11개: **20개 통과**
- issue-team과 다중 이슈 22개: 현재 샌드박스가 runner의 자식 `git merge-base`를 `EPERM`으로 차단해 실행 전 provenance 단계에서 중단
- Markdown 로컬 근거 링크, `git diff --check`, 루트 구조 계약: **통과**

따라서 아래 issue-team·다중 이슈 판정은 저장소에 고정된 재현 산출물의 결과이며, 현재 미커밋 후보에서의 완전 재실행은 샌드박스 밖에서 다시 확인해야 한다. 이 환경 차단을 기능 실패나 통과로 바꾸어 해석하지 않는다.
