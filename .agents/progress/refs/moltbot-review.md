# ref-moltbot review — 2026-04-25

**Source**: https://github.com/openclaw/openclaw (commit f29e15c05d)  
**Updated from**: prior review at commit 94e2bf258d

## 0. 이전 리뷰 대비 변동

**변동 없음 (핵심 설계)**. 이전 리뷰의 결론 유지: OpenClaw는 여전히 채널-무관 라우팅 & plugin SDK 기반의 대규모 멀티채널 gateway. 최신 커밋들(f29e15c05d)은 주로 manifest 기반 metadata 읽기 최적화, message-tool discovery 개선, streaming 및 threading 어댑터 세분화에 집중. 우리의 경량 4-repo 설계와의 미스매치는 그대로.

다만 **plugin SDK의 계약이 진화**: `ChannelCrossContextComponentsFactory` → `ChannelCrossContextPresentationFactory` (구조화된 컴포넌트 → `MessagePresentation` 타입), `ChannelThreadingAdapter`에 `resolveCurrentChannelId()` 추가, `ChannelMessagingAdapter`에 heartbeat thread 보존 옵션 추가 등 세부 개선. 우리 shell messenger layer는 이런 진화를 참고할 가치 있음.

## 1. 무엇인가 / 무엇이 아닌가

OpenClaw는 **채널-agnostic AI 에이전트 런타임**. 20+ 메시징 플랫폼(Discord, Telegram, Slack, WhatsApp, Signal, iMessage, Matrix, Feishu, WeChat 등)을 단일 에이전트에 통합하는 gateway. 플러그인 SDK를 통해 커뮤니티가 새로운 채널을 추가할 수 있도록 설계됨. 약 117개 extension + 999K LOC 규모.

**아닌 것**: 우리 naia-agent처럼 경량의 단일 에이전트 임베드 런타임이 아님. Web gateway(Express 기반), onboarding UI, 복잡한 approval workflow, provider plugin ecosystem(100+) 포함. 이들은 우리 설계와 정면 충돌.

## 2. 차용 가능한 패턴 후보

**ChannelPlugin 인터페이스 진화** (`src/channels/plugins/types.plugin.ts`, `types.core.ts`):
- 각 메시징 플랫폼을 uniform `ChannelPlugin<ResolvedAccount>` 타입으로 추상화
- `messaging?: ChannelMessagingAdapter` (최신 추가): 메시지 포맷/스트리밍/쓰레딩 처리
- `outbound?: ChannelOutboundAdapter`: 응답 송신 (현재 `ChannelOutboundChunkContext` export 추가로 스트리밍 강화)
- `config`, `security`, `groups`, `gateway` 등 선택적 adapter로 기능 모듈화

**Manifest 기반 metadata 읽기** (`src/plugins/bundle-manifest.ts` 등):
- 런타임에 전체 plugin 로드 없이 channel catalog/discovery용 메타 정보만 추출
- 우리 4-repo의 "skill registry" 패턴과 유사

**Thread/session binding 개선** (최신 `ChannelThreadingAdapter.resolveCurrentChannelId()`, heartbeat preservation):
- 메시징 플랫폼의 thread/topic 개념을 session context에 연결
- naia-agent의 session isolation & channel routing 설계 시 참고 가치

## 3. 명시적으로 채택 안 할 이유

1. **스케일 미스매치**: 999K LOC vs. naia-agent의 경량 목표. OpenClaw의 approval flow, config migration, doctor 명령어는 다중 사용자 협업 gateway용.

2. **Gateway server overhead**: Express + WebSocket + control plane. naia-agent는 stdio/메모리 기반 임베드만 필요.

3. **Provider plugin complexity**: anthropic, openai, gemini 등 100+ provider를 관리하는 infrastructure. naia-agent는 LLMClient interface 1개만 요구.

4. **Skill 라이브러리**: OpenClaw의 skills/는 각각 독립 npm package (notion, github, slack 등). naia-adk/skill-spec는 경량 YAML 마크업 기반. 근본 차이.

## 4. 이미 우리에 반영된 부분

- **Plugin SDK 계약**: naia-agent의 `@nextain/agent-types` (ToolExecutor, LLMClient, SkillManifest) ≈ OpenClaw의 `openclaw/plugin-sdk/*`
- **메시징 추상화**: naia-os의 `HostContext.messenger` interface로 Discord/Telegram/Voice 통합 (naia-agent는 이에 의존)
- **Session routing**: naia-agent의 session-key 개념은 OpenClaw의 conversation-binding-context와 유사 선호도 기반 routing

## 5. R0 채택/거부/이연 권고

- **채택**: `ChannelMessagingAdapter` 패턴 (특히 heartbeat thread preservation, cross-context presentation) — naia-os shell layer 리팩토링 시 참고
- **거부**: 전체 skill library, provider plugins, gateway server, approval infrastructure
- **이연**: Thread-level session isolation 고급 패턴은 Phase B 이후 고려 (현재 naia-agent의 session context 설계로 충분)

## 6. 열린 질문

1. naia-os의 discord/telegram 메시징 구현이 OpenClaw의 `ChannelMessagingAdapter` 수준으로 세분화되어 있는가? (예: cross-channel heartbeat thread preservation)
2. naia-agent의 "turn" 단위가 OpenClaw의 conversation-binding의 message-batching과 동등한 개념인가, 아니면 더 단순한 single-message 회차인가?
3. shell에서 outbound streaming (chunks)을 지원할 필요가 있는가, 아니면 final reply만으로 충분한가?
