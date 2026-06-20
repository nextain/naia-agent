# FR-COMPACT — Compaction host-loop (정보보존형 대화 압축) 계약

> agent#3. naia-memory 가 `compact()`+`attachHandoff()`(rolling summary·라이트모델 요약·
> 32 테스트 green)를 구현해 뒀으나 agent 소비자가 없었다(드롭형 budgeted-conversation 만).
> 이 계약은 agent 측 **소비자(host-loop)** 를 정의한다 — 예산 압박 시 head 를 *요약*해 교체.

## 책임

대화 토큰이 임계를 넘으면, 턴 조립(assemble) **전에** head(오래된 메시지)를 naia-memory 가
recap(요약)으로 만들고, 그 recap 을 systemPrompt 에 주입한 뒤 메시지는 최근 tail 만 provider 로
보낸다. recap+anchors 는 장기기억에 영속(cross-session 연속성)한다.

- **드롭형(budgeted-conversation) ≠ 이것.** 드롭은 *정보 손실* 하드 가드(최종 백스톱). 이건 그보다
  *먼저* 도는 **정보보존형**(요약). 둘은 직교: compaction 이 tail 로 줄인 뒤에도 budgeted-conversation
  이 최종 토큰예산 가드로 한 번 더 절단할 수 있다.

## 포트 (ports/compaction.ts)

- `compact({messages, keepTail, targetTokens}) → {recap, droppedCount}` — head 를 targetTokens 예산의
  recap 으로 요약, 최근 keepTail 개는 원문 보존. `droppedCount 0` = 압축 미수행(호출측 원본 유지).
- `attachHandoff({sessionId, recap, anchors, trigger, turnCount, totalTokens})` — recap+anchors 를
  장기기억에 영속. 호출측은 fire-and-forget + no-throw.

구현 = `adapters/naia-memory.ts`(같은 `MemorySystem` 의 `compact`/`attachHandoff` 위임). `makeNaiaMemory`
반환 = `ManagedMemoryPort & CompactionPort`(한 인스턴스).

## 불변식 (host-loop = app/chat-turn-handler.maybeCompact)

- **무회귀**: `compaction` 미주입 = 압축 없음(기존 동작). 임계 이하 또는 메시지 ≤ keepTail = 원본 유지.
- **provider-safe**: (1) recap 은 *메시지*가 아니라 **systemPrompt 에 주입**("## 이전 대화 요약(compacted)")
  — leading assistant recap 으로 provider 가 거부하는 것 회피. recall 주입과 동일 패턴(recap → 그 뒤 recall append).
  (2) **tail 선두를 user 경계에 정렬** — keepTail 이 assistant/tool 경계에 떨어지면 `(len-keepTail)` 부터 첫 user 까지
  전진해 그 앞을 recap 이 흡수, tail 은 user 로 시작. 엄격 provider(Anthropic Messages API)가 leading assistant/tool 을
  400 거부하는 것 차단(적대리뷰 갭 #3). 경계 조정이라 정보손실 0.
- **no-throw 격리**: compact 실패/timeout(raceAbort null)·droppedCount 0·빈 recap = 원본 유지(드롭 폴백).
  attachHandoff 는 fire-and-forget(실패해도 턴 진행). *요약 실패 < 대화 중단.*
- **deadline**: compact 는 recall 과 같은 deadline(기본 5s)으로 bound — 무응답 시 원본으로 진행(terminal 항상 방출).
- **현재 입력 보존**: 마지막 user 입력은 tail 에 항상 포함 → recall query/save 대상 불변.

## 앵커

| 파일 | layer |
|------|-------|
| `src/main/ports/compaction.ts` | ports — CompactionPort + 타입 |
| `src/main/adapters/naia-memory.ts` | adapters — compact/attachHandoff 위임(기존 앵커) |
| `src/main/app/chat-turn-handler.ts` | app — maybeCompact host-loop(기존 앵커) |

기본값(미주입 시): threshold 4000 추정토큰 · keepTail 6 · targetTokens 1000. anchors 추출은 후속(현재 []).
