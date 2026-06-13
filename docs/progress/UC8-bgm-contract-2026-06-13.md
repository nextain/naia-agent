# UC8 (공간 분위기 / BGM) — Old-Baseline + 포트 계약 (2026-06-13)

session_id: ec74cc29-3347-4f6e-b29a-237ea29f301e

> 표준 step1-2(계약먼저, 음악HW/외부 불요 — 코드 도출). UC8 = Chat→사고→환경변경(space, BGM)+관측.
> ⚠️ **external-service-heavy**: youtubei.js(Innertube) HTTP server + shell BGM player. agent-local(skill 구조/tool spec) 이식 가능, **실제 youtube 검색/재생 live = 루크 머신**.

## §A. Old-Baseline (코드 도출, old-naia-os/agent/src)
- **skill**: `skills/built-in/youtube-bgm.ts createYoutubeBgmSkill` (197줄, tool name=youtube_bgm). 11 액션: search(검색+첫결과 자동재생)/play(videoId)/stop/pause/resume/next/prev/volume(0-1)/trending(ambient)/fav_add/fav_remove/fav_list. args: {action, query?, videoId?, title?, volume?}.
- **youtube-server**: `youtube-server.ts` (204줄, port 18791 HTTP) — Innertube(youtubei.js) lazy singleton, search + stream-url 엔드포인트. shell BGM player 가 호출. `bgm-server-bin.ts` = 서버 기동 bin.
- **shell 측**: bgm config(bgmTrack/bgmSource/bgmYoutube* — UI 버킷, F0/config-map 에 이미 분류) + BGM player(audio). agent skill 이 `bgm_youtube_play` 명령을 shell 로(old send_to_agent 역방향/이벤트).
- **상태전이**: search→playing / pause⇄resume / stop→cleared / favorites CRUD. volume 0-1.

## §B. 포트 계약 (헥사고날, substrate-agnostic)
```
SpacePort (환경 변경 = BGM, agent-side tool):
  bgm(action, args): BgmResult | Unsupported   # action 별 분기(search/play/stop/...)
  # search/trending → MusicSearchPort.search(query) (external youtubei.js)
  # play/stop/pause/... → shell BGM player 제어(os EnvironmentPort.space, gRPC/이벤트)
MusicSearchPort (external — youtubei.js):  search(query): Track[] / streamUrl(videoId): url
BgmContextPort: favorites CRUD + nowPlaying (config/store)
```
- agent skill = ToolExecutor(builtin-skills 패턴, openmeteo 처럼 search 를 injected fetch dep 로). tier: search/play=환경변경 → **ask(승인)** 후보(UC13 게이트).
- 도메인(순수): action 유효성, volume clamp(0-1), 상태전이 규칙. I/O 0.

## §C. os-local/agent-local vs external 분해
1. **agent-local 이식 가능(자율)**: youtube_bgm ToolExecutor skill(action 라우팅 + arg 검증 + 도메인 상태전이) + MusicSearchPort/BgmContextPort 인터페이스. search 는 injected dep(mock 테스트). = builtin-skills 에 등록(github/obsidian 패턴).
2. **external = 신규 계약 + 루크머신**: (a) youtubei.js Innertube 검색/stream(youtube-server 또는 in-process) (b) shell BGM player 제어 = os EnvironmentPort.space(gRPC 명령 또는 이벤트 — 신규 wire) (c) 실제 재생 live.
3. **tier 정책**: BGM 재생=환경 변경 → UC13 승인(ask) 권장(자동 환경변경 방지). 단 사용자 명시 "음악 틀어줘"=의도 명확이라 정책 결정 필요(계약 ratify).

## §D. 리뷰 표준 (UC8)
T2(외부연결). open-loop 2-AI(정본=old youtube-bgm). 집중: search injected(외부 직결 금지), volume clamp, 환경변경 tier(승인), favorites 영속.

## §E. 다음 (UC8 개발)
1. agent youtube_bgm ToolExecutor skill 이식(action 라우팅 + 도메인 + MusicSearchPort 인터페이스, injected search) + builtin-skills 등록 + 단위테스트(mock search) → 2-AI 리뷰.
2. external: youtubei.js search adapter + shell BGM player gRPC/이벤트 wire(신규계약) + 루크머신 live(실 youtube 재생).
> = agent-local skill 구조는 자율 이식+리뷰 가능, 실 youtube/재생은 루크머신 게이트.
