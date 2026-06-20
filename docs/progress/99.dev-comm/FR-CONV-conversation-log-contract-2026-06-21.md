# FR-CONV — Conversation Log (transcript 영속) 계약

> 계약 backfill (2026-06-21): conversation-log 코드(ports/conversation-log.ts,
> adapters/conversation-log-store.ts)가 구현·배선돼 있었으나 계약 문서가 없어
> file-anchor 게이트 RED 였다. 코드 헤더에서 계약을 distill해 명문화한다(agent#2).

## 책임 (FR-CONV.1)

turn 종료 시, 그 턴의 **verbatim 대화 turn**(user 발화 + assistant 응답)을 세션
transcript 에 append 한다. 전두엽(agent)이 자기 출력을 기록 — brain-body-environment
원칙상 "대화 = 뇌의 활동 → 뇌가 기록". `naia-memory.save` 와 형제 seam.

## 불변식

- **단일 writer**: 이 포트는 *쓰기* 만 책임진다. 읽기는 shell(Rust IPC) · naia-memory 가
  파일을 직접 읽는다(직교, agent 독립 — E1). agent 는 reader 를 갖지 않는다.
- **no-throw 격리** (핵심): `append` 의 모든 실패는 swallow 한다. transcript 누락이
  turn / finish / memory.save 를 깨뜨리지 않는다. *transcript 누락 < 대화 중단.*
- **코어 순수**: `src/main` 은 `node:fs` 를 직접 import 하지 않는다. `FsLike` + `join`
  주입(entry = node:fs/path, 테스트 = fake). file-memo-store 패턴과 동일.

## 저장 형식

- 경로: `{conversationsDir}/{sessionId}.jsonl`
- append-only, 1줄 = 1메시지 JSONL. 버퍼링 없음 → crash-safe, `close` 불요.
- `sessionId` = shell `localSessionId`(chat.ts ChatRequest.sessionId). 누락 시 단일 fallback.

## Phase 2 예약 (FR-CONV.5)

`ConversationTurnRecord` 에 음향/시각 modality 필드 예약(음성·노래 = UC2). 현재는
text turn 만 기록.

## 앵커

| 파일 | layer |
|------|-------|
| `src/main/ports/conversation-log.ts` | ports — `ConversationLogPort` + `ConversationTurnRecord` |
| `src/main/adapters/conversation-log-store.ts` | adapters — 파일영속(JSONL append, FsLike 주입) |

배선: `composition/index.ts` 가 `conversationLog?` 주입(미주입 = transcript 미기록, 무회귀).
`app/chat-turn-handler.ts` 가 turn 종료 seam 에서 append.
