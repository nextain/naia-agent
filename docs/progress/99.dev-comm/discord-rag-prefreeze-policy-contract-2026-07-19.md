# Discord·RAG 동결 전 순수 정책 계약

연결 이슈: nextain/naia-agent#85, #86.

이 slice는 인증된 이벤트 필드에 대한 fail-closed ingress 판정과 검색 record
정규화만 소유한다. #89 공통 wire·composition, 실제 retrieval/provider,
durable dedupe와 reconnect lifecycle은 구현하거나 완료로 주장하지 않는다.

상태: `WIP / INTEGRATION BLOCKED_BY_CONTRACT`.
