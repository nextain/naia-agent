# Security Wire v2 계약 — processing profile과 처리 위치 공개

상태: `GUARDIAN PASS` — 2026-07-19, BLOCKER 0 / WARN 0

## 사용자 시나리오

- 기존 text-only 요청은 새 필드 없이 기존 동작을 유지한다.
- Shell/Discord 요청은 실제 profile 내용이나 secret 대신 opaque
  `processingProfileRef`만 전달한다.
- Discord 요청의 reference는 message나 모델 출력이 아니라 신뢰 binding과
  일치해야 한다. 부재·불일치는 downstream 전에 차단한다.
- 각 실제 operation은 `local_device | private_managed | external_cloud` 처리
  위치를 먼저 공개한다. cloud와 cloud embedding을 일괄 금지하지 않지만 선택한
  profile 밖으로 몰래 전환하지 않는다.

## 계약

- `ChatRequest.processing = 14`
- `AgentEvent.processing_disclosure = 20`
- disclosure field:
  `workload=1,destination=2,decision=3,processing_profile_ref=4,provider=5,model=6`
- error enum:
  `PROCESSING_PROFILE_REQUIRED=21`,
  `PROCESSING_DESTINATION_UNKNOWN=22`,
  `EXTERNAL_PROCESSING_FORBIDDEN=23`,
  `EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED=24`
- raw endpoint, prompt/message/memory 원문, secret, credential 해석값은 wire와
  오류에 넣지 않는다.
- ingress가 보낸 `actualDestination` 같은 추가 필드는 domain으로 승격하지 않는다.
- disclosure는 폐쇄 필드 집합과 enum/ref/길이를 검증한다.
- `allowed`는 `processing_disclosure → downstream`,
  `blocked|confirmation_required`는 `processing_disclosure → error` 순서다.
- 확인 증거는 wire 밖 trusted store의 opaque `consentId` 기록이다. profile,
  destination, workload, session, expiry에 결속하고 원자적 claim이 성공해야
  한다. `expiresAt <= now`, 비정상/음수 시각, 재사용, scope 불일치는 확인
  없음과 같다.

## 테스트 맵

| ID | 검증 |
|---|---|
| T-SEC-WIRE-01 | stdio/gRPC processing decode에서 위조 destination 미승격 |
| T-SEC-WIRE-02 | disclosure stdio/gRPC encode와 proto 번호·enum |
| T-SEC-WIRE-03 | Discord profile 부재·binding 부재·불일치 fail-closed |
| T-SEC-WIRE-04 | processing-only inline apiKey/naiaKey zero-transit |
| T-SEC-WIRE-05 | disclosure 폐쇄 validator와 값 미반향 |
| T-SEC-WIRE-06 | disclosure 선행 순서 plan |
| T-SEC-WIRE-07 | consentId 재구성 재사용·expiry equality/비정상 시각·4축 scope 반례 |

## 비범위

실제 endpoint 분류 metadata, profile 저장·해석, consent store 구현,
embedding/memory/network-tool runtime 결선, Shell Rust codec/UI는 후속
worktree 소유다.
