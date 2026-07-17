# UC-CONTINUE-SPEAKING 계약 — 사용자 요청에 따른 연속 발화

- 날짜: 2026-07-16 (2026-07-17 v3 전면 재설계)
- 상태: 🟡 **v3 하이브리드 설계 초안 — planning 적대 패널 2회 연속 CLEAN 전까지 구현 착수 금지.**
  - v1 quote 가드(2026-07-16): **기각** — 활성화 시 모델 quote 는 100% 원문 전체 → 판정 무력(B1 실측).
  - v2 승인 게이트(2026-07-17): **기각** — planning 패널 2/2(FINDINGS 8+10). 음성 데드락 · "항상 허용" 자폭.
  - **v3 하이브리드(아래 "기능 설계 계약 v3")**: 사용자 확정(2026-07-17) — ①+② 즉시 / ①만 확인질문 /
    활동 수명 재범주화. 근거 = B1 베이스라인(`.agents/reviews/issue-82-tool-selection-baseline-dev.json`) +
    codex 크로스리뷰(`issue-82-recategorization-codex-2026-07-17.json`). P01 = `docs/user-scenarios.md`
    UC-CONTINUE-SPEAKING(2026-07-17 개정) 이 사양 SoT.
  상세 이력 = `.agents/progress/issue-82-continuous-speech.md`.

## 기능 설계 계약 v3 (2026-07-17 — 하이브리드 활성화 + 활동 수명)

1. **범주**: 연속 발화는 사용자에겐 모드, 런타임에겐 **활동(activity)** 이다. `continue_speaking` 도구
   호출은 활동의 **시작 명령**이고, 활성화 이후의 상태(pending 확인·활성·발화 수·deadline)·정지·저장·수명은
   턴 지역변수가 아니라 명시적 활동 상태가 소유한다(FR-CONT-7).
2. **도구 스키마**: `continue_speaking(userRequestQuote, awayEvidence?, topic?, durationMinutes?, pauseSeconds?)`.
   `userRequestQuote` = ①(끝을 정하지 않은 연속 요청) 근거 원문 인용, `awayEvidence` = ②(부재/수동청취/다른 일)
   근거 원문 인용. **의미 판정은 모델의 semantic tool 선택**이며 app 은 quote/evidence 내용으로 의미를
   재판정하지 않는다(키워드·정규식 금지 불변). app 이 보는 것은 **② 근거 필드의 유무**(정규화 후 비어있지
   않음)뿐이다 — 내용 검증이 아니라 모델의 자기보고 구조화. B1 실측 근거: 모델은 ② 없이(부재만 0/15)
   활성화하지 않고 ① 이면 일관 활성화(①만 3건 = 100%) — 즉 ①/② 인식 능력은 있고, 그 인식을 필드로
   구조화해 받는 것이다.
3. **전이 규칙 (app 강제 상태기계)**:
   - `awayEvidence` 있음 → **즉시 활성화** (기존 활성화 경로).
   - `awayEvidence` 없음 → 활성화하지 않고 숨은 tool result 로 "사용자에게 짧게 확인 질문을 하라"를
     thread → 모델이 **일반 text 발화**로 확인 질문("계속 이야기해줄까?")을 생성 → app 은
     `pending_confirmation(sessionId, 원 인자, expiresAt = now + TTL 2분)` 을 기록하고 턴을 정상 종료한다
     (terminal/usage/save 각 1회 — 일반 턴과 동일 형태).
   - **pending 상태의 다음 사용자 턴**: app 이 provider-local 로 "확인 대기 중" 컨텍스트를 붙이고 제어
     도구를 재노출한다. 모델이 긍정으로 판정해 도구를 재호출하면(이때 evidence 불요) 활성화, 아니면
     pending 해제 후 일반 턴. **긍정 판정도 모델 몫** — app 은 "응" 을 정규식으로 찾지 않는다.
   - pending 은 sessionId 에 결속되고 TTL 만료·취소(`cancel_stream`)·활성화 소비 시 해제된다.
     pending 밖에서 온 도구 재호출은 일반 신규 요청으로 취급한다(evidence 규칙 처음부터 적용).
   - 확인 질문은 새 wire 이벤트가 아니다 — 셸·proto 변경 0 유지(NFR-CONT-agent-owned).
4. **증분 보존**: 완결 방출된 발화는 즉시 체크포인트(활동 소유 저장) — 비정상 종료(에러·경계·취소)에도
   유실 0. 취소가 버리는 것은 진행 중 미완 발화뿐(FR-CONT-5, S-CONT-6).
5. **예산 분리**: 외부 도구 라운드 캡은 발화 단위로 리셋(FR-CONT-6). 소비 후 제어 도구 재호출은
   turn kill 이 아니라 조용한 거부 result(v1 의 terminalError 경로 폐기).
6. **유한 경계·취소·컨텍스트 유지·기록 정합**: 기존 §5~§9(v1) 중 활성화 판정과 무관한 조항은 유지하되
   "wire 은닉" 표현은 "제어 도구 호출은 provider-local 로 완결하며 wire 에 제어 이벤트를 만들지 않는다"
   로 복원한다(v2 의 approvalRequest 노출 폐기).
7. **벤치 게이트**: B1(진입: false-call/miss) · B2(확인질문: ①만 → ask 율) · B3(정지 오인) ·
   B4(장기 발화 품질) — `.agents/progress/issue-82-continuous-speech.md` §벤치마크 스위트. 모델 교체 시
   전체 재실행 의무. 게이트 임계값은 B3(정지 비용) 측정 후 확정.

---
## (기록) v2 기각 사유 및 v1 원문 — 아래는 이력 보존용이다. 구현 지시가 아니다.
- GitHub Issue: https://github.com/nextain/naia-agent/issues/82
- 추적: REQ-013 → UC-015 → SPEC-012 → TEST-S-015 / TEST-F-012
- 구현 경계: `naia-agent` app 계층. `naia-shell`·gRPC proto 변경 없음.

## 사용자 시나리오

사용자가 "라디오처럼 뭐라도 계속 이야기해 줘. 난 씻고 올게"라고 명시적으로 요청하면 Naia는 한 번만
답하고 멈추지 않는다. 같은 대화 흐름을 유지하며 짧은 이야기를 여러 번 이어 말한다. 사용자가 돌아와
말을 걸거나 중지하면 기존 끼어들기 경로로 즉시 멈추고, 새 사용자 턴을 정상 처리할 수 있다.

## 기능 설계 계약

1. `ChatTurnHandler`는 `continue_speaking` 내부 제어 도구를 일반 provider tool schema와 함께 노출한다.
   도구 설명은 최신 사용자가 명시적으로 계속 말해 달라고 한 경우에만 호출하고, 그 요청 부분을 필수
   `userRequestQuote`로 원문 그대로 복사하도록 한다.
2. ⛔ **아래 재설계는 2026-07-17 planning 적대 패널에서 기각되었다(2/2, FINDINGS 8+10). 구현하지 말 것.**
   기각 사유(전부 코드/실측 확인): (a) **음성 데드락** — 모달은 클릭 전용·TTS 미노출, STT "네"는
   `isChatRequestActive()` 때문에 `enqueueMessage` 로 처박히고 턴은 승인 대기 = 상호 봉쇄. 승인 timeout 부재로 무기한.
   **사용자 부재를 전제한 기능에 사용자 현존을 요구 = 자기모순.** (b) **"항상 허용" 원클릭 자폭** —
   `addAllowedTool` → `config.allowedTools` 영속 → 이후 `isToolAllowed` 가 모달 없이 자동 승인 →
   quote 가드까지 삭제된 상태라 **재설계 전보다 나쁨**. 33% 팝업이 만든 피로가 그 버튼을 누르게 하는 자기파괴 루프.
   (c) **오호출률 미저감** — AC1~AC14 중 팝업률을 한정하는 AC 0개. 문제를 UX 로 이동만.
   (d) UC `S-CONT-5`("미활성 시 동작 불변") 모순 · 계약 7행("셸 무변경")·176행("셸 라디오 UI = 범위 밖") 위반.
   (e) AC13 산술적 불가능(reject 시 "provider 호출 1회" ← 도구 라운드는 최소 2회).
   아래 본문은 **기각된 안의 기록**으로만 보존한다.

   ~~**활성화는 사용자 승인으로만 이루어진다(2026-07-17 재설계 — 이전 quote 가드 폐기).**~~
   `continue_speaking` 은 gated tool(`tier`)이며, 모델이 호출하면 app 은 **기존 `ApprovalPort` 게이트**를
   그대로 통과시킨다: `toolUse` → `approvalRequest`(payload = `userRequestQuote`·`topic`·`durationMinutes`·
   `pauseSeconds`) → 사용자 결정 → `toolResult`. **approve 에서만 활성화**한다. reject 는 기존 거부 경로
   (`도구 호출이 거부되었습니다`, `success=false`)를 그대로 타고 모델이 일반 응답을 끝까지 이어간다.
   `userRequestQuote` 는 필수 인자로 유지하되 **판정 게이트가 아니라 승인 페이로드**다 — 사용자가 "모델이
   무엇을 요청으로 이해했는지"를 보고 결정한다. app 은 quote 로 활성화 여부를 판정하지 않는다.
   언어별 키워드 정규식으로 의미를 추측하지 않는다(불변).

   **폐기 근거 — 이전 quote 가드는 작동하지 않았다**(2026-07-17 적대 리뷰 실측, 프로덕션 스키마,
   `dnotitia-dna3.0-9b-q4-16k:latest`, N=12):

   | 사용자 입력 | 구 가드 하 활성화 |
   |---|---|
   | `오늘 날씨 어때?` | **4/12 (33%)** |
   | `계속 이야기해 볼까? 넌 어떤 영화 좋아해?` | **6/12 (50%)** |

   활성화 시 모델이 넣는 quote 는 **100% 사용자 원문 전체**이고, 원문 전체는 자명하게 원문의 부분문자열이므로
   포함 판정은 **항상 통과**한다. 최소 길이·비율 하한으로도 고쳐지지 않는다(원문 전체는 모든 길이 기준을 통과).
   근본 원인 = **가드가 검사하는 것(출처: 모델이 지어냈는가)과 막아야 하는 실패(의도 오판: 사용자가 계속
   말해달라고 했는가)가 다른 축**이다. 의도 오판 시 모델은 사용자의 *실제 말* 을 정확히 인용하므로 출처
   검사로는 원리적으로 잡을 수 없다. 계약은 의도 판정을 provider 의 tool 선택에 위임했으나 그 선택이 이
   모델에서 33~50% 오작동하며, 가드는 그 뒤를 받치지 못했다.
   → 판정 주체를 **사람**으로 옮긴다. 오작동 비용이 "승인 1회 거부"로 유계가 되고, app 은 의미 추측을 하지 않는다.

   **2026-07-16 자 인용부호 정규화 개정과 그 근거는 함께 폐기**한다. 그 개정은 구멍을 만들지도 메우지도
   않았으나(개정 전 raw `includes` 도 동일하게 뚫려 있었다), "가드 목적은 불변" 이라는 당시 기술은
   가드에 실재하지 않는 방어력을 귀속시킨 **오기**였으므로 철회한다.
3. 제어 호출은 call id를 보존한 assistant tool-call과 정확히 한 개의 tool-result로 provider-local history에
   완결한다. **wire 에는 기존 gated tool 과 동일하게 `toolUse`/`approvalRequest`/`toolResult` 가 노출된다
   (2026-07-17 재설계 — 이전 "wire 은닉"은 승인 게이트와 양립 불가하므로 폐기).** 사용자가 승인하려면
   무엇을 승인하는지 보여야 한다. memory/conversationLog 에는 여전히 노출하지 않는다(실제 발화 텍스트만 저장).
   원래 대화와 첫 최종 발화 전 다중 도구 루프는 고정 기준점으로 보존하고, 활성 상태에서는
   **직전 최종 텍스트 1개**의 assistant 메시지와 숨은 진행 지시만 provider-local history에 붙여 같은
   `requestId`로 provider를 다시 호출한다. 이전 연속 발화를 60개까지 누적하지 않는다.
4. 숨은 진행 지시는 이전 이야기와 자연스럽게 연결하고, 한 번에 짧은 1~3문단만 말하며, 사용자가 없는
   동안 답변을 요구하는 질문이나 내부 제어 설명을 하지 않도록 지시한다.
5. 내부 지시는 wire, memory, conversationLog에 사용자 발화로 저장하지 않는다. 실제 방출된 assistant
   텍스트만 합쳐 원래 사용자 입력과 하나의 턴으로 저장한다.
6. 기존 AbortSignal을 provider 호출과 발화 사이 delay가 공유한다. 취소 결과와 terminal 불변식은 UC1과 같다.
   음성 끼어들기는 기존 셸처럼 현재 요청을 취소한 뒤 새 `requestId`의 턴을 시작한다. 취소 턴은 기존
   커밋 지점 이전 취소 규칙을 보존해 memory/conversationLog에 저장하지 않는다.
7. 제어 도구 활성화 단조 시각부터 기본 10분/최대 30분, 기본 간격 3초/허용 0~30초의 deadline을 두고,
   활성화 뒤 wire에 방출한 첫 최종 발화를 포함해 최대 60발화의 유한 경계를 둔다. 대기 전과 대기 직후
   `now >= deadline`을 검사해 같거나 넘으면 다음 provider 호출을 예약하지 않는다.
   지속시간은 **새 자율 발화를 예약하는 경계**다. 이미 시작한 provider 호출은 기존 UC1의 AbortSignal
   취소 계약을 따르고, 외부 도구는 기존 60초 timeout을 유지한다. 이 기능이 새 무기한 작업을 만들지 않는다.
8. 활성화 후에는 해당 제어 도구를 provider에 다시 노출하지 않는다. 외부 도구와 승인/timeout 계약은 유지한다.
9. 한 assistant 라운드에 제어 도구와 외부 도구가 함께 오면 제어 도구의 승인 게이트를 먼저 처리하고,
   모든 외부 도구를 기존 순서로 한 번씩 실행·thread한다. 기존 다중 provider 도구 루프가
   더 이어지면 no-more-tool 최종 텍스트가 나올 때까지 동일 계약으로 완주한다. 이 루프 종착 텍스트를 첫
   연속 발화로 센 뒤에만 발화 간격을 기다리고 자율 후속 호출을 예약한다.

## 수용 기준과 테스트 계약

- AC1: 활성화 도구 호출 뒤 두 개 이상의 text 발화가 **하나의 열린 stream·같은 requestId**로 순서대로
  방출되고, 마지막에 `usage → finish`가 각 1회 온다. terminal 뒤 이벤트는 없다. 새 `requestId`는 사용자가
  끼어들어 현재 요청을 취소한 뒤 보내는 다음 사용자 턴에만 사용한다.
- AC2: 활성화 직후 provider 호출 messages에는 call id가 일치하는 제어 tool-result가 있고, 후속 자율
  provider 호출에는 첫 발화와 숨은 진행 지시가 있으며 원래 사용자 요청도 유지된다.
- AC3: 여러 호출의 usage 합이 마지막에 1회 방출되고 바로 뒤에 finish/error 중 하나가 1회 방출된다.
- AC4: 발화 사이 delay 중 cancel과 provider 스트림 중 cancel은 동기 abort 뒤 계약테스트 100ms watchdog 안에
  `usage → error(cancelled)`로 끝나고 registry가 해제된다. 이는 결정론 테스트 경계이며 실시간 OS SLA 수치는 아니다.
- AC5: 활성화 시각 기준 deadline에서 `now >= deadline`이거나 첫 최종 발화를 포함한 60회 상한이면 정상
  finish하며 추가 provider 호출은 없다. 대기 전·대기 직후 경계를 모두 검사한다.
- AC6: memory/conversationLog save는 각 1회, userText는 원문 그대로, assistantText는 실제 복수 발화만 포함한다.
- AC7: 미활성 일반 채팅은 provider 호출·terminal·usage·save 각 1회와 기존 emit 순서를 유지한다.
- AC8: 외부 tool과 같은 턴에 있어도 외부 실행·toolUse/toolResult correlation과 승인·timeout·최종 save 계약이 깨지지 않는다.
- AC9(2026-07-17 재작성 — **양방향 필수**): 로컬 Ollama 시연 모델로 아래 둘을 **모두** 만족해야 PASS 다.
  - **AC9-pos**: 고정 시연 문장으로 독립 2회 모두 `continue_speaking` 선택 + 승인 approve → 2개 이상 발화.
  - **AC9-neg**: 고정 대조 문장 `오늘 날씨 어때?` 로 독립 2회 모두, 승인 reject 하에 **자율 후속 provider
    호출 0회 · 발화 1회**. (모델이 control 을 호출하는지 여부는 판정 대상이 아니다 — 실측상 33% 호출한다.
    판정 대상은 "승인 없이 활성화되지 않는가" 다.)
  - 증적에는 **모델이 실제 보낸 `userRequestQuote` 원문과 각 발화 텍스트를 그대로** 기록한다. boolean 과
    이벤트 종류 집계만 남기면 리뷰어가 판정 근거를 감사할 수 없다(2026-07-16 증적의 실패 — 그 결과
    "원문 전체 복사로 substring 검사를 무의미하게 통과" 를 아무도 못 봤다).
  - 실패하면 모델 선택·도구 설명의 실측 한계를 정직하게 보고하며 키워드 우회로 성공 처리하지 않는다.
    fake-provider 계약 테스트는 결정론적 기능 게이트이고, 이 실연동은 시연 모델 준비 상태의 별도 필수 게이트다.
- AC10: provider 호출 중 또는 발화 사이 대기 중 취소된 턴은 terminal error=`cancelled`, usage 1회,
  registry 해제 후 memory/conversationLog 저장 0회다. provider iterator를 닫고 delay timer/abort listener를
  정리하며, terminal 뒤 늦은 provider 이벤트를 방출하지 않는다. 이미 wire로 방출된 부분 텍스트를 저장으로
  소급 커밋하지 않는다.
- AC11: `continue_speaking`을 호출하지 않는 일반 채팅은 provider 호출·terminal·usage·save 각 1회이고,
  `enableTools=false`에서는 제어 도구도 노출하지 않는다. 일반 외부 도구의 다중 라운드 턴은 각 고유 call id에
  toolUse와 toolResult가 정확히 한 쌍이고 orphan/중복 없이 기존 승인·timeout·최종 save 형태가 그대로다.
- AC12: `durationMinutes`/`pauseSeconds`의 누락·비수치·비유한 값은 10분/3초 기본값으로, 유한 범위 밖
  값은 1~30분/0~30초로 clamp하며 throw하지 않는다. 60회 상한은 고정값이고 모델 인자로 받지 않는다.
  **판정은 로그가 아니라 행위로 한다(2026-07-17 강화)**: 정규화된 `pauseSeconds` 가 `clock.wait(ms)` 에
  실제로 전달되고, 정규화된 `durationMinutes` 가 deadline 경계에 실제로 반영되며, `topic` 절단이 provider
  메시지에 실제로 반영되는지를 단언한다. 로그 ctx 단언만으로는 통과할 수 없다.
  근거 = 2026-07-17 뮤테이션 테스트에서 `pauseMs→0`, `deadline→now()+60_000`, `topic.slice(0,5)` 뮤턴트가
  **전부 13/13 생존**했다(모든 `wait` 스텁이 `ms` 를 무시하고 AC12 가 `activationLog.ctx` 만 봤기 때문).
- AC13(2026-07-17 재작성): 제어 호출은 **승인 결정에 의해서만** 갈린다. reject 면 기존 거부 경로
  (`toolResult` `success=false`)를 타고 활성화하지 않으며 **모델이 일반 응답을 끝까지 처리**한다
  (provider 호출·terminal·usage·save 각 1회 유지). approve 면 활성화한다. `userRequestQuote` 의 내용은
  활성화 여부에 **영향을 주지 않으며**, 누락/비문자열이면 빈 문자열로 정규화해 승인 페이로드에 그대로 싣는다
  (throw 금지). app 이 quote 로 거부하는 경로는 존재하지 않는다.
- **AC14(신규 — 부정 방향 필수 게이트)**: 승인 없이는 어떤 입력으로도 활성화되지 않는다.
  - 결정론: `오늘 날씨 어때?` 처럼 계속 발화와 무관한 사용자 턴에서 모델이 `continue_speaking` 을
    호출하더라도, 승인 reject 시 발화는 1회(일반 답변)뿐이고 자율 후속 provider 호출은 **0회**다.
  - 실연동(AC9-neg): 아래 AC9 참조. **부정 방향 미측정 상태의 PASS 선언은 금지**한다 —
    2026-07-16 AC9 PASS 는 긍정 방향만 측정해 잘못 선언되었고 철회되었다.

## AC → 테스트 사례 매트릭스

| AC | 결정론 계약 테스트 사례 |
|---|---|
| AC1, AC3 | `activates and emits three ordered non-overlapping utterances on one stream with one terminal and no late events` |
| AC2 | `threads matching hidden control result then only the immediately prior assistant text and hidden continuation provider-locally` |
| AC4, AC10 | `cancels delay within 100ms and disposes timer/listener with no persistence or late events`; `cancels provider within 100ms, calls iterator.return, clears registry and does not persist` |
| AC5 | `counts the first final utterance and suppresses the 61st`; `stops before delay and after delay at equality with an injected monotonic clock` |
| AC6 | `persists one completed turn with only actual user and assistant text` |
| AC7, AC11 | `keeps ordinary chat single-round`; `keeps external multi-round tool correlation`; `hides all tools when disabled` |
| AC8 | `activates internally, completes a multi-round external tool loop, then counts its final text and reschedules without exposing control events`; `keeps mixed approval rejection pairing`; `keeps mixed tool timeout pairing` |
| AC9 | `src/test/uc-continue-speaking.ollama.integration.test.ts`: endpoint `http://127.0.0.1:11434`, model `dnotitia-dna3.0-9b-q4-16k:latest`, **AC9-pos 독립 2회 + AC9-neg 독립 2회** |
| AC12 | `normalizes missing malformed non-finite fractional and out-of-range control arguments without throwing`; **`passes normalized pauseSeconds to clock.wait and reflects durationMinutes in the deadline and topic truncation in provider messages`**(행위 단언 — 뮤턴트 B/C/G kill) |
| AC13 | `approval reject keeps the turn a normal single-round chat with one save`; `quote content never gates activation (empty/fabricated/verbatim all reach approval identically)` |
| AC14 | `never activates without approval`; **`ordinary question + model calls control + reject → exactly one utterance and zero autonomous provider calls`**(부정 방향) |
| §8/§9 방어 | `duplicate control calls in one round`; `control call after consumption`(뮤턴트 E/F kill) |

로컬 Ollama 통합 UC의 고정 사용자 문장은 `라디오처럼 뭐라도 계속 이야기해 줘. 난 씻고 올게.`다.
실행 명령은 PowerShell 기준
`$env:NAIA_OLLAMA_INTEGRATION='1'; pnpm exec vitest run src/test/uc-continue-speaking.ollama.integration.test.ts`다.
객관 판정은 각 실행에서 실제 `continue_speaking` 선택, 같은 requestId의 순서 있는 text 발화 2개 이상,
usage 1회, finish 1회, error 0회다. endpoint 또는 지정 모델이 없으면 시연 준비 실패로 판정하며 skip하지 않는다.
통합 테스트 파일 하나가 내부에서 상태를 새로 만든 두 턴을 서로 다른 requestId로 순차 실행한다. 두 실행의
timestamp/model/requestId/event 순서와 개별 pass/fail 집계는
`.agents/reviews/issue-82-ollama-integration-2026-07-16.json`에 남긴다.

## 실측 메모 — 시연 모델 특성 (2026-07-16, AC9 진단)

핸들러를 배제하고 Ollama 를 직접 호출해 격리 측정한 결과(증적 = 위 JSON + 본 절):

| 관측 | 수치 | 함의 |
|---|---|---|
| 도구 선택률(시연 문장, thinking ON) | **44/44 = 100%** | 모델·도구 설명은 문제 없음 |
| 도구 선택률(**thinking OFF**) | **0/6** | ⚠️ **thinking 을 끄면 이 모델은 도구를 아예 호출하지 않는다** |
| stream=false vs true | 8/8 vs 8/8 | 스트리밍은 무관 |
| ~~quote 통과(정규화 전 → 후) 4/12 → 12/12~~ | **폐기** | 구 가드 기준 수치. 가드 폐기로 무의미 |
| **도구 오선택**(`오늘 날씨 어때?`) | **4/12 = 33%** | ⚠️ **평범한 질문에도 control 을 부른다** — §2 재설계의 근거 |
| **도구 오선택**(`계속 이야기해 볼까? 넌 어떤 영화 좋아해?`) | **6/12 = 50%** | 〃 |
| 활성화 시 quote 내용 | **100% 사용자 원문 전체** | 출처 검사가 원리적으로 무력한 이유 |

**thinking 의존성**: `dnotitia-dna3.0-9b-q4-16k` 는 thinking 이 켜져 있을 때만 tool call 을 낸다.
현재 기본 경로는 thinking 이 켜져 있어(provider 가 `think` 를 명시하지 않으면 모델 기본값) 실해는 없다.
다만 **시연/설정에서 thinking 을 끄면 연속 발화 기능이 통째로 동작하지 않는다** — 코드 가드는 추가하지 않고
(사용자 결정 2026-07-16) 이 문서로 남긴다. 다른 모델로 교체 시 이 항목을 재측정할 것.

## 단계별 게이트

planning → 테스트 RED → development → test → 로컬 Ollama UC → integration 순서로 진행한다.
development와 integration 단계는 표준 `review-pass`로 **2회 연속 CLEAN**일 때만 통과한다.
설계-구현 괴리가 발견되면 설계를 임의 수정하지 않고 Issue #82에 기록해 결정한다.

## 범위 밖

- 셸에 별도 라디오 모드 UI/상태 저장 추가
- 앱 재시작 뒤 자동 재개
- 사용자 지시 없는 선제 발화
- 여러 세션에 걸친 백그라운드 방송
