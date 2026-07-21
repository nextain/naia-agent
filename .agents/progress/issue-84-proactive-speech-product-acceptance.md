# Issue #84 — 선제 발화 profile 제품 검증

## 완료 증적 (2026-07-21)

- 상태: PA-DJ-01~06, PA-EX-01~02 구현 및 자동 수용 완료
- agent: 전체 1,181 pass / 9 skip. sandbox 자식 프로세스 3건은 외부 재실행 8/8 pass
- memory: 전체 382 pass, build/타입 검사 pass
- shell: 전체 1,287 pass / 13 skip, build/타입 검사 pass
- Playwright: browser/synthesized TTS, 여섯 DJ 제어, 250ms interrupt, profile ACK/fence,
  unseen old stream 폐기, 전시 yield/resume를 포함한 7/7 pass
- 실제 Tauri WebDriver: file-backed profile 저장·cache-clear 재수화·날씨 동의 철회 1/1 pass
- Rust: activity subscription epoch 재구독 경계 `cargo check`/`cargo build` pass
- 개발 적대 리뷰: 두 독립 리뷰어가 동일 diff에서 연속 CLEAN 2회

## 제품 수용 계약 (2026-07-20 기준선 → 2026-07-21 GREEN)

| 계약/REQ | UC 성공·실패 기준 | 기능(FE) | 구현 전 named test(RED) |
|---|---|---|---|
| PA-DJ-01 / FR-CONT-MVP-3·7 | `DJ 좋아요/싫어요/취향 삭제:`만 workspace-scoped exact index에 저장하고 Naia Memory로 v1 provenance를 outbox handoff한다. NFKC/공백/대소문자 동일 subject의 atomic `(sequence,requestId)` 최신값만 사용한다. index+outbox commit이 성공 경계이며 손상·중복은 무시하고 재생시간 추론은 0이다. | preference codec/keyed index/durable memory outbox + runtime command | `src/test/radio-dj-product-acceptance.contract.test.ts` `PA-DJ-01 persists, recalls, overrides and forgets only explicit preferences` |
| PA-DJ-02 / FR-CONT-MVP-3 | `DJ 상태:` 원문만 같은 session 6시간 동안 사용한다. 다른 session·미래·6시간 초과·일반 감정 대화는 mood 슬롯 0. | structured command + session mood store | 같은 파일 `PA-DJ-02 keeps explicit mood session-bound and fresh for six hours` |
| PA-DJ-03 / FR-CONT-MVP-4 | grounded fragment 조합으로 연속 8개 멘트가 모두 다르고 최근 6문장 반복 0. 없는 weather/mood/preference/곡 세부 추측 0. | bounded comment planner | `src/test/personal-radio-dj.contract.test.ts` `PA-DJ-03 emits eight grounded non-repeating remarks` |
| PA-DJ-04 / FR-CONT-SHELL.8 | profile/idle/interval/timezone/BGM/weather/좌표/knowledgeScope를 파일에 저장·복원한다. invalid timezone·부분/범위 밖 좌표·빈 전시 scope는 fail-closed. 미동의/철회는 좌표 저장·wire 0. | settings normalizer + UI + file config | `packages/shell/src/lib/__tests__/proactive-speech-settings.test.ts`; `packages/shell/src/components/__tests__/SettingsTab.proactive-speech.test.tsx`; native `packages/shell/e2e-tauri/specs/71-proactive-speech-profiles.spec.ts` `persists validated proactive settings after cache-clear native reload` |
| PA-DJ-05A / FR-CONT-SHELL.9 | browser TTS는 `speak`, 합성 TTS는 audio `play`를 각각 시작한다. | 기존 TTS lane 관측점 | `packages/shell/e2e/121-proactive-speech-product-acceptance.spec.ts` `speaks proactive text through browser TTS` / `plays synthesized proactive audio` |
| PA-DJ-05B / FR-CONT-MVP-4·FR-CONT-SHELL.9 | music-only/talk-less/change-vibe/next/stop 각각 한 RPC, interrupt가 250ms 이내 먼저다. 이전 generation 늦은 text/audio 0. | command/control + stale gate | 같은 Playwright 파일 `interrupts before every DJ control and drops stale output`; native `71...spec.ts` `starts and persists personal radio DJ through the real Tauri IPC path`는 실제 IPC 시작·영속 경계만 담당 |
| PA-DJ-06 / FR-CONT-MVP-4 | 8h fake clock에서 30m lease는 16회 이상 갱신, controller/play 각 1, pending timer O(1), stop 뒤 TTS/BGM 0. | lease soak/race | `src/test/personal-radio-dj.contract.test.ts` `PA-DJ-06 survives an eight-hour bounded lease soak and terminal stop` + 같은 파일의 stop/play race tests |
| PA-EX-01 / FR-CONT-MVP-5·6·FR-CONT-SHELL.9 | 유효 knowledgeScope로 소개 중 질문 시 interrupt→source 답→미소개 resume. quiet/stop과 이전 generation 답 0. | KB profile + activity binding | `src/test/exhibition-intro.contract.test.ts` `EX-04/05: 질문은 먼저 interrupt하고 답변 뒤 미소개 항목으로 복귀하며 quiet는 재개하지 않는다` 및 race tests; `src/test/speech-profile-runtime.integration.test.ts` `PA-EX-01/02 routes a yielded question to grounded KB with memory and transcript off`; Playwright `ordinary chat interrupts before yielding the active exhibition`; native `71...spec.ts` `starts exhibition introduction without waiting for ordinary chat`는 실제 IPC 시작 경계만 담당 |
| PA-EX-02 / FR-CONT-MVP-7 | 소개/질문의 memory recall/save, transcript, raw-content diagnostic log가 0. source 없음은 기권. 승인하지 않은 telemetry producer 0. | privacy/grounding invariant | 위 agent integration test + `src/test/exhibition-intro.contract.test.ts` `PA-EX-02 keeps exhibition memory, transcript, raw-content logs and telemetry producers off` 및 `EX-03: abstained/source-empty 질문은 고정 기권한다` |

V-model의 두 RED 게이트는 다음처럼 분리한다.

| 계약 | UC test (사용자 관통, 먼저 RED) | FE test (기능 단위, UC test 뒤 RED) |
|---|---|---|
| PA-DJ-01·02 | `src/test/speech-profile-runtime.integration.test.ts` `accepts explicit DJ preference and mood commands without ordinary memory or provider calls` | `src/test/radio-dj-product-acceptance.contract.test.ts`의 PA-DJ-01/02 named tests + `src/test/radio-dj-preference-index.test.ts` `orders same-time updates by persisted sequence`, `keeps exact latest state when semantic tombstones are absent from top-K`, `recovers every index and memory outbox failure boundary` |
| PA-DJ-03·06 | `src/test/personal-radio-dj.contract.test.ts`의 PA-DJ-03/06 named virtual-session tests | 같은 파일의 DJ-02/03/04 grounding, DJ-05/06 controls, DJ-07 lease 및 race tests |
| PA-DJ-04 | native `packages/shell/e2e-tauri/specs/71-proactive-speech-profiles.spec.ts` `persists validated proactive settings after cache-clear native reload` | shell pure/RTL tests `normalizes proactive settings fail-closed` / `edits and persists proactive speech settings` |
| PA-DJ-05A·05B | Playwright `121-proactive-speech-product-acceptance.spec.ts`의 `speaks proactive text through browser TTS`, `plays synthesized proactive audio`, `interrupts before every DJ control and drops stale output` | `packages/shell/src/lib/__tests__/speech-profile-commands.test.ts` `maps every closed DJ control without intercepting ordinary chat` |
| PA-EX-01·02 | agent integration `PA-EX-01/02 routes a yielded question to grounded KB with memory and transcript off` + Playwright `ordinary chat interrupts before yielding the active exhibition` | agent exhibition contract의 grounding/yield/resume/privacy/race tests |

개발 순서는 `계약 → UC → UC 테스트(RED) → 기능(FE) → 기능 테스트(RED) → 구현 → GREEN → 실제 UI/E2E`다.
각 문서·개발·테스트·통합 단계는 적대 리뷰 **2회 연속 CLEAN** 전에는 다음 단계로 넘기지 않는다.
물리 스피커의 주관적 음질은 자동 합격으로 위장하지 않으며, 자동 수용 범위는 각 TTS 경로의 합성 호출·audio play 시작·
끼어들기 시 cancel/stale 폐기까지다.

REQ-013과 P05의 위 제품 수용 범위는 GREEN이다. 물리 스피커의 주관적 음질·현장 선호도는 자동화
범위 밖이며, 코드 완료 판정과 분리해 운영 관찰 항목으로 남긴다.
