# Discord·RAG 동결 전 순수 정책 계약

연결 이슈: nextain/naia-agent#85, #86.

첫 commit은 인증된 이벤트 필드에 대한 fail-closed ingress 판정과 검색 record
정규화만 소유했다. 후속 runtime slice는 #89 공통 wire를 선행 반영하고,
Discord Gateway Identify/Resume lifecycle, 정확한 binding/친구 등록, durable
reply outbox와 기존 agent ingress/reply, provider 직전 processing guard 결선을
소유한다. 실제 retrieval/provider 구현은 재사용하며,
실제 token test guild smoke는 opt-in live 검증으로 분리한다.

상태: `RUNTIME IMPLEMENTATION REVIEW`.

## Tool progress egress contract

- `toolUse` and `toolResult` are emitted to the originating Discord message in
  event order as bounded, structured status lines:
  `TOOL_PROGRESS state=<running|succeeded|failed> tool=<safe-name>`.
- Tool arguments, result output, call identifiers, credentials, and exception
  details are never reflected into the progress line. A tool name outside the
  strict safe-name alphabet is replaced with `tool`.
- Progress delivery is advisory and non-terminal. Delivery failure is classified
  without changing the chat turn; the final answer continues through the existing
  durable `replying(outbox cursor)` path and remains the only terminal reply.
- Generation authority, lifecycle abort, exact originating guild/channel/message,
  and per-turn emit ordering apply before every progress send.
