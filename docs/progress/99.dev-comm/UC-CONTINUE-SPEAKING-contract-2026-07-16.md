# UC-CONTINUE-SPEAKING v3.1 계약 — 자유 발화와 연속 발화

- 날짜: 2026-07-18
- 상태: DJ/전시 기술 MVP와 #84 제품 수용(PA-DJ/PA-EX) 구현·검증 완료
- GitHub Issue: https://github.com/nextain/naia-agent/issues/82
- 추적: REQ-013 → UC-015 → SPEC-012 → TEST-S-015 / TEST-F-012
- 구현 경계: `naia-agent` app·port·gRPC proto/adapter/composition + `naia-shell` activity stream 구독·정지 배선.

## 0. 2026-07-18 목표 재정렬 — 이 절이 MVP 우선순위의 정본

### 2026-07-20 제품 수용 부속 계약 (#84)

2026-07-21 완료: exact preference index와 durable/idempotent Memory handoff, 60분 날씨·6시간
명시 mood freshness, file-backed 설정과 동의 철회, profile ACK + activity subscription epoch fence,
browser/synthesized TTS, 닫힌 DJ 제어 6종, 전시 yield/Q&A/resume가 GREEN이다. 전체 unit/integration,
Playwright 7건, 실제 Tauri 설정 재수화 1건, Rust build/check를 통과했고 독립 적대 리뷰는 같은 diff에서
연속 CLEAN 2회로 수렴했다.

아래 항목은 구현된 MVP를 제품으로 닫는 V-model 추적 계약이다. 상세 검증표는
`.agents/progress/issue-84-proactive-speech-product-acceptance.md`의 `PA-DJ-*`/`PA-EX-*`를 정본으로 한다.

- 명시적 음악 취향은 schema `naia.dj.preference.v1`의
  `sentiment(like|dislike|forget)·subject·subjectKey·sessionId·requestId·statedAt·source=explicit_user_turn`
  을 보존해 현재 workspace/project로 격리된 Naia Memory에 저장한다. 단일 agent process는 단일 사용자
  workspace라는 기존 MemoryPort 경계를 따른다. `subjectKey`는 NFKC→trim→연속 공백 1개→locale-independent
  lower-case이며 500 code point 상한이다. index가 atomic 증가시키는 `sequence`를 각 record에 부여하고
  최신값은 `(sequence, requestId)` 오름차순 total order의 마지막 값이다. `statedAt`은 provenance일 뿐
  순서 판정에 쓰지 않는다. 손상 record는 버리며 동일 record는 dedupe한다. dislike는 추천에서 빼고 forget은 해당
  subject의 like/dislike를 모두 무효화한다. 정본 활성 상태는 semantic top-K가 아니라 workspace-local
  keyed durable index(`subjectKey → latest record`)가 소유한다. Naia Memory save는 provenance handoff와
  일반 회상용 복제이며 추천 활성화 판단에 단독 사용하지 않는다. index가 없거나 손상됐으면 semantic memory의
  과거 like를 복구해 활성화하지 않는 fail-closed다. 단일 atomic index commit은 active record와 같은
  idempotency key의 memory-outbox 항목을 함께 기록한다. 그 commit 성공이 사용자 명령 성공 경계다.
  worker는 outbox를 `MemoryPort.save` 뒤에만 제거하며 실패·crash면 다음 시작에 재시도한다. 중복 save는
  idempotency key를 가진 동일 v1 record라 회상 codec이 dedupe한다. index commit 실패면 Memory 호출 0이고
  활성 상태도 불변이다. fault-injection은 commit 전/후와 Memory 성공 전/후 네 경계를 모두 검증한다.
  DJ 활동 발화·재생 시간·자동 추론은 저장하지 않는다.
- 명시적 기분·활동은 `DJ 상태: <사용자 원문>`만 수용한다. 현재 profile의 같은 session에만 저장하고 6시간
  freshness 뒤 생략한다. 일반 대화를 감정 분류기로 추론하지 않는다.
- 명령은 ordinary chat 중 `DJ 좋아요:`, `DJ 싫어요:`, `DJ 취향 삭제:`, `DJ 상태:`의 닫힌 형식만 선처리한다. 빈 subject,
  500 code point 초과분, profile/session 불일치는 fail-closed한다.
- 이 prefix들은 사용자 의미를 추론하는 키워드 판정이 아니라 명시적 구조 명령 문법이다. 명령을 소비하면
  일반 provider·conversation transcript·ordinary `memory.save` 호출은 각각 0회이고 구조화 preference
  store만 1회 호출한다. forget 뒤 raw 명령 원문이 일반 memory 회상으로 취향을 되살리는 경로는 없다.
- DJ 멘트는 유한 문장 조각을 grounded context로 조립하되 최근 6개의 완성 문장과 같은 문장을 내보내지 않는다.
  근거가 없는 weather/mood/preference/현재 곡 슬롯은 렌더하지 않는다.
- shell 설정은 profile·idle·멘트 간격·timezone·BGM opt-in·날씨 동의·위도·경도·전시 knowledgeScope를
  사용자가 편집하고 file-backed UI config에 저장한다. timezone은 `Intl.DateTimeFormat`으로 유효해야 하며,
  좌표는 유한수·위도 -90..90·경도 -180..180의 완전한 쌍이어야 한다. `weatherConsented !== true`이면 저장된
  좌표가 있어도 agent RPC로 전달하지 않고, 동의 철회 시 persisted 좌표도 지운다. 빈/잘못된 knowledgeScope는
  전시 profile 시작을 fail-closed한다.
- 지원 TTS 경로별로 browser-TTS는 `speechSynthesis.speak`, 합성 TTS는 audio queue의 `play` 시작을 각각
  검증한다. 끼어들기 수용 순서는 250ms 안에 `interruptTts` 호출 → activity control/yield 요청이며,
  이후 이전 `(activityId, profileGeneration)`의 text/audio 재생은 0회다.
  물리 스피커 음질은 자동 테스트 결과로 주장하지 않는다.

이 문서는 계획 리뷰 중 범용 활동 런타임과 운영 안정화로 과도하게 확장되었다. 사용자가 원한 핵심은
“입력을 기다리지 않고 먼저 관심을 끌며, 상황에 맞게 말을 이어가고, 사람의 반응에 양보했다가 복귀하는
Naia”다. 따라서 아래 두 목표의 실제 동작을 먼저 증명한다. 이 문서의 기존 AC1~AC18은 폐기하지 않지만
**MVP를 막는 선행 완료 조건이 아니라 이후 운영 안정화 기준**이다.

### 목표 1 — 개인 라디오 DJ (P0, Luke 개인 사용)

Naia가 시간·날씨·사용자가 말한 기분과 활동·현재 환경·workspace-local exact index의 명시적 취향을
근거로 유튜브 음악이나 긴 믹스를 먼저 제안하고, 기존 `skill_youtube_bgm`으로 실제 재생하며, 음악을
방해하지 않는 짧은 DJ 멘트를 이어간다. Naia Memory는 활성 취향 정본이 아니라 provenance handoff다.

필수 행동:

1. 설정된 idle 뒤 사용자 입력 없이 첫 음악 제안 또는 DJ 인사를 시작한다.
2. 추천 근거의 출처를 구분한다. 알 수 없는 날씨·기분·현재 곡은 추측하지 않는다.
3. `skill_youtube_bgm play`의 실제 성공 결과 뒤에만 “재생 중”이라고 말한다.
4. 긴 믹스의 title/description/chapter/tracklist 근거가 없으면 현재 세부 곡명을 만들지 않는다.
5. “음악만”, “말 줄여”, “다른 분위기”, “다음 곡”, “그만”에 양보한다.
6. “내가 멈추라고 할 때까지”는 사용자 관점의 횟수 제한 없이 지속하되 내부 안전 lease를 자동 갱신한다.
7. 명시적 좋아요/싫어요만 출처가 있는 음악 선호 handoff로 통합한다. 활동 발화 전체를 `memory.save`로
   반복 저장하지 않으며, 자동 세션 결과 학습은 telemetry+dream seam 이후로 미룬다.

MVP 증적:

```text
무입력 시작 → 맥락 근거가 있는 추천 → 실제 BGM 재생 → 서로 다른 DJ 멘트 2회
→ 사용자 끼어들기(다른 분위기 또는 음악만) → 반영 → 그만 → 재생/발화 정지
```

### 목표 2 — 회사 전시 행사 소개 (P1, Nextain 전시 사용)

Naia가 입력창 앞에서 기다리지 않고 관람객에게 먼저 말을 걸어 회사·제품·전시 내용을 소개한다. 회사·제품
사실은 지정된 전시 지식 저장소(KB)를 근거로만 말하며, 질문이 들어오면 안내를 즉시 양보하고 답변 뒤
소개 활동으로 복귀한다.

필수 행동:

1. 센서 없는 MVP는 설정된 idle 뒤 짧은 인사와 관심 유도 문장으로 먼저 시작한다.
2. 서로 다른 소개 항목을 추적해 같은 문장·주제를 연속 반복하지 않는다.
3. 회사·제품·일정·부스 정보는 KB 근거가 없으면 모른다고 말하고 추측하지 않는다.
4. 관람객 질문/음성이 들어오면 현재 소개와 TTS를 중단하고 답변한다.
5. 답변 뒤 설정된 간격을 거쳐 아직 소개하지 않은 항목으로 복귀한다.
6. “조용히”, “다시 소개해”, “이 제품을 더 설명해”, 운영자 stop을 반영한다.
7. 방문객 개인 정보는 기본 장기 저장하지 않는다. 운영자 설정과 승인된 반복 FAQ만 별도 정책으로 통합한다.

MVP 증적:

```text
무입력 시작 → 첫 인사 → 서로 다른 KB 기반 소개 3개
→ 관람객 질문이 소개/TTS 중단 → 근거 있는 답변 → 미소개 항목으로 복귀
→ 조용히/stop → 발화 정지
```

### 공통 MVP 기반

- app 계층이 `idle → attract → speak → wait → yield → answer → resume → stop` 수명을 소유한다.
- profile은 `personal_radio_dj | exhibition_intro`의 닫힌 union이다. 임의 범용 profile은 이번 범위가 아니다.
- shell은 기존 TTS·Chat·panel tool 실행을 재사용하고 별도 반복 상태 기계를 만들지 않는다.
- 첫 무입력 시작, 끼어들기, resume, quiet/stop은 fake clock으로 결정론 테스트한다.
- MVP 구현에 필요한 최소 cancel·terminal·bounded lease만 먼저 적용한다.
- presence/camera, 유튜브 chapter 동기화, 장시간 무인 운영 최적화, 복잡한 저장 semaphore/quarantine은 후속이다.

### 리뷰 순서

1. 먼저 관심을 끄는가
2. 상황·기억·KB의 근거가 있는가
3. 사람의 입력에 양보하고 원래 활동으로 복귀하는가
4. 반복적이거나 성가시지 않고 quiet/music-only를 지키는가
5. 사실·현재 곡·날씨·개인정보를 추측하지 않는가
6. 그 다음 취소 경쟁·자원·저장 안정성을 검토한다

### 2026-07-18 상세 재리뷰 결론 — 기존 범용 계약보다 우선

1차 판정은 **FINDINGS**였다. 목표 문구는 바로잡혔지만 기존 상세 계약만 구현하면 “말은 반복하지만 음악을
틀지 못하는 DJ”와 “KB 없이 일반 지식으로 말하고 질문 뒤 종료되는 전시 소개”가 됐다. 아래 결정을
반영하고 각 목표를 재검토한 결과 **CLEAN ×2**로 수렴했으며, 이를 MVP 구현 정본으로 적용한다.

#### 공통 구조

- 범용 activity 하나에 profile 문구만 넣지 않는다. `PersonalRadioDjController`와
  `ExhibitionIntroController`가 각자의 닫힌 상태와 의존성을 소유하고, 공통으로 재사용하는 것은
  session activity stream, TTS 끼어들기, 주입 시계, provider 취소뿐이다.
- 센서 없는 MVP의 idle은 app이 소유한다. shell의 activity subscriber가 연결되고 해당 profile의 필수
  capability가 준비된 뒤 timer를 arm하며, 사용자 입력마다 reset한다. shell은 반복 timer를 갖지 않는다.
- self-init activity event는 ordinary Chat의 `currentRequestId` 필터와 분리해 받는다. 사용자 입력 순서는
  `interruptTts → activity yield/stop → ordinary Q&A 시작`이며, 이전 activity의 늦은 text/TTS는
  `(activityId, generation)`으로 폐기한다.
- 기존 §3~§10의 requested continuation과 AC1~AC18은 **후속 hardening**이다. 아래 DJ/EX 수용 기준을
  통과하기 전에는 구현 게이트나 완료 조건으로 사용하지 않는다.

#### 개인 라디오 DJ의 닫힌 계약

```ts
interface PersonalRadioDjConfig {
  sessionId: string;
  idleMs: number;
  djIntervalMs: number;
  timezone: string;
  weatherLocation?: { latitude: number; longitude: number; consented: true };
  bgmAutoPlayOptIn: boolean;
}

interface DjContextSnapshot {
  localTime: { iso: string; timezone: string; source: "configured" };
  weather?: { code: number; tempC: number; observedAt: string; source: "open-meteo" };
  moodActivity?: { quote: string; sessionId: string; statedAt: string };
  nowPlaying?: { videoId: string; title: string; source: "bgm-player" };
  preferences: readonly {
    text: string;
    source: "user-memory";
    confidence: "explicit";
  }[];
}

interface RadioDjBgmPort {
  capabilities(): {
    ready: boolean;
    next: boolean;
  };
  searchAndPlay(query: string, opts: { requestId: string; activityId: string }):
    Promise<{ ok: true; videoId: string; title: string } | { ok: false; reason: string }>;
  next(opts: { requestId: string; activityId: string }):
    Promise<{ ok: true; videoId?: string; title?: string } | { ok: false; reason: string }>;
  stop(opts: { requestId: string; activityId: string }): Promise<{ ok: boolean }>;
  status(): Promise<{ videoId: string; title: string } | undefined>;
}
```

- 상태는 `disabled → idle → selecting → playing → dj_speaking | music_only → yielded → stopped`다.
- 시작 gate는 `bgmAutoPlayOptIn === true + activity subscriber + shell panel skill_youtube_bgm ready` 셋
  모두다. DJ opt-in은 `RadioDjBgmPort.searchAndPlay|next|stop|status`만 허용하는 좁은 사전 동의이며
  다른 환경 도구로 확장되지 않는다. `searchAndPlay(query)`가 shell panel의 `play {query}`로 검색과
  재생을 원자 위임한다.
- self-init 전에 app이 `DjContextSnapshot`을 만든다. 없는 weather/mood/nowPlaying/preferences 필드는
  생략하고 provider에 “누락값을 추측하지 말라”고 명시한다.
- BGM 정본은 production에서 shell이 등록하는 `skill_youtube_bgm`이다. 이름이 다른 agent-local
  `youtube_bgm` 테스트 adapter를 같은 capability로 간주하지 않는다.
- MVP는 activity stream에서도 `panelToolCall`과 `PanelToolResult`를
  `(requestId, activityId, toolCallId)`로 왕복시킨다. profile controller는 동적으로 등록된 전체 도구가
  아니라 검증된 BGM action만 호출한다.
- `searchAndPlay` 성공 결과는 문자열 파싱이 아닌 `{ ok, videoId, title }` 구조 결과를 포함한다. 성공 확인
  전에는 “재생 중”이라고 말하지 않는다. 검색 실패나 player 실패면 실패를 정직하게 알리고 재생 주장을
  하지 않는다.
- 현재 metadata는 video title만 보장한다. 재생 소개와 후속 DJ 멘트는 provider 자유 텍스트를 그대로
  방출하지 않고 app 소유 템플릿이 구조화된 `videoTitle | timeBand | weatherBand | preferenceReason`
  값만 렌더한다. chapter, tracklist, playback position 필드가 없으므로 현재 세부 곡명을 넣을 슬롯 자체가 없다.
- 닫힌 제어 결과:
  - `music_only`: BGM 유지, 향후 DJ TTS 억제
  - `talk_less`: DJ 간격을 한 단계 늘림
  - `change_vibe`: 현재 TTS 중단 → 새 play 성공 → 한 번 소개 → DJ 복귀
  - `next`: capability가 있으면 next, 없으면 새 query로 `searchAndPlay` 대체
  - `stop`: DJ 발화와 BGM 모두 정지
  - 일반 질문: yield 후 답변, `music_only|quiet|stopped`가 아니면 DJ 복귀
- 사용자 관점의 until-stopped는 내부 30분/60발화 lease를 중복 없이 자동 갱신한다. lease 경계에서
  BGM을 끊지 않으며 stop 뒤 provider/TTS/BGM 추가 호출은 0회다.
- 활동 발화와 수동 청취 시간으로 취향을 추론하지 않는다. MVP 장기기억 통합은 ordinary turn에서
  사용자가 명시한 좋아요/싫어요만 provenance가 있는 preference handoff로 보낸다. 자동 세션 결과
  학습은 구조화 dream seam과 BGM telemetry가 생길 때까지 후속이다.
- context freshness는 app이 강제한다. weather는 `observedAt`이 현재 기준 60분 이내, mood/activity는
  같은 session에서 명시되고 6시간 이내일 때만 snapshot에 포함한다. `status()`가 현재 응답한 BGM만
  nowPlaying으로 취급한다. stale 값은 누락값과 동일하게 생략한다.

#### 회사 전시 소개의 닫힌 계약

```ts
interface ExhibitionProfileConfig {
  sessionId: string;
  knowledgeScope: string;
  idleMs: number;
  introIntervalMs: number;
}

interface ExhibitionIntroItem {
  itemId: string;
  text: string;
  sourceUris: readonly string[];
}
```

- 상태는 `disabled → idle → attracting | speaking → yielded → answering → resume_wait → speaking`,
  별도 `quiet | stopped`다. `quiet`는 명시적 resume 전까지 idle을 다시 arm하지 않고, `stopped`는 terminal이다.
- profile은 일반 외부 도구를 매 발화마다 다시 열지 않는다. 작은 read-only `ExhibitionKnowledgePort`의
  `listIntroItems(scope)`와 `answer(scope, question)`만 사용한다.
- 소개는 시작 전에 안정적 `itemId`, `text`, 비어 있지 않은 `sourceUris`를 가진 항목을 가져온다.
  성공적으로 완결 방출한 항목만 `introducedItemIds`에 넣는다. 최대 3개를 중복 없이 소개하고, 3개
  미만이면 있는 항목만 소개한 뒤 정직하게 종료한다.
- 질문 답은 `abstained === false && sources.length > 0`일 때만 사용한다. 검색 결과 없음, backend 오류,
  source 없는 답은 고정 기권 응답을 사용하고 모델의 일반 지식으로 메우지 않는다.
- 관람객 질문은 activity terminal cancel이 아니라 `yielded` 전이다. 답변 뒤 같은 profile generation과
  남은 item cursor가 유효하고 quiet/stop이 아니면 `resume_wait` 뒤 미소개 항목으로 복귀한다.
- `다시 소개해`는 introduced cursor를 reset하고 idle 없이 첫 항목부터 다시 시작한다.
  `이 제품을 더 설명해`는 현재 item scope의 KB 답변으로 처리한다. 운영자 stop은 즉시 terminal이다.
- exhibition activity와 Q&A는 memory recall/save가 기본 0이다. MVP transcript도 process-local
  비영속으로 두고 terminal에서 폐기한다. 반복 FAQ 승격은 운영자가 승인한 별도 입력만 허용한다.

#### profile enable·yield·Q&A 결속 wire

- shell은 persisted proactive 설정을 읽어 연결 뒤 `ConfigureSpeechProfile` RPC를 호출한다. 요청은
  `disabled | personal_radio_dj(PersonalRadioDjConfig) | exhibition_intro(ExhibitionProfileConfig)`의
  닫힌 oneof다. agent는 같은 설정을 app controller에 전달하고 성공 응답 뒤에만 idle을 arm한다.
- `YieldSpeechActivity(sessionId, activityId)`는 terminal이 아닌 `yielded` 전이를 원자 수행하고
  무작위 `resumeToken`과 현재 `profileGeneration`을 반환한다.
- yield 뒤 ordinary `ChatRequest`는 선택적
  `activityResume { activityId, profileGeneration, resumeToken }`을 싣는다. agent가 토큰과 session을
  검증한 요청만 profile-bound Q&A로 처리한다. exhibition Q&A에는 이 검증 결과로 memory/transcript
  off와 KB scope를 app이 강제하며, shell이 보낸 임의 privacy flag는 신뢰하지 않는다.
- Q&A 정상 terminal 뒤 controller가 `resume_wait`를 결정한다. token 불일치, quiet, stop, 새 generation은
  일반 Chat으로 처리하고 profile을 재개하지 않는다.
- self-init event/cancel은 `requestId+activityId`를 쓴다. `requestGeneration`은 requested Chat cancel에만
  사용하며 self-init wire에 존재한다고 가정하지 않는다. `profileGeneration`은 yield/resume 결속용으로
  별도다.

#### MVP 수용 기준

| ID | 결정론 수용 기준 |
|---|---|
| DJ-01 | opt-in·subscriber·BGM ready 뒤 idle 경계에서 정확히 한 번 시작하고, 하나라도 없으면 시작 0 |
| DJ-02 | 시간·허용된 60분 이내 날씨·같은 session 6시간 이내 명시 기분·live BGM·명시 취향을 source와 함께 조립하며 stale/누락값 추측 0 |
| DJ-03 | BGM 성공 구조 결과 뒤에만 재생 주장, 실패 뒤 재생 주장 0 |
| DJ-04 | chapter 없는 긴 믹스에서 현재 세부 곡명 주장 0 |
| DJ-05 | 서로 다른 DJ 멘트 2회와 설정 간격, music-only 뒤 추가 DJ TTS 0 |
| DJ-06 | talk-less/change-vibe/next/stop 각각 닫힌 상태 전이, stop 뒤 provider/TTS/BGM 호출 0 |
| DJ-07 | lease 2회 갱신 뒤 BGM 연속·controller 중복 0, 활동 memory.save 0, 명시 preference handoff만 1 |
| DJ-GRPC-01 | self-init activity stream에서 panel BGM call/result가 activityId까지 상관되고 실제 player play/stop |
| EX-01 | enabled+subscriber+KB ready 뒤 idle 경계에서 첫 인사, 미준비면 시작 0 |
| EX-02 | source가 있는 A/B/C를 정확히 3개 소개하고 itemId 중복 0; 2개뿐이면 2개 뒤 종료 |
| EX-03 | empty/abstained/source-empty 질문은 고정 기권하며 근거 없는 회사·제품 사실 0 |
| EX-04 | B 소개 TTS 중 질문 시 TTS/provider 중단이 답변보다 먼저이고 늦은 B audio/text 재생 0 |
| EX-05 | 답변 뒤 C로 복귀하고 A/B 반복 0; quiet 뒤 clock 전진에도 발화 0; explicit resume 뒤 재개 |
| EX-06 | exhibition 질문의 memory recall/save 및 영속 transcript 0 |
| SHELL-01 | unsolicited activity를 ordinary request와 별도로 표시·TTS하고 입력 시 queue하지 않고 먼저 양보 |

## 1. 목적과 범위

Naia가 사용자의 명시적 요청에 따라 라디오처럼 여러 발화를 이어 말하고, 내부 활동 트리거가 있으면 사용자
입력 없이도 먼저 말을 걸 수 있게 한다. 두 시작 경로는 하나의 `speech activity` 상태 기계를 공유한다.
활동은 채팅 턴에 종속되지 않으며 시작·활성·정지·체크포인트·종료 수명을 스스로 소유한다.

이번 범위:

1. 사용자 요청에 따른 즉시 시작 또는 한 턴 확인 후 시작
2. 사용자 입력 없는 자유 발화를 시작할 수 있는 app 계층 진입점
3. 같은 맥락의 짧은 연속 발화, 유한 경계, 끼어들기와 명시적 정지
4. 완결 발화별 `conversationLog` 체크포인트와 장기기억 오염 방지
5. 상태와 종료 원인의 진단 가능성

기존 상세 hardening 범위 밖:

- presence/camera 기반 감지와 cron 정책(단, MVP의 주입 가능한 단순 idle trigger는 범위 안)
- 앱 재시작 뒤 활동 자동 재개
- 여러 프로세스나 여러 기기 사이 활동 이전
- #84 제품 수용에 필요한 profile·간격·날씨·전시 KB 설정 UI는 범위 안이다. 별도 선곡 편집기·방송국
  관리 화면과 셸 내부 반복 상태 기계는 범위 밖이다.

자유 발화 자체는 범위 밖이 아니다. 외부 정책이 `startSelfInitiatedSpeech`를 호출하면 사용자 요청 경로와
동일한 활동 런타임에서 실행되어야 한다.

## 2. 용어와 불변식

- **지속 요청**: 한 번의 답변이 아니라 여러 발화를 계속 요구하는 사용자 의도.
- **수동 청취 신호**: 사용자가 자리를 비우거나, 다른 일을 하거나, 잠들 때까지 듣는 등 능동 답변을
  요구하지 않는다는 원문 근거.
- **확인 대기(pending)**: 지속 요청은 있으나 수동 청취 신호가 없어 다음 사용자 턴 하나에서 의도를
  확인하는 세션 결속 상태.
- **활동(activity)**: 확인이 끝나 활성화된 자유/연속 발화의 수명 단위.
- **완결 발화**: provider의 한 호출에서 최종 텍스트로 확정되어 wire에 모두 방출된 assistant 텍스트.
- **체크포인트**: 완결 발화를 활동 ID와 순번으로 대화 로그에 즉시 기록한 것.

불변식:

1. requested-continuation admission에서 앱은 한국어·영어 키워드나 정규식으로 사용자 의미를 재판정하지
   않는다. #84의 닫힌 `DJ ...:` 구조 명령 문법은 이 의미 추론 금지와 별개다.
2. 모델의 자기보고를 그대로 신뢰하지 않고, 원문 충실도와 서로 다른 두 근거라는 구조만 검사한다.
3. 활동 발화는 `memory.save`에 쓰지 않는다. 장기기억 선별과 통합은 꿈(dream) 경로의 책임이다.
4. pending과 active 상태는 반드시 `sessionId`에 결속한다. 빈 `sessionId`로 교차 턴 상태를 만들지 않는다.
5. 같은 세션에는 pending 최대 1개, process 전체에는 active 최대 1개만 존재한다.
6. terminal 뒤에는 어떤 wire 이벤트도 방출하지 않는다.

## 3. 시작 판정

### 3.1 제어 도구

`enableTools !== false`이고 provider capability가 `tools:"supported"`로 명시된 일반 사용자 턴에만 내부
제어 도구 `continue_speaking`을 제공한다. `unknown|unsupported`면 제어 도구를 주입하지 않아 기존 ordinary
chat을 유지하고 unknown을 supported로 추측하지 않는다. 모델이 전달하는 인자는 다음과 같다.

양성 capability는 호출 후 callback이 아니라 포트의 호출 전 메타데이터다.

```ts
interface ProviderPort {
  readonly capabilities?: { readonly tools: "supported" | "unsupported" | "unknown" };
  chat(...): AsyncIterable<ProviderChunk>;
}
```

도구 거부 분류+tool-less fallback 계약을 구현하고 contract test를 가진 adapter만 `supported`다(현재
Ollama native). OpenAI-compatible/custom adapter는 같은 fallback이 구현되기 전까지 `unknown`, 명시적으로 미지원인
adapter는 `unsupported`다. resolver가 선택한 실제
provider instance의 값을 app이 읽으므로 default/provider 전환에도 별도 전역 캐시가 없다. `supported`인
endpoint에서도 특정 모델이 tool payload를 거부할 수 있으며 그때 아래 `onToolCapability(unsupported)`
callback으로 해당 요청을 안전하게 tool-less degrade한다.

```ts
{
  userRequestQuote: string;
  awayEvidence?: string;
  topic?: string;
  durationMinutes?: number;
  pauseSeconds?: number;
}
```

도구 설명은 다음을 명시한다.

- 최신 사용자 발화가 여러 발화를 계속 요청할 때만 호출한다.
- 자리 비움·인사·일상 질문·직전 답변 이어가기만으로는 호출하지 않는다.
- `userRequestQuote`에는 지속 요청의 원문 근거만, `awayEvidence`에는 수동 청취의 별도 원문 근거만 넣는다.
- 두 필드에 같은 구절을 복사하지 않는다.

앱은 다음 구조 검사를 순서대로 적용한다. 정규화는 Unicode NFKC, 양끝 공백 제거, 연속 공백 축약만 하며
의미 단어를 추가·삭제하지 않는다.

1. `userRequestQuote`가 비어 있지 않고 최신 사용자 원문의 부분문자열인가
2. `awayEvidence`가 있으면 비어 있지 않고 최신 사용자 원문의 부분문자열인가
3. 두 근거의 정규화 결과가 서로 다르고 어느 한쪽도 다른 쪽의 부분문자열이 아닌가
4. 정규화된 최신 사용자 원문에서 두 quote를 서로 겹치지 않는 별도 span으로 배치할 수 있는가

결과:

- 1·2·3·4 모두 충족: 즉시 활동 시작
- 1만 충족하고 `awayEvidence`가 없음: 확인 대기
- `awayEvidence`가 있으나 2·3·4 중 하나라도 실패: 즉시 시작 금지, 확인 대기로 강등
- 1 실패: 제어 호출을 조용히 거부하고 일반 응답을 끝까지 처리

따라서 부재 신호만 있는 호출은 1 실패이므로 **일반 응답(즉시 시작 0, pending 0)**이다. 유효한 지속
요청 quote는 있으나 같은/포함/겹친 구절을 `awayEvidence`에 복사한 호출은 3 또는 4 실패이므로
**확인 대기(pending 1)**다.
단, `sessionId`가 비어 있으면 어떤 구조 성공도 활동으로 admission하지 않는다. 즉시 후보는 일반 단일
응답(active 0, pending 0)으로, 확인 후보는 아래 규칙대로 확인 질문만 하고 pending 0으로 끝난다.

`잠들 때까지 얘기해줘`처럼 지속 기간 자체가 수동 청취를 나타내는 문장은 즉시 시작 대상이다. 코퍼스와
테스트에서 이를 “지속 요청만 있음”으로 분류하지 않는다.

### 3.2 확인 대기

확인 대기는 앱이 강제하며 모델의 자율 기억에 맡기지 않는다.

- 키: 비어 있지 않은 `sessionId`
- 값: 무작위 `pendingId`, 정규화된 활동 인자, 생성 시각
- TTL: 주입 가능한 단조 시계 기준 2분
- 생성 시점: 확인 질문의 최종 텍스트가 정상 완료되고 그 일반 transcript append를 같은 session의
  append queue에 enqueue한 직후(append I/O 완료를 기다리지는 않음)
- 교체: 같은 세션의 새 pending은 이전 값을 원자적으로 교체
- 정리: 생성 때 주입 가능한 scheduler에 TTL timer를 등록해 만료 즉시 물리 삭제한다. 또한 모든 새 사용자
  턴·명시적 정지·`speechActivityState`·`drain` 진입에서 단조 시계를 다시 확인해 timer 지연/유실도 보정한다.
- 보관 상한: process 전체 pending session은 생성 순서 LRU 100개다. 101번째 생성은 가장 오래된 pending의
  timer를 해제하고 해당 값만 폐기한다. 같은 세션 교체는 새 항목 하나로 계산한다.
- claim/소비: 해당 세션의 바로 다음 사용자 턴이 `onChatRequest`에 들어오는 동기 구간에서 pending을 map에서
  제거해 그 requestId의 지역 claimed 값으로 옮긴다. 따라서 겹친 두 턴 중 event-loop상 먼저 진입한 턴만
  확인 도구를 제공받고, 뒤 턴은 일반 도구/채팅 경로다. claim한 턴이 확인 도구를 호출하지 않거나 실패해도
  pending은 복원하지 않는다. 유효한 확인 호출은 그 지역 claimed 값으로 활동 admission을 정확히 한 번 시도한다.

pending이 있는 다음 턴에는 `continue_speaking`과 외부 도구를 숨기고 내부 도구
`confirm_continue_speaking({ decision: "confirm", confirmationQuote })`만 제공한다. 도구 설명은 최신
응답이 앞선 확인 질문에 대한 명시적 동의일 때만 호출하도록 제한한다. `decision`은 JSON Schema
`enum:["confirm"]`, `confirmationQuote`는 최신 사용자 원문의 비어 있지 않은 부분문자열이어야 한다.

turn-entry claim 뒤 실제 resolved provider의 `capabilities.tools !== "supported"`면 확인 도구를 주입하지
않고 pending은 소비된 채 일반 tool-less 응답으로 끝낸다. active=0, pending=0,
`lastStopReason=control_unavailable`, diagnostic `confirmation_provider_unavailable` 1회다. provider가
supported라고 선언했으나 runtime 거부하면 Ollama fallback callback도 같은 상태로 안전 강등한다.

- 확인 도구 호출 + 구조 검사 통과: turn-entry에서 claim한 pending으로 `confirmed` candidate만 만든다.
  provider-local result를 thread한 뒤 첫 no-tool final text가 정상 완료될 때 atomic activity admission하며
  그 text를 첫 완결 발화로 센다. 그 사이 self-init/requested activity가 active slot을 먼저 차지하면
  candidate는 복원 없이 일반 응답으로 끝난다.
- 도구 미호출, 구조 검사 실패, provider 오류, 취소, 빈 최종 응답: pending 삭제 후 일반 턴 종료
- TTL 만료 또는 이미 소비된 `pendingId`: 활동 시작 금지
- 다른 session의 **사용자 턴**은 이 pending을 보거나 소비·삭제하지 않는다. 원래 session의 다음 사용자
  턴·TTL 외에는 명시적 stop과 accepted same-session self-init만 삭제할 수 있다.

“동의인가, 무관 답변인가”의 의미 판정은 이 좁은 도구를 선택하는 provider 책임이다. 앱이 키워드로 의미를
재판정한다고 과장하지 않는다. 앱이 결정론적으로 보장하는 것은 pending 수명·세션·1회 소비·enum·원문
충실도다. 계약 테스트는 같은 최신 원문에 대해 (a) 모델이 확인 도구를 호출한 fixture와 (b) 호출하지 않은
fixture를 모두 검증하고, 실연동 패널은 false-confirm을 별도 지표로 측정한다.

빈 `sessionId`에서는 확인 질문을 할 수 있지만 pending을 저장하지 않는다. 다음 턴 활성화를 약속하지 않으며
진단에 `pending_unavailable_missing_session`을 남긴다.

### 3.3 자유 발화

app 계층은 다음 진입점을 제공한다.

```ts
type SelfInitiatedSpeechRequest = {
  requestId: string;
  sessionId: string;
  reason: string;
  topic?: string;
  durationMinutes?: number;
  pauseSeconds?: number;
}

type SpeechActivityOutcome = {
  activityId: string;
  stopReason: ActivityStopReason;
  utteranceCount: number;
}

type SpeechActivityStart =
  | { accepted: true; activityId: string; done: Promise<SpeechActivityOutcome> }
  | { accepted: false; reason: "invalid_request" | "duplicate_request_id" | "already_active" | "busy" | "no_provider" | "no_subscriber" | "no_storage" }

startSelfInitiatedSpeech(req: SelfInitiatedSpeechRequest): SpeechActivityStart
```

비어 있지 않은 `requestId`, `sessionId`, `reason`이 필요하며 `requestId`는 live chat/activity registry에서
유일해야 한다. terminal 뒤 재사용은 허용하되 activity cancel에는 `requestId+activityId` 세대 토큰을
필수로 한다. proto `CancelRequest`에 optional `activity_id`를 추가한다. activity는 두 값이 모두 현재와
일치할 때만 취소하고, 이전 activity_id의 stale cancel은 no-op다. ID 없는 cancel이 이미 admission된 같은
requestId activity를 만나면 직접 취소하지 않고 아래 `ACTIVITY_ID_REQUIRED`와 현재 activityId를 반환한다.
새 shell은 각 `ChatRequest`에 crypto UUID인 비어 있지 않은 `request_generation`을 싣고 모든 Cancel에
같이 되돌린다. handler는 live turn에 이 값을 보존하고 정확히 일치할 때만 ordinary/requested cancel을
처리한다. terminal 뒤 같은 requestId를 재사용해도 새 generation이므로 이전 ID 없는 cancel이 새 ordinary
chat에 닿지 않는다. activity_id가 있는 cancel은 generation과 activityId가 모두 일치해야 한다.
legacy ChatRequest가 generation을 생략한 경우 그 legacy turn에 한해서 generation 없는 Cancel만 수용하고,
새 shell은 항상 생성한다.
확률적 tombstone은 사용하지 않아 새 ordinary chat을 오거부하지 않는다. live 중복이면
`duplicate_request_id`, process에 다른 active activity가
있으면 `already_active`, 일반 채팅 요청이 하나라도 진행 중이면 `busy`, 활성 default provider가 없으면
`no_provider`, 해당 session의 activity subscriber가 없으면 `no_subscriber`로 거부한다. `accepted:true`
반환 뒤에는 activity egress에 `sessionId+requestId`로 이벤트를 방출하고 `done`을 정확히 한 번 해소한다.
checkpoint-capable `conversationLog`가 없으면 `no_storage`로 거부한다. 사용자 요청 경로도 같은 admission
조건을 적용해 기록 포트가 없으면 candidate를 일반 단일 응답(active/pending 0)으로 끝내고 진단에
`storage_unavailable`을 남긴다. 이 경우 provider-local control 결과는 활성화하지 않고
`speechActivityState(sessionId).lastStopReason=storage_unavailable`로 관측한다. production
`compose-agent-deps`는 transcript가 켜진 기본 production에서 file conversationLog를 주입한다. 기존
`NAIA_AGENT_TRANSCRIPT=off`는 호환 유지하되 일반 채팅만 허용하고 self-init은 `no_storage`, requested
candidate는 `storage_unavailable`로 연속 활동을 정직하게 비활성화한다. headless/test composition의
미주입도 같은 일반 채팅 무회귀 규칙을 쓴다.
accepted self-init은 같은 session의 pending이 있으면 admission compare-and-set 안에서 그 pending timer와
값을 먼저 삭제해 오래된 확인 질문을 대체한다. 거부된 self-init은 pending에 영향이 없다.

provider 설정은 호출 시점의 `activeDefaultConfig`를 캡처하고 일반 채팅과 같은
`{...activeDefaultConfig, ...credentials.get(provider)}` 순서로 자격증명을 정확히 한 번 조회·병합한다.
그 완성된 snapshot을 활동 전체에서 재사용하며 중간 설정·키 변경은 다음 활동부터 반영한다.
persona·workspace의 기존 app 조립은 재사용하고 environment segment는 명시적으로 빈 배열로 둔다.
recall·compaction·`memory.save`는 사용자
턴이 없으므로 호출하지 않는다. 첫 provider
맥락은 wire와 저장에 노출되지 않는 내부 user-role 메시지
`[SELF_INITIATED_SPEECH] reason=<최대 500 Unicode code point>; topic=<최대 500 Unicode code point>`다.
reason/topic은 양끝 공백을 제거한 뒤 `Array.from(value).slice(0, 500).join("")`과 동등하게 자르고,
reason은 자르기 전 trim 결과가 비면 invalid_request, topic은 빈 값이면 생략한다. 이후에는 이 고정 기준점과 직전 완결
발화 하나만 사용한다. 언제 호출할지는 외부 정책 책임이지만 실행·취소·저장 계약은 요청 활동과 같다.

`ChatTurnHandler`가 이 메서드와 handler-owned activity promise registry를 소유한다. `wireAgentUC1()`은
idle/cron 정책과 gRPC가 직접 handler를 우회하지 않도록 `startSelfInitiatedSpeech` wrapper를 반환하고,
wrapper는 handler에 위임한다. handler의 `drainActivities()`는 진입 경로와 무관하게 registry 전체를 기다리며
composition `drain()`은 기존 chat in-flight와 이를 모두 기다린다. 따라서 테스트에서 handler를 직접 호출한
활동도 drain에서 빠지지 않는다. 생산 전달은 새 `SpeechActivityEgressPort`와 gRPC binding을 사용한다.

`activityId`는 주입 가능한 `activityIdFactory`(production=`crypto.randomUUID`)로 생성한다. handler가
소유한 active+최근 100 completed activity ID set에 대해 충돌 검사하며 최대 3회 재생성한다. admission 때
ID를 handler set에 원자 reserve하고 terminal 뒤 completed LRU로 유지한다. log adapter 조회는 필요 없다.
3회 모두 충돌이면 requested 경로는 일반 `error("activity id generation failed")`·active/pending 0,
self-init은 `{accepted:false, reason:"invalid_request"}`로 끝낸다. `activityId=requestId` 파생은 금지한다.

- `SubscribeSpeechActivities({session_id}) returns (stream AgentEvent)`: host가 세션마다 하나의 장기 stream을
  먼저 등록한다. event에는 활동 `request_id`와 `activity_id`가 포함된다. 같은 session의 두 번째 구독 RPC는
  `ALREADY_EXISTS`로 즉시 거부하고 원래 stream을 유지한다. 거부된 stream의 close는 disconnect callback이나
  현재 활동 취소를 발생시키지 않는다.
  process subscription registry는 최대 100 session이다. active binding은 축출하지 않으며 101번째 새 session
  subscribe는 `RESOURCE_EXHAUSTED`로 거부한다. host는 session 종료 시 stream을 cancel/close하고 adapter는
  최초 disconnect event에서 entry를 삭제해 자리를 회수한다.
- `StopSpeechActivity({session_id}) returns StopSpeechActivityResponse`: pending 삭제 또는 active 정상
  정지를 요청한다. 응답은 `enum StopSpeechActivityStatus {
  STOP_SPEECH_ACTIVITY_STATUS_UNSPECIFIED=0; PENDING_CLEARED=1; ACTIVE_STOPPING=2; NOT_FOUND=3; }`와
  `status` 필드를 가지며 app의 세 반환값을 1:1 매핑한다. 기존 bool `Ack`를 재사용하지 않는다.
- subscriber disconnect는 해당 세션 active를 `cancelled`로 중지해 보이지 않는 발화를 계속하지 않는다.
- `SpeechActivityEgressPort`는 장기 session subscription과 일시적 activity route binding을 구분해
  `tryBindActivity(sessionId, requestId): {release}|null`,
  `emit(sessionId, requestId, event)`, `onDisconnect(listener): unsubscribe`를 제공한다. listener 인자는
  `{sessionId}`이며 gRPC adapter가 해당 session stream의 `cancelled/close/error` 중 최초 한 번만 알린다.
  composition은 이 callback을 handler의 `disconnectSpeechActivity(sessionId)`에 묶는다. handler는 현재
  active의 session이 같을 때만 그 active requestId의 공용 AbortController를 `cancelled`로 중지하고,
  다른 session·이미 terminal인 request에는 아무 동작도 하지 않는다. stop/cancel/terminal은 activity
  binding만 release해 장기 stream을 다음 활동이 재사용하고, 실제 disconnect만 subscription과 binding을
  함께 삭제한다.
- self-init admission은 단일 동기 구간에서 provisional active slot을 compare-and-set한 뒤 await 없이
  `tryBindActivity`를 호출한다. null이면 slot을 rollback해 `no_subscriber`, lease면 active record에 붙여
  accepted를 반환한다. disconnect callback은 provisional/current activity도 cancelled로 정리하므로
  check-bind 사이 invisible accepted 상태가 없다.
- composition은 반환 wrapper만 정책/RPC에 노출하고 `drain()`에서 handler-owned `drainActivities()`를 기다린다.
- proto `AgentEvent`에는 선택적 `activity_id`를 추가한다. self-init subscription의 모든 활동 event에는 이를
  넣고, 사용자 요청 경로는 기존 `Chat` stream을 유지하되 atomic admission 뒤의 첫 완결 텍스트를 방출할 때부터
  terminal까지 같은 `activity_id`를 넣는다. 이를 위해 활동 후보의 첫 no-tool text는 provider finish까지
  app에서 버퍼링하고, admission·ID reserve가 성공한 뒤 text를 방출한다. admission 전 ordinary prelude에는
  activity_id가 없다. `AgentEgressPort.emit`은 선택적 `{activityId}` 메타데이터를 받고 gRPC codec만 이를
  wire 필드로 옮기며, stdio와 기존 호출자는 메타데이터 생략으로 호환한다.
- naia-shell은 세션 시작 시 self-init stream을 구독하고, 기존 Chat stream에서도 activity_id를 관측해 현재
  requestId+activityId를 저장한다. 새 사용자 턴·명시적 cancel은 활동 ID를 이미 받았으면 확장된
  `CancelRequest{request_id, request_generation, activity_id}`를, 아직 보지 못했으면
  `CancelRequest{request_id, request_generation}`을 보낸다.
  `Cancel`은 bool Ack 대신 `CancelResponse`를 반환한다. 닫힌 status는
  `CANCELLED | ACTIVITY_ID_REQUIRED | NOT_FOUND`이고 `ACTIVITY_ID_REQUIRED`에만 현재 `activity_id`가
  필수다. ID 없는 요청이 admission 전에 도착하면 ordinary turn을 `CANCELLED`로 중지해 이후 admission을
  막고, admission 뒤 도착하면 활동을 건드리지 않고 `ACTIVITY_ID_REQUIRED`를 반환한다. 셸은 현재 사용자
  cancel 동작 안에서 이 응답을 받으면 반환된 ID로 정확히 한 번 재시도한다. 이전 세대의 늦은 ID 없는 요청은
  그 자체로 새 활동을 중지하지 않으며, 잘못된 ID 재시도는 `NOT_FOUND`다. self-init은 event ID를 아직
  관측하지 못한 새 사용자 턴에서도 먼저 `StopSpeechActivity(sessionId)`를 호출해 현재 admission된 활동을
  ID 없이 정상 중지한다.
  proto는 `ChatRequest.optional string request_generation`, `CancelRequest.optional string
  request_generation`, `CancelRequest.optional string activity_id`,
  `CancelResponse { CancelStatus status; optional string activity_id; }`를 사용하고 `Cancel` RPC 반환형을
  기존 `Ack`에서 `CancelResponse`로 바꾼다. `CancelStatus` wire enum은
  `CANCEL_STATUS_UNSPECIFIED=0, CANCELLED=1, ACTIVITY_ID_REQUIRED=2, NOT_FOUND=3`이며 app 반환과 1:1이다.

이는 자유 발화를 턴 밖 1급 기능으로 포함한다는 사용자 결정 D1 때문에 필요한 최소 cross-repo wire 변경이다.
사용자 요청 연속 발화는 별도 subscription으로 우회하지 않고 activity_id가 확장된 기존 `Chat` stream을
계속 사용한다.

## 4. 활동 상태와 수명

상태는 다음과 같다.

```text
idle ──request/trigger──> active ──stop/bound/error──> terminal
  └──request-only──> pending ──confirm──> active
                         └──next-turn/ttl/cancel──> idle
```

활동 레코드는 최소한 다음을 가진다.

- `activityId`, `requestId`, `sessionId`, `origin`
- `startedAt`, `deadlineAt`, `utteranceCount`
- `status`, `stopReason`
- `durationMinutes`, `pauseSeconds`, `topic`

`ActivityStopReason`은
`deadline | utterance_limit | explicit_stop | cancelled | provider_error |
empty_utterance | control_unavailable | storage_unavailable`의 닫힌 열거다.

상태 변경은 단일 app 인스턴스 안에서 원자적이어야 한다. 핸들러는
`speechActivityState(sessionId)`를 제공하며 `{status, pendingCount, activeCount, activityId?,
utteranceCount?, expiresAt?, lastStopReason?, lastCheckpointStatus?:"appended"|"duplicate"|"failed",
checkpointFailureCount?:number}`를 반환한다. checkpoint status/count는 현재 또는 최근 완료 activity에
결속하고 0 이상 유한 정수이며 매 실패마다 증가한다. 완료 결과는 최근 100개 session의 LRU에만
보존하고 pending도 process 전체 LRU 100개와 TTL timer로 제한해 관측성·확인 상태 때문에 무한 누적하지
않는다. 선택적 debug 로그는 보조 증거일 뿐 수용 기준의 정본이 아니다.

active admission은 JS event-loop 안의 동기 compare-and-set 한 곳에서만 수행해 첫 요청이 이긴다.

- 요청 활동의 `immediate`/확인 성공이 active로 전환할 때 이미 다른 active가 있으면 첫 생성자가 유지되고,
  패자는 이미 생성한 첫 텍스트를 일반 단일 응답으로 방출한 뒤 정상 terminal한다. 새 pending은 만들지 않는다.
- `clarify` 결과로 pending을 만들려는 순간 active가 있으면 확인 질문 텍스트는 일반 응답으로만 끝내고
  pending을 만들지 않는다.
- 확인 pending을 소비한 뒤 admission에서 지면 그 pending은 복원하지 않고 일반 응답으로 끝낸다.
- self-init은 같은 compare-and-set에서 지면 `already_active`다. self-init이 먼저 이기면 뒤의 요청 활동은
  위 패자 규칙을 따른다. 일반 chat registry가 먼저 등록된 동안 self-init은 기존 `busy` 규칙으로 거부된다.

따라서 requested↔requested와 requested↔self-init race 모두 active=1, 패자의 pending=0이다. admission된
chat 요청과 **accepted** self-init activity만 wire terminal을 정확히 1회 낸다. live duplicate
chat은 기존 계약대로 같은 requestId active stream을 건드리지 않는 silent rejection(새 terminal 0)이다.
rejected self-init 시도는
event stream/done을 만들지 않고 동기 `{accepted:false, reason}` union으로만 완료한다.

## 5. 발화 루프와 맥락

1. 사용자 요청 경로는 제어 도구 call/result를 provider-local history에 정확히 한 쌍으로 완결한다.
2. 원래 사용자 메시지와 첫 최종 발화 전의 정상 도구 이력은 고정 기준점으로 보존한다.
3. 후속 호출에는 고정 기준점, 직전 완결 발화 하나, 숨은 진행 지시만 넣는다.
4. 숨은 진행 지시는 짧은 1~3문단, 자연스러운 연결, 답변 요구 질문 금지, 내부 제어 설명 금지를 요구한다.
5. 숨은 지시와 내부 제어 도구 객체는 앱이 wire·conversationLog·memory record로 직접 직렬화하지 않는다.
   provider가 그 내용을 임의로 재진술·의역하는 것까지 이 기능이 완전 차단한다고 약속하지 않는다. 그런
   모델 출력 안전은 별도 output-safety 계층 범위이며, 테스트는 내부 입력 객체와 provider 반환 출력을 구분한다.
6. 같은 round에 제어 호출과 외부 도구가 함께 오면 먼저 구조 검사로 candidate mode를
   `immediate | clarify | rejected`로 고정하고 provider-local result에 싣는다. 외부 도구는 기존
   승인·timeout·correlation 순서로 모두 실행하며 이어지는 일반 도구 round에는 외부 도구만 노출한다.
   첫 no-tool 최종 텍스트가 나오면 `immediate`만 active로 전환해 첫 발화로 세고, `clarify`는 active 0인
   채로 확인 질문을 방출한 뒤 pending을 생성한다. `rejected`는 일반 턴으로 끝난다. 그 전에 취소·provider
   오류·도구 상한이 발생하면 active와 pending 모두 만들지 않는다.
7. `continue_speaking` control은 첫 provider round에만 제공한다. 첫 round가 control call 없이 ordinary
   text 또는 external-only calls로 끝나면 이후 round에서 control을 제거하고 기존 external-tool loop만
   계속한다. 뒤늦은 control admission이나 120초 budget 재시작은 없다.
8. 활동 후속 호출에는 제어 도구와 외부 도구를 모두 노출하지 않는다.
9. 완결 텍스트가 비어 있으면 발화로 세지 않고 `empty_utterance`로 종료한다.

각 provider round는 실제 제공한 tool name allowlist를 캡처한다. confirmation round는 확인 도구 하나,
활동 후속은 빈 allowlist다. provider가 미제공 tool call을 반환하면 app은 wire·approval·executor로 절대
내보내지 않고 provider-local error result만 만든다. confirmation에서는 pending을 삭제하고 일반 오류
terminal, 활동 후속에서는 `provider_error`로 끝낸다. 적대 fixture가 tool list를 무시해도 실행은 0이다.

immediate와 confirmed 요청 활동의 `startedAt`은 모두 첫 no-tool 최종 텍스트가 확정된 뒤 atomic admission에
성공한 단조 시각이고,
`deadlineAt = startedAt + clamp(durationMinutes, 1, 30) * 60_000`이다. 앞선 외부 도구 round 시간은 아직
활동이 아니므로 duration을 소비하지 않는다. self-init은 admission 성공 직후·첫 provider 호출 전에 같은
공식으로 정한다.

## 6. 유한 경계와 자원 예산

- 기본 지속시간 10분, 허용 1~30분
- 기본 발화 간격 3초, 허용 0~30초
- 완결 발화 최대 60개
- 하나의 `ChatTurnHandler`/composition root active activity 최대 1개. 제품 host는 process당 composition
  root 하나라는 기존 조립 불변식을 유지한다.
- 활동 시작 전 일반 도구 루프는 기존 최대 8라운드
- `continue_speaking` 또는 `confirm_continue_speaking`이 포함된 provider round는 전체 tool call
  최대 32개다. 초과 call은 실행·approval 없이 correlation용 provider-local error result를 만들고 candidate를
  폐기해 일반 `error("control round tool limit")`, active/pending 0으로 끝낸다. hostile oversized list도
  유한하며 control이 전혀 없는 기존 ordinary external-tool round에는 이 새 cardinality 상한을 적용하지 않는다.
- tools=supported라 `continue_speaking` control을 주입한 **첫 provider 호출 직전**부터 admission까지
  initial control-selection round, mixed external-tool 실행과 이후 provider 호출은 하나의 별도 120초
  wall-clock 예산을 공유한다. 첫 round가 control call 없이 끝나면 예산을 즉시 해제하고 이후 ordinary
  external-tool loop는 기존 상한만 사용한다. control 미주입 ordinary chat에도 이 새 예산을 적용하지 않는다. 각 외부
  도구의 기존 60초 상한은 남은 공동 예산으로 더 줄이며,
  예산 소진 뒤 미실행 call은 correlation용 timeout result만 만들고 turn AbortController를 중지해 일반
  `error("provider timeout")`, active/pending 0으로 끝낸다. 이는 활동 duration과 별개라 mixed-tool prelude
  시간을 10분 활동 예산에 넣지 않으면서 과대·느린 tool list와 첫 no-tool 호출 무응답도 유한하게 만든다.
- 활동 후속 provider 호출은 발화당 1회이며 도구 호출 0회
- 활동 전체 provider 호출 최대 60회
- 모든 provider round는 종류와 무관하게 `ProviderChunk` 최대 4,096개, 누적 외부 payload UTF-8 최대
  262,144 bytes다. payload는 text/thinking 문자열과 toolUse의 `name+JSON.stringify(args)`를 포함하며
  직렬화 실패·단일 chunk 초과도 limit error다. app은 각 `iterator.next()` 직전과 각 chunk 수신 직후 단조
  시계를 확인하고 chunk/byte 한계나
  해당 round의 wall deadline에 닿으면 즉시 iterator return+AbortController abort를 시작한다. 따라서
  즉시 resolve되는 무한 chunk도 timer macrotask에만 의존하지 않고 유한 반복으로 끊긴다. admission 전/ordinary
  round의 초과는 `error("provider output limit")`, 활동 round의 초과는 `provider_error`와 같은 wire error로
  끝낸다. ordinary/pre-admission round는 기존 streaming을 유지해 한계 전에 이미 방출한 prefix는 회수하지
  않고 한계를 넘긴 chunk부터 버리며 memory/transcript commit은 하지 않는다. requested candidate의 첫
  no-tool text와 모든 admitted activity utterance는 finish까지 버퍼링하므로 limit/오류 시 그 미완 발화의
  wire/checkpoint는 0이다. 256KiB 상한은 완결 checkpoint payload에도 그대로 적용된다.

누락·비수치·비유한 값은 기본값, 유한 범위 밖 값은 clamp한다. 시간은 주입 가능한 단조 시계를 사용한다.
provider 호출 전, 대기 전, 대기 직후에 `now >= deadline`을 검사한다. 시간·횟수 중 먼저 도달한 경계가
우선하며 정상 종료한다. 활동 admission 때 `ActivityClock.scheduleAt(deadlineAt, callback): cancel`로
watchdog을 하나 등록한다. provider iterator나 대기가 멈춘 중에도 callback은 stopReason을 `deadline`으로
먼저 고정하고 공용 AbortController를 abort한다. runRound의 abort 반환은 이 고정 이유를 확인해 cancelled가
아닌 정상 `finish`로 매핑한다. terminal/finally에서 watchdog cancel과 타이머·abort listener를 성공·실패·
취소 모든 경로에서 해제한다. 같은 시각의 외부 cancel/stop과 deadline은 먼저 stopReason을 compare-and-set한
원인이 이긴다.

24GB 로컬 티어의 도구 지원 모델을 제품 기준으로 삼되 특정 모델명·thinking 설정에 의존하지 않는다.
`ProviderChatOpts`에 선택적 내부 callback
`onToolCapability({ support:"unsupported", reason })`을 추가한다. 도구 미지원 오류를 숨기고 tool-less로
재시도하는 Ollama 어댑터는 재시도 전에 이 callback을 정확히 한 번 호출한다. app은 control을 노출한
round에서 이 명시적 신호를 받으면 `control_unavailable` 결과와 상태를 기록한다. 신호가 없는 provider는
`unknown`이며 지원한다고 거짓 단정하지 않는다. 자유 발화 진입점은 도구 지원 여부와 무관하다.

## 7. 끼어들기와 정지

활동은 provider 호출과 발화 사이 대기에 하나의 `AbortSignal`을 공유한다.

- ordinary chat은 `cancel_stream(requestId, requestGeneration)`로, requested activity는
  `cancel_stream(requestId, requestGeneration, activityId)` 세 값이 현재와 모두 일치할 때, self-init은
  `cancel_stream(requestId, activityId)` 두 값이 현재와 모두 일치할 때 즉시 중지한다. ID 없는 requested cancel이
  admission 경쟁에서 늦으면 `ACTIVITY_ID_REQUIRED`를 받고 셸이 반환 ID로 한 번 재시도한다.
- 사용자의 새 턴은 self-init session Stop과 현재 requested request cancel을 완료한 뒤 시작
- `stopSpeechActivity({sessionId})`는 `"pending_cleared" | "active_stopping" | "not_found"`를 즉시
  반환한다. 정상 불변식상 같은 session pending+active는 공존하지 않는다. 방어적으로 둘 다 발견되면 pending
  timer/value를 먼저 지우고 active에 `explicit_stop`을 기록·abort하며 `"active_stopping"`을 반환한다.
  composition은 `ChatTurnHandler`의 이 메서드를 in-process 정책에 그대로 노출한다.
- provider iterator를 닫고 대기 타이머/listener를 정리
- 진행 중인 미완 텍스트는 체크포인트하지 않음
- 이미 체크포인트한 완결 발화는 삭제하지 않음

취소·stop·disconnect를 받은 즉시 stopReason을 compare-and-set하고 abort한다. 이미 시작한 checkpoint가
있으면 아래 커밋 barrier를 최대 5초 기다린 뒤 terminal을 방출하고, 없으면 즉시 방출한다. provider iterator
`return()`과 타이머/listener 해제도 같은 시점에 시작해 **동일한 5초 cancellation-cleanup watchdog**과
race한다. `return()` 또는 checkpoint가 영원히 멈춰도 취소 수신 후 5초 안에 terminal, activity/request
registry 삭제, per-activity route binding 삭제와 `done` 해소를 모두 끝낸다. 장기 session subscription은
disconnect가 아닌 stop/cancel에서 유지된다. 늦은 iterator 완료·이벤트·checkpoint
결과는 상태를 다시 열지 않는다. 이 5초는 10분/30분 activity deadline과 독립이며 terminal만 이 barrier를
기다리고 composition `drain`도 같은 barrier 이후 해소한다.

terminal은 `usage` 뒤 정확히 한 번 방출한다. `cancel_stream` 끼어들기는 `error(cancelled)`,
`stopSpeechActivity`와 시간·횟수 상한은 `finish`다. terminal 뒤 늦은 provider 이벤트는 버린다.

| `ActivityStopReason` | wire terminal |
|---|---|
| `deadline`, `utterance_limit`, `explicit_stop` | `finish` |
| `cancelled` | `error("cancelled")` |
| `provider_error` | `error("provider error: …")` |
| `empty_utterance` | `error("empty utterance")` |
| `control_unavailable` | 활동은 시작하지 않고 원래 일반 Chat 응답의 terminal을 유지. 상태에만 이 이유를 기록 |
| `storage_unavailable` | 활동은 시작하지 않고 원래 일반 Chat 응답의 terminal을 유지. 상태·진단에만 이 이유를 기록 |

## 8. 기록과 메모리

`ConversationLogPort`는 일반 턴 append와 별개로 멱등 체크포인트를 지원한다.

```ts
appendActivityCheckpoint({
  sessionId,
  activityId,
  sequence,
  initiatingUserText?,
  preludeAssistantText?,
  assistantText
}): Promise<"appended" | "duplicate" | "failed">

diagnostics?(): {
  readonly queueCount: number;
  readonly outstandingIoCount: number;
  readonly quarantinedSessionCount: number;
  readonly storageOverloaded: boolean;
  readonly retainedActivityCount: number;
}
```

선택적 `diagnostics()`는 file adapter의 읽기 전용 운영·테스트 seam이다. 앱 기능은 이 값으로 분기하지 않는다.

- 파일 레코드는 기존 reader와 호환되는 한 줄 JSON
  `{role:"assistant", content, timestamp, activityId, sequence}`다. 기존 `role/content/timestamp`는 유지하고
  새 필드만 추가한다.
- 사용자 요청 활동의 `sequence===1` 호출만 `initiatingUserText`를 필수로 받아 같은 append에서
  `{role:"user", content, timestamp, activityId, sequence:0}` 뒤 assistant line을 쓴다. sequence>1과 자유
  발화에는 이 필드가 없어야 한다. 여기서 initiating은 **활동 admission이 일어난 턴**이다. 즉시 활동은
  원래 지속 요청, 확인 뒤 활동은 확인 문장이다. 앞선 지속 요청+확인 질문은 pending 생성 전 일반 턴
  `conversationLog.append`로 이미 기록되므로 확인 활동 checkpoint에서 다시 쓰지 않는다. 따라서 각
  사용자 발화는 자기 턴에서 정확히 한 번만 기록된다.
- pre-admission의 **모든 tool-bearing round**(control-only, confirmation-only, control+external)에서 wire에
  이미 방출한 text는 `assistantTurnParts`에 prelude로 모아 sequence 1의 선택적
  `preludeAssistantText`로 넘긴다. adapter는 같은 atomic append에서 user
  sequence 0 뒤에 기존 호환 필드만 가진 ordinary assistant prelude line, 그 뒤 activity assistant
  sequence 1을 쓴다. prelude가 없으면 line도 없다. rejected/clarify 일반 턴은 기존 `append`가 prelude를
  포함한 전체 assistant text를 쓰므로 누락·중복이 없다.
- 키 `(sessionId, activityId, sequence)`는 dedupe state에 보존 중인 최근 100 activity 범위에서 멱등이다. file adapter는 in-memory
  activity-keyed LRU 100개를 두고 각 activity의 sequence `Set`을 최대 61개(user sequence 0 + assistant
  1~60)로 제한한다. 새 activity가 101번째면 가장 오래된 completed map을 폐기한다. 현재 active는 축출되지
  않는다. 축출된 activity와 앱 재시작 뒤 replay의 멱등은 약속하지 않는다. 각 보존 키는
  `absent | in_flight | succeeded` 상태다. enqueue 전에 원자적으로 `in_flight`를
  예약하고 동시에 같은 키가 오면 `"duplicate"`로 I/O를 만들지 않는다. 성공하면 `succeeded`다.
  reject/timeout은 partial write 가능성이 있으므로 key를 rollback하지 않고 session 전체를 quarantine하며
  이후 retry/I/O는 `"failed"`다.
- 파일명은 현재 클라이언트가 실제 생성하고 기존 adapter가 그대로 보존한 canonical session
  (`[A-Za-z0-9_-]+`, 최대 128자)만 기존 `<session>.jsonl`을 유지한다. 점·공백·경로 구분자·non-ASCII 등
  그 밖의 비어 있지 않은 원문은 UTF-8 SHA-256 전체 hex의 `session-<hex>.jsonl`로 쓴다. 따라서 `chat.1`과
  `chat_1`, 서로 다른 한국어 session, `..`가 서로 합쳐지거나 경로로 노출되지 않는다. 이전 버전이
  noncanonical ID를 치환해 합친 legacy 파일은 어느 원문 것인지 복원할 수 없으므로 자동 이관하지 않고
  read-only 역사 파일로 둔다. canonical client 파일만 경로 연속성을 보장한다.
- agent adapter는 `node:crypto.createHash("sha256")`, composition deps는 이 표준 해시 함수를 사용한다.
  naia-shell의 Rust `safe_session_base`도 같은 canonical 판정과 `sha2::Sha256` UTF-8 전체 hex를 사용하도록
  함께 변경한다. agent writer와 shell read/delete가 공통 벡터
  `chat-1`, `chat.1`, `한국어`, `../x`, 129자 ASCII에 대해 완전히 같은 basename을 내는 cross-repo
  계약 테스트를 둔다.
- 각 완결 발화를 wire 방출 직후, 다음 대기나 provider 호출 전에 append
- append 실패는 `"failed"`로 돌려 대화를 중단하지 않는다.
- file adapter의 checkpoint와 기존 append는 `appendFileSync`를 쓰지 않고 주입된 비동기
  `appendFile(path,data): Promise<void>`를 await한다. wire 완결 직후 시작한 checkpoint는 **커밋 구간**이라
  공용 activity AbortSignal과 race하지 않는다. cancel/deadline은 새 provider·대기·다음 checkpoint만
  막고, 이미 시작한 checkpoint는 독립적인 기본 5초(테스트 주입 가능) timeout까지 완료 기회를 가진다.
  timeout은 `"failed"`로 취급하고 dangling Promise rejection을 흡수한다. terminal/drain은 이 최대 5초
  commit을 기다리므로 무한히 붙잡히지 않으면서 이미 wire 완료된 발화를 cancel 경쟁으로 버리지 않는다.
- production `compose-agent-deps.mjs`는 callback/sync `node:fs` 객체를 넘기지 않고
  `node:fs/promises.mkdir`와 `appendFile`을 Promise 함수로 명시 주입한다. queue item은
  `mkdir({recursive:true}) → appendFile` 전체를 하나의 5초 I/O 예산으로 감싼다. composition integration
  test는 실제 임시 디렉터리 write를 지연/해소해 Promise settle 전 checkpoint/terminal이 완료되지 않고
  실제 파일 반영 뒤 완료됨을 검증한다.
- file adapter는 기존 `append`와 `appendActivityCheckpoint`를 모두 session별 Promise queue에 enqueue한다.
  process-wide 실제 filesystem I/O semaphore는 8개, 아직 시작하지 않은 queue entry는 128개 상한이다.
  각 entry의 5초 deadline은 **enqueue 시각부터** 계산한다. permit을 얻기 전 deadline이면 queue에서 제거해
  `"failed"`로 해소하고 이후 I/O를 시작하지 않는다. 129번째는 I/O 없이 `"failed"`/일반 append 진단으로
  거부한다. reject와 timeout 모두 원 I/O의 filesystem
  부작용이 0이라고 가정하지 않고 해당 session writer를 quarantine한다. 원 Promise가 settle할 때까지
  이후 같은 session append/checkpoint는 즉시 `"failed"`로 반환하며 새 I/O를 시작하지 않으므로 늦은 write가
  후속 record 뒤에 쓰이는 역전을 막는다. timeout session은 원 Promise가 settle해도 그 process 수명에는
  다시 열지 않는다. canonical session hash를 exact quarantine Set 최대 1024개에 보존한다. 1025번째
  quarantine이 필요하면 `storage_overloaded=true` global circuit breaker를 세워 process 수명 동안 모든
  새 transcript I/O를 명시적으로 `"failed"` 처리한다. false-positive나 unrelated-session 오염은 없으며
  overload는 diagnostics에 노출한다. process 재시작 때는 이전 Promise가 없으므로 상태를 초기화한다.
  semaphore permit은 timeout이 아니라 **물리 Promise settle 때만** 반환한다. timeout된 실제 I/O 8개가
  permit을 모두 점유하면 즉시 `storage_overloaded=true`로 전환하고 대기 queue를 모두 `"failed"`로 해소한다.
  이는 취소 불가능한 filesystem Promise 위에서 실제 outstanding≤8을 지키기 위한 명시적 전역 저장 강등이다.
  unrelated clean session 비간섭은 permit 포화 전까지만 보장하며 포화 뒤 일반 chat은 기존 transcript
  no-throw 정책대로 응답은 유지하되 저장 실패 진단을 남긴다.
  timeout 때 session queue registry entry는 즉시 삭제하고 원 Promise에는 독립 rejection 흡수만 남긴다.
  never-settle I/O가 session별 map reference를 누적하지 않으며 exact quarantine/overload가 새 queue 생성을 막는다. 따라서 pending은 앞선
  clarification append의 실제 I/O 완료를 기다리지 않고 다음 턴에 claim될 수 있지만, confirmed activity의
  sequence-0/1 checkpoint는 앞 append 성공 시 반드시 clarification 뒤에 기록되고, timeout 시 checkpoint도
  failed라 역전 기록이 없다. queue entry 각각은 같은 5초 I/O bound를 가지며 정상 idle queue는 마지막
  작업 settle 뒤, timeout queue는 deadline 즉시 registry에서 삭제한다.
- 일반 단일 응답의 `conversationLog.append`도 기존 no-throw 의미를 유지하면서 동일한 주입 가능 기본 5초
  timeout으로 감싼다. reject/never-settle은 진단 후 terminal을 계속 방출하고 drain을 영구 정지시키지 않는다.
- `memory.save`는 활동 전체에서 호출하지 않음
- 일반 단일 응답 턴은 기존 `conversationLog.append`와 `memory.save` 계약 유지
- 사용자 요청 활동의 원래 사용자 발화를 sequence 1에서만 저장하고 발화마다 중복하지 않음
- 활동 종료 시 복수 발화를 다시 하나의 거대 turn으로 중복 append하지 않음
- `ConversationLogPort`의 모든 fake와 file adapter를 새 메서드에 맞춰 갱신하고, contract/integration
  테스트에서 JSONL 호환성·순서·동일 키 duplicate와 diagnostics queue/quarantine/retained 수를 검증한다.

모든 provider 호출의 usage는 합산해 wire에 마지막 한 번만 방출한다.

## 9. 수용 기준

| AC | 검증 가능한 기준 |
|---|---|
| AC1 | 별도 근거인 지속 요청+수동 청취가 충실하면 같은 requestId에서 서로 다른 completed provider round/checkpoint sequence 발화 2개 이상(`utteranceCount>=2`) 후 usage/terminal 각 1회이며 emitted input/output token은 pre-admission+모든 activity provider 호출의 fixture 합계와 정확히 일치 |
| AC2 | 지속 요청만 있으면 즉시 시작 0회, 정상 확인 질문 뒤 해당 session pending 1개 |
| AC3 | 정확한 원문 `잠들 때까지 얘기해줘` fixture가 구조 검사를 거쳐 pending 0·active admission 1, completed checkpoint sequence≥2, terminal 1로 즉시 시작 |
| AC4 | 부재 신호만 있으면 일반 종료, 유효 지속 quote와 identical/contained/overlapping evidence이면 확인 pending 1. fabricated/non-substring/empty quote는 admission 0이며 NFKC·공백 동등 fixture는 통과한다. `계속 말해줘`에서 request=`계속 말해줘`, away=`말해줘` subspan은 즉시 활성 0 |
| AC5 | pending은 다음 한 턴·같은 session·2분 안에서만 정확히 한 번 소비된다. 겹친 same-session 확인 턴 둘 중 turn-entry 선착순 하나만 동기 claim해 확인 도구를 보고, 뒤 턴은 보지 못함 |
| AC6 | pending 턴에서 supported provider에는 enum 확인 도구만 노출된다. 성공 fixture는 confirm candidate→provider-local result→첫 no-tool text 뒤 atomic admission, active=1·pending=0, completed checkpoint sequence≥2, accumulated usage/terminal 각1이다. 미호출·구조 실패·오류·취소는 pending0이다. claim 뒤 provider unknown/unsupported는 tool0·일반 응답·control_unavailable 진단이다 |
| AC7 | 빈 sessionId의 immediate는 첫 텍스트를 일반 응답으로, clarify는 확인 질문 텍스트를 일반 응답으로 각각 방출하되 둘 다 active·pending 0이고 다음 턴 확인 도구 0. clarify diagnostic spy에 `pending_unavailable_missing_session` 정확히 1회. 다른 session에서 pending 활성화 0회이고 다른 session 턴은 원래 pending을 유지 |
| AC8 | 자유 발화 union은 invalid_request(빈 필드, activityId 3회 충돌), duplicate_request_id, already_active, busy, no_provider, no_subscriber, no_storage 각각 exact discriminator를 검증한다. reason/topic Unicode code point 500은 보존, 501은 정확히 500으로 truncate한다. requested cancel은 requestId+requestGeneration+activityId가 모두 일치할 때만 activity를 중지하고 self-init은 requestId+activityId를 사용하며 stale/cross-kind cancel은 무해하다. 정상 self-init은 서로 다른 completed provider round/checkpoint sequence≥2, utteranceCount≥2, usage/terminal 각1이며 tryBind race, UUID 충돌, composition 상한, snapshot, stream/drain을 지킨다. transcript=off requested는 storage_unavailable다 |
| AC9 | requested와 self-init 두 origin 각각 후속 provider 입력에 고정 기준점·직전 발화·숨은 지시가 있고 60개 전체 이력은 없음. app 내부 prompt/tool payload 직접 wire/log 직렬화 0, 활동 memory.save 0이다. provider 반환 text는 기존 계약대로 전달한다 |
| AC10 | mixed control+external round는 correlation 완주 뒤 mode별로 immediate만 활성화, clarify만 pending, rejected는 일반 종료한다. confirmation/activity round에서 tool list를 무시한 적대 provider의 미제공 외부 call도 wire·approval·실행 0회. control round 32-call 경계와 33-call hostile list의 provider-local correlation·실행 0·일반 error를 검증 |
| AC11 | deadline 동일 경계, 60회 상한, 호출 전·대기 전·대기 후·각 iterator.next 전·각 chunk 후 경계와 활동 중 멈춘 provider watchdog abort→정상 finish가 검증된다. control 주입 첫 round부터 admission까지 공유하는 120초 wall budget에서 초기 iterator never-yield, 느린 mixed tool, 이후 멈춘 provider가 각각 일반 error, active/pending 0이다. 4,096 chunk 경계/4,097 초과와 누적 외부 payload UTF-8 262,144 byte 경계/초과, oversized tool args와 즉시 resolve 무한 chunk fixture가 유한 종료한다. activity 미완 발화는 wire/checkpoint 0, ordinary는 한계 전 streamed prefix만 남고 memory/transcript commit 0이다 |
| AC12 | duration/pause 기본값·clamp가 실제 deadline과 wait 인자에 반영되고 요청 활동 deadline은 느린 mixed-tool prelude 뒤 admission 시각부터 계산됨 |
| AC13 | requested와 self-init 두 origin 모두 host가 activityId를 획득해 generation-safe cancel을 보내고 5초 안 cleanup/done/terminal을 지킨다. requested Chat은 admission 뒤 첫 완결 text부터 terminal까지 같은 activity_id, self-init subscription은 모든 event에 같은 activity_id를 싣는다. requested의 admission 전 ID 없는 cancel은 matching request_generation에서 ordinary CANCELLED, admission 뒤·첫 tagged event 관측 전 ID 없는 cancel은 활동 무변경+ACTIVITY_ID_REQUIRED(current ID)이고 1회 재시도가 취소한다. self-init은 첫 event 관측 전 session Stop이 취소한다. 재사용 requestId에 이전 generation/ID cancel과 cross-kind cancel은 무해하다. checkpoint backlog 중 cancel/finish도 enqueue부터 5초 안 terminal이며 시작 전 만료 entry의 늦은 I/O=0이다. stream 재사용, subscription duplicate/cap/recovery를 검증 |
| AC14 | storage 성공 시 JSONL provenance·sequence를 지킨다. duplicate/reject quarantine을 검증한다. never-settle I/O 1~7개까지 unrelated clean write가 남은 permit으로 성공하고 8개 포화 시 outstanding=8·storageOverloaded=true·대기 queue=0·모든 새 I/O failed다. permit은 각 원 Promise 실제 settle 뒤만 반환한다. quarantine exact Set 1024/초과 overload, 129 queue cap, production fs barrier, cancel commit, basename을 검증 |
| AC15 | 취소/오류 전에 성공적으로 커밋된 완결 발화는 남고 미완 발화와 활동 `memory.save`는 0. checkpoint `"failed"`는 대화를 중단하지 않되 durable이라고 보고하지 않고 상태·진단에 실패를 남김 |
| AC16 | 일반 채팅과 기존 외부 도구 턴의 correlation·save·terminal 무회귀. unknown은 control 0, supported control-unselected ordinary도 기존값이다. external-only 첫 round 뒤 이후 control=0·budget 해제이며 기존 multi-round correlation을 유지한다. 일반 append failure도 격리된다 |
| AC17 | `ProviderPort.capabilities.tools`의 supported/unsupported/unknown 세 fixture가 control 주입 1/0/0이다. fallback contract가 있는 Ollama만 supported이고 OpenAI-compatible은 현재 unknown이다. Ollama 실제 모델 거부는 callback 1회, control_unavailable·활성 0이며 자유 발화는 동작 |
| AC18 | `speechActivityState`로 pending/active count와 닫힌 종료 원인을 관측한다. fake scheduler의 TTL 경과만으로 pending이 물리 삭제되고 timer 유실은 state/drain이 보정하며, pending과 최근 완료가 각각 LRU 100 상한이다. requested↔requested와 requested↔self-init race는 winner 1·loser pending 0이다. admitted chat과 accepted self-init만 terminal 1회, live duplicate chat은 새 terminal 0, rejected self-init은 동기 union만 반환한다. accepted same-session self-init은 기존 pending을 원자 삭제 |

## 10. 테스트와 증적

결정론 계약 테스트:

- `src/test/uc-continue-speaking.contract.test.ts`
- fake provider, fake 단조 시계, 제어 가능한 wait, abort 가능한 iterator
- AC1~AC18의 양성·음성·경계·오류 사례
- 의미 키워드가 아니라 모델 tool call과 원문 구조를 fixture로 제공
- `src/test/conversation-log.contract.test.ts`와 `conversation-log.integration.test.ts`에서 체크포인트 JSONL
  호환성·process-local 멱등성을 실 adapter로 검증
- `src/test/uc1-ollama-provider.contract.test.ts`에서 tool-less degrade callback 1회를 검증
- `src/test/uc-continue-speaking-grpc.integration.test.ts`의
  `requested activity id and barge-in`, `speech activity subscription lifecycle`, `stop response mapping`,
  `composition activity drain` 그룹에서 requested Chat의 tagged first text → 두 ID cancel과
  subscribe → self-init → 두 ID cancel/stop → terminal, disconnect, duplicate/cap, stream reuse와 세 status
  1:1을 검증
- 형제 `naia-shell`의 Rust `agent_grpc` contract/live test와 `packages/shell/e2e-tauri`에서 실제
  subscribe → 기존 `agent_response`/TTS 소비 → received requestId+activityId cancel/새 사용자 턴 barge-in → terminal,
  stop/disconnect·중복 session 구독 정리를 검증한다. 셸 P01~P03 추적은 기술 MVP
  UC15/FR-CONT-SHELL.1~7과 #84 제품 수용 FR-CONT-SHELL.8~9다.

AC→FR→테스트 단언:

| AC | FR | 파일 / named test group과 핵심 단언 |
|---|---|---|
| AC1 | FR-CONT-1,6,7 | `uc-continue-speaking.contract.test.ts` / `immediate activity`: distinct completed rounds/checkpoint sequences≥2, utteranceCount≥2, usage=1, terminal=1, pre-admission+activity numeric sum |
| AC2 | FR-CONT-1,2 | 같은 파일 / `clarify pending`: active=0, 정상 텍스트 뒤 pending=1 |
| AC3 | FR-CONT-1,6,7 | 같은 파일 / `passive duration evidence`: 정확 원문 P-AMB-006이 immediate active=1·pending=0·checkpoint seq≥2·terminal=1; corpus label positive도 별도 단언 |
| AC4 | FR-CONT-1,2 | 같은 파일 / `structural validator mutation fixtures`: identical/contained/overlapping span→pending, fabricated/empty→admission0, NFKC/whitespace positive, 한 글자 negative |
| AC5 | FR-CONT-2 | 같은 파일 / `pending lifetime and overlapping claims`: same-session·next-turn·TTL, overlapping 2턴 선착순만 tool 제공·atomic once |
| AC6 | FR-CONT-2,4,6,7,8 | 같은 파일 / `confirmed activity end-to-end`: candidate→no-tool admission→checkpoint≥2·usage/terminal1; cleanup과 provider capability 전환 |
| AC7 | FR-CONT-1,2,8 | 같은 파일 / `session admission isolation`: empty session immediate=일반 첫 text, clarify=일반 확인 text+`pending_unavailable_missing_session` 진단 1회, 둘 다 active=pending=0·다음 턴 확인 tool=0; other session 격리 |
| AC8 | FR-CONT-3,4,6,7,8 | 같은 파일 + gRPC / `self-init admission and completion`: exact union, reason/topic code-point 500/501, generation cancel, stale reuse, tryBind/UUID, distinct rounds/checkpoints≥2·utteranceCount≥2·usage/terminal1, snapshot/stream/drain |
| AC9 | FR-CONT-3,4,7 | 같은 파일 / `bounded continuation context and direct serialization isolation` parameterized `origin=requested|self-init`: anchor+last+hidden, full-history absent, direct emit/append=0, memory.save=0 |
| AC10 | FR-CONT-1,2,4,5 | 같은 파일 / `mixed tool round and hostile unoffered calls`: correlation 완주, immediate/clarify/rejected 분기, tool-list 무시 fixture의 wire/approval/executor=0, control round 32/33 call 경계와 초과 실행=0 |
| AC11 | FR-CONT-5 | 같은 파일 / `hard bounds`: call/wait/chunk 전후 deadline, active hung provider→finish, control 주입 initial never-yield/mixed slow tool/후속 hung provider가 공유 120초에서 error·active/pending=0, 60회, 4096/4097 chunk와 256KiB payload·oversized args 경계, immediate infinite-yield 유한 종료, activity 미완 emit/checkpoint0, ordinary prefix 보존+commit0 |
| AC12 | FR-CONT-5 | 같은 파일 / `clamped options`: 실제 deadline·wait 인자, slow mixed-tool prelude 뒤 deadline anchor |
| AC13 | FR-CONT-3,5,6,7 | agent gRPC `requested activity id and barge-in` + `speech activity subscription lifecycle` + `stop response mapping`; shell `packages/shell/src-tauri/src/agent_grpc.rs` `speech_activity_*` Rust tests + `packages/shell/e2e-tauri/continuous-speech.spec.ts` / `requested and self-init barge-in and stream reuse`: 두 origin의 ID 획득·cancel, requested first text/terminal ID, admission 전 generation-matched ordinary cancel과 admission 후 ID 관측 전 ACTIVITY_ID_REQUIRED→1회 retry, 재사용 requestId에 stale generation 무해, self-init ID 관측 전 session Stop, stop/disconnect, enum 1:1, cap/reuse, cleanup |
| AC14 | FR-CONT-2,6 | log integration / `global I/O saturation degradation`: physical permit lifetime, 1~7 clean progress, 8th overload+queue drain, quarantine/queue caps; compose async settlement; shell filename vectors |
| AC15 | FR-CONT-6,7,8 | `uc-continue-speaking.contract.test.ts` / `partial durability`: 성공 commit 완결만 durable로 보존, failed checkpoint에서 `lastCheckpointStatus=failed`·failureCount 증가·진단과 활동 지속, 미완/활동 memory.save=0 |
| AC16 | FR-CONT-4,5,7 | 기존 `uc1-agent.contract.test.ts` + 같은 파일 / `ordinary/external regression`: unknown control=0, supported control-unselected ordinary save/terminal, supported external-only 첫 round budget release+기존 multi-round correlation, append failure bound |
| AC17 | FR-CONT-3,4,8 | Ollama provider + all-provider wiring / `capability declaration and degrade`: fallback-tested Ollama supported, OpenAI-compatible unknown, 주입 1/0/0, model reject callback=1/lastStopReason, self-init 성공 |
| AC18 | FR-CONT-2,3,7,8 | 같은 파일 / `bounded state retention and races` + agent gRPC / `composition activity drain`: TTL/LRU, atomic winner, terminal counts, pending supersede, handler-owned drain |

실연동 모델 패널:

- 증적: `.agents/reviews/issue-82-v3-panel-ollama032-thinking-on-2026-07-18.json`
- 공통 환경: Ollama 0.32.1, thinking=true, 모델별 3회
- 이 파일의 기존 R1은 `quote != evidence`까지만 적용한 v3 원자료다. v3.1의 비포함·비중첩 별도-span
  postprocessor로는 그대로 합격 수치라고 인용하지 않는다.
- `benchmark/v3-evidence-probe2.mjs`와 `merge-v3-evidence-panel.mjs`를 production 구조 검사와 같게 갱신했으며,
  test 게이트에서 6모델 패널을 다시 실행해 새 activation/clarification 수치를 별도 증적으로 고정한다.
- `P-AMB-006`은 측정으로 라벨 오류가 확인되어 즉시 시작군으로 수정
- 8B 결과는 하한 참조이며 제품 합격 기준으로 승격하지 않음

게이트:

1. planning: GLM-5.2 credit unavailable와 OpenRouter Hy3 품질 부적합을 기록하고, 서로 상태를 공유하지 않는
   ephemeral Codex reviewer 2회 연속 CLEAN으로 대체
2. 테스트 RED 확인
3. development: 교차검토 2회 연속 CLEAN
4. test: 계약·회귀·실연동 증적 검토 1회 CLEAN
5. integration: 요구→계약→코드→테스트 2회 연속 CLEAN

기준선 예외:

- 2026-07-18 전체 빌드는 기존 `naia-memory.ts`의 임베딩 모델 union 불일치 1건으로 실패한다.
- 완료 검증 테스트는 일반 환경에서 11/11 통과했다.
- 이 기준선 결함은 #82 변경과 섞지 않으며, #82 diff가 새 실패를 추가하지 않는지를 별도로 확인한다.

## 11. 폐기된 설계

다음은 구현하지 않는다.

- v1: 모델 quote가 사용자 원문에 포함되면 활성화하는 단일 substring 가드
- v2: 셸 승인 모달과 “항상 허용”을 재사용하는 승인 게이트
- v3 초안: 턴 지역 pending, 발화별 외부 도구 예산 리셋, 종료 시 거대 turn 1회 저장

이력과 기각 근거는 `.agents/progress/issue-82-continuous-speech.md` 및 2026-07-17 review JSON에 보존한다.
