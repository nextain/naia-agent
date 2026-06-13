# channels/discord (UC6 facet — 다채널 수신/발신) — Old-Baseline + 신규계약 (2026-06-13)

session_id: ec74cc29-3347-4f6e-b29a-237ea29f301e

> GOAL ⑥(신규 계약으로 흔들리지 않게). channels = old **gateway daemon(channels-proxy)** 의존 — #201 로 openclaw gateway 제거됨.
> ∴ 이식(死) 불가 → **새 capability(신규계약)**. Old-Baseline(기능) + 새 아키텍처 옵션 + 계약을 박되, **always-on daemon 위치 결정은 루크**(추측 빌드 금지).

## §A. Old-Baseline (기능, old channels.ts/naia-discord.ts)
- **channels skill**: gateway.request 프록시 — `channels.status`(채널 목록/라벨/순서), 발신, 수신(세션). ctx.gateway.isConnected 게이트.
- **naia-discord**: gateway.request("sessions.list"/"channels.status") — discord DM 채널 발견 + proactive send + emotion→emoji. allowlist(silent ignore).
- = 실제 채널 연결(discord 봇/slack 이벤트)은 **old gateway daemon(always-on)** 이 보유. skill 은 프록시일 뿐.

## §B. 새 아키텍처 결정 필요 (루크 — 추측 금지)
openclaw gateway 제거 후 "always-on 채널 수신(discord 봇 connection·slack events)" 이 새 os↔agent-gRPC 아키텍처 어디에 사는가:
- **옵션1 agent 내 always-on listener**: agent 가 채널 봇 연결 유지(agent=daemon 역). 단 agent 생명주기(os 가 spawn)와 always-on 충돌 가능.
- **옵션2 별도 channel service(daemon)**: 독립 프로세스 + gRPC(agent↔channel). naia-model-infra/serve 와 유사 패턴.
- **옵션3 os shell daemon**: os 가 채널 연결 보유, agent 에 gRPC 로 push.
> 각 옵션은 substrate-agnostic(안드로이드 대비) + privacy(로컬 우선, GOAL) 트레이드오프 상이. **결정 = 루크.**

## §C. 신규 계약 (포트 — 아키텍처 결정 후 구현)
```
ChannelInboundPort (수신 — daemon→agent):  subscribe(onMessage: {channel, user, text, ts}): Unsubscribe
ChannelOutboundPort (발신 — agent→daemon): send(channel, text): Result | Unsupported   # notify skill 이 부분 충족(webhook 발신)
ChannelStatusPort: list(): ChannelInfo[]   # old channels.status
```
- **발신(send)** 일부는 **notify skill(이식됨, slack/discord/google_chat webhook)** 이 이미 충족 — 단순 발신은 notify 로.
- **수신(inbound)** = always-on 연결 = 위 아키텍처 결정 + daemon 신규 구현 필요(이식 아님).
- tier: 채널 발신=ask(외부), 수신=관측.

## §D. 결론
- **발신**: notify skill(이식 완료)로 기본 충족.
- **수신/봇/full 채널**: 새 always-on daemon = **아키텍처 결정(루크) → 신규 구현**. 이식 아님(old gateway 死). 추측 빌드=드리프트 금지.
- = channels "개발" = (1) 발신=notify 완료 (2) 수신=신규계약 스펙 박음(이 문서) + 아키텍처 결정 대기. "흔들리지 않게" 상태.
