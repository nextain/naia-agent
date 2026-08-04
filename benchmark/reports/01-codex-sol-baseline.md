# 벤치마크 1 — Codex Sol 전역 기준선

## 목적

Naia, 개발 모더레이터, 구현 작업자, 결과 보고자를 모두 `gpt-5.6-sol`로 실행한 구성을 비용·품질 기준선으로 고정한다. 로컬 결정론 verifier만 모델 호출을 하지 않는다.

## 구성

| 역할 | 모델 | reasoning |
|---|---|---|
| Naia/facing | `gpt-5.6-sol` | low |
| moderator | `gpt-5.6-sol` | high |
| worker | `gpt-5.6-sol` | high |
| reporter | `gpt-5.6-sol` | low |
| verifier | local deterministic command | 해당 없음 |

과제는 `math.mjs`의 `add()`만 고쳐 고정 Node 테스트를 통과시키는 단일 파일 수정이다. 다른 파일 변경은 실패다.

## 실행 결과

| 실행 시각(UTC) | 상태 | 환산 비용 | actor latency 합 | 비교 채택 |
|---|---:|---:|---:|---:|
| 2026-08-01 19:46 | 완료 | `$0.200246` | `50.801초` | 예 |
| 2026-08-01 21:02 | 실패 | `$0.243951` | `59.040초` | 아니오 |
| 2026-08-01 21:31 | 완료 | `$0.248749` | `57.184초` | 예 |

유효 paired 반복 2회의 평균은 다음과 같다.

- 완료당 평균 환산 비용: **`$0.2244975`**
- 완료당 평균 actor latency 합: **`53.9925초`**
- 평균 입력 토큰: `145,279.5`
- 평균 출력 토큰: `1,126`
- 환산 1달러당 완료: **`4.454`건**

전체 3회 관찰에서는 2회 완료, 1회 실패다. 실패 실행은 `profile_request_exact`와 전 영수증 게이트를 충족하지 않아 비용 비교에서 제외됐지만, 실제로 관찰된 소비를 숨기지는 않는다.

## 판정

Sol 전역 구성은 두 유효 반복에서 품질 게이트를 모두 통과했으므로 기준선 역할을 한다. 그러나 3회 중 1회 실패했고 과제가 매우 작으므로 “Sol이면 항상 안전하다”는 결론은 낼 수 없다. 이 보고서의 수치는 Naia 오케스트레이션의 기준 비용이지 Sol 자체의 범용 코딩 벤치마크가 아니다.

## 가격과 증거 경계

고정 스냅샷은 Sol 입력 `$5`, 캐시 입력 `$0.50`, 출력 `$30`/100만 토큰을 사용한다. 2026-08-04 확인한 [OpenAI 공식 모델 목록](https://developers.openai.com/api/docs/models)과 [Codex rate card](https://help.openai.com/en/articles/20001106-codex-rate-card)도 같은 상대 가격을 표시한다.

원시 증거:

- [`single-issue-live-1785613592742.json`](../results/single-issue-live-1785613592742.json)
- [`single-issue-live-1785618174141.json`](../results/single-issue-live-1785618174141.json)
- [`single-issue-live-1785619885488.json`](../results/single-issue-live-1785619885488.json)
- [`openai-price-snapshot-2026-07-29.json`](../orchestration/openai-price-snapshot-2026-07-29.json)
