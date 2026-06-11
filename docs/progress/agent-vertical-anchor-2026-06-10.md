# naia-agent 수직 앵커 — os 매트릭스 미러 (brain 측) (2026-06-10)

> **목적**: new-naia-os 가 정한 **수직(UC1~14) × 수평(포트 canon)** 앵커를 naia-agent(brain)에 *맞춤*. drift/드롭 방지 anchor 를 두 repo 가 공유.
> **교차개발 앵커 원칙(루크)**: os 와 agent 는 *같은 UC 시나리오의 두 반쪽*. UC1(os) ⟂ UC1(agent) = 한 시나리오. 둘을 잇는 **H-agent 경계 = wire 계약**(이미 os 측에서 고정·probe 검증) → agent 는 이 wire 에 *conform*.
> 이식 소스 = `old-naia-os/agent/src` (frozen). 절대기준 = 시나리오→계약→코드 격리 + 2-clean 교차리뷰 + 결정론 게이트(os 와 동일).

---

## §0. 공유 경계 (H-agent) — 이미 고정된 앵커 ⚓
os 측에서 **wire 계약이 이미 2-clean 확정**됨(`new-naia-os/docs/progress/UC1-horizontal-contract-2026-06-10.md`):
- **shell→agent (agent 입장 = ingress)**: `AgentOutbound` 폐쇄 union = `chat_request | cancel_stream | approval_response | creds_update`(전부 stdin JSON-line, agent readline 이 type 분기).
- **agent→shell (agent 입장 = egress)**: `AgentMessage` = Known(chat-turn 11 + nonchat-known 19) | Unknown. agent writeLine 출력이 권위(superset).
- **검증(이미 존재, 데몬 무실행)**: `new-naia-os/scripts/builds/uc1-outbound-probe.mjs`(os outbound ⊆ agent parseRequest 수용) + `uc1-variant-probe.mjs`(agent 출력 ⊆ os 분류). 둘 다 PASS.
→ **agent 이식은 이 wire 를 깨면 안 됨**(probe 가 양방향 게이트). 이게 교차개발 앵커의 실체 = agent 가 자유롭게 재설계해도 *경계 계약은 불변*.

---

## §1. 수직 UC 축 — os 와 동일 (한 시나리오의 brain 반쪽)
| UC | os 측(shell/core) 주포트 | **agent 측(brain) 책임** | slice |
|---|---|---|---|
| **UC1** 텍스트대화 | Chat→agent→Express | **chat_request 수신→대화조립→provider 추론→agent_response 스트림** | **활성(이식)** |
| UC2 음성대화 | Sensory→…→Express(avatar) | STT 입력 수용 + provider + **TTS egress**(tts/) | pending |
| UC3 기억대화 | Chat+memory | **장기기억 주입/회수**(naia-memory 연동) | pending |
| UC4 능동회상 | memory+temporal | **cron/tasks 기반 능동 spike** | pending |
| UC5 도구사용 | ToolPort+Environment | **skills(20+) + gateway 도구 실행** | pending |
| UC6 환경조작-브라우저 | EnvironmentPort | (gateway native exec) | pending |
| UC7/7a 시스템 관측·조작 | EnvironmentPort | (gateway native exec + reafference) | pending |
| UC9 패널앱 | EnvironmentPort(app-surface) | **panel skills**(panel_* egress) | pending |
| UC10 멀티채널 | 채널 ingress | **discord/slack/gchat webhook**(notify) | pending |
| UC11 자기상태 | InteroceptivePort | (상태 보고 egress) | pending |
| UC2~14 기타 | (os 매트릭스 참조) | (해당 brain 모듈) | pending |
> 수직축 권위 = `new-naia-os/docs/progress/assembly-matrix-2026-06-10.md`. 신규 UC 추가 시 *양 repo 동시* 갱신(앵커 동기).

---

## §2. 수평 포트 canon (brain) — agent 모듈 → 포트
> os 의 수평(H-proto/H-tx/H-chat/…)에 대응하는 **brain 측 인지/런타임 포트**. 이식 소스 모듈 명시.
| # | 포트 | 역할 | 이식 소스(old agent) | 이식/보충 |
|---|---|---|---|---|
| **A-ingress** | `AgentIngressPort` | stdin wire→`AgentRequest` 디코드·type 분기(=H-agent 경계 agent측) | `protocol.ts parseRequest` + `index.ts readline(1224)` | 이식 |
| **A-egress** | `AgentEgressPort` | domain chunk→wire `AgentMessage` writeLine(=H-agent egress) | `index.ts writeLine(268)` | 이식 |
| **A-provider** | `ProviderPort` | LLM 추론(chat 스트리밍) | `providers/`(factory·ollama·openai·registry) | 이식 |
| **A-conv** | `ConversationPort` | 대화조립·시스템프롬프트·token budget(작업기억) | `conversation/`·`system-prompt.ts` | 이식 |
| **A-skill** | `SkillPort` | 내장 스킬/툴 실행(=os ToolPort 짝) | `skills/` | 이식 |
| **A-gateway** | `GatewayPort` | gateway 도구·native exec·billing | `gateway/` | 이식 |
| **A-mcp** | `McpPort` | MCP 연결 | `mcp/` | 이식 |
| **A-tts** | `TtsPort` | 음성합성(표현 egress, =os Express 짝) | `tts/` | 이식(UC2) |
| **A-memory** | `MemoryPort` | 장기기억(naia-memory 연동·scrub) | `memory-scrubber.ts`·local-sessions | 이식+보충(UC3) |
| **A-cron** | `CronPort` | temporal 스케줄·능동 작업 | `cron/`·`tasks/` | 이식(UC4) |
| **A-approval** | `ApprovalPort` | 승인 게이트(agent측, =os ApprovalPort 짝) | `approval-bridge.ts` | 이식 |
> ⚠️ os 처럼 god-port 금지 — 각 포트 독립. provider/conversation/skill 이 한 facade 로 뭉치지 않음.

---

## §3. UC1 agent측 상세 (활성 — 첫 수직 슬라이스)
chat_request 1턴의 brain 파이프라인(이식, old-auth 흐름):
```
A-ingress.receive(stdin line)→parseRequest→ChatRequest(domain)
  → A-conv.assemble(messages + systemPrompt + token budget)
  → A-provider.chat(providerConfig, messages) → stream chunks
  → A-egress.emit(text/thinking/tool_use/tool_result/finish/error/usage/log_entry/token_warning)  // = AgentMessage chat-turn
제어: cancel_stream→A-provider abort / approval_response→A-approval resolve / creds_update→provider 자격
```
- **wire 불변**(§0): ingress 는 `AgentOutbound`(os가 보내는 것) 수용, egress 는 `AgentMessage`(os가 분류하는 것) 방출. probe 양방향 게이트.
- **provider 등가**: `enableThinking` top-level 읽어 providerConfig 주입(os outbound 가 top-level 로 보냄 — 이미 정합). routeViaGateway=intentionally-disabled.
- **이식 판정**: 흐름·DTO=이식(old-auth). 헥사고날 추상화(포트 분리)=보충.

---

## §4. 다음 (method-parity 단계 — os 와 동일 SDLC)
1. **P01** agent user-scenarios(UC1 brain 시각) → 2. **P02** test coverage map → 3. **P03** requirements → 4. UC1 agent 수평 계약(ingress/egress/provider/conv 포트, 2-clean) → 5. domain/ports/app/adapters 코드 + 계약테스트 → 6. **수직 결선**: new-naia-os child-stdio transport ↔ new-naia-agent ingress/egress(헤드리스 trace, fake LLM provider 로 1턴).
- 결선 = os `uc1-trace-harness` 의 `AGENT_CMD` 를 **new-naia-agent**(빌드본)로 지정 → 양 repo 가 한 wire 로 end-to-end.
- 절대기준: 각 단계 codex 2-clean + 결정론 게이트(probe 재사용). 앵커(이 문서) 이탈 시 멈춤.

---
## ✅ 수직 결선 성공 (2026-06-10) — 두 repo end-to-end
os `uc1-trace-harness` 의 `AGENT_CMD=node ../new-naia-agent/scripts/builds/agent-stdio-entry.mjs` 로
**new-naia-os(child-stdio transport) ↔ new-naia-agent(ingress→handler→provider(fake)→egress)** 를 *실 process stdio* 로 연결.
1턴 결과: `rendered=[text,usage,finish], ownerReleased=true, ✅ PASS exit 0`.
→ 독립 빌드·독립 2-clean 두 repo 가 공유 wire(AgentOutbound↔AgentMessage)로 정합. **fake LLM provider 만 실 provider(ollama 이식)로 교체하면 실 채팅 경로**. 헤드리스(GPU·앱 무접촉).

---
## 🎉🎉 실 LLM end-to-end 성공 (2026-06-10) — 진짜 채팅
GPU1 naia-omni 정지(루크 승인) → host ollama(GPU1) gemma4:e4b-it-q8_0 → **shell-compat → os core → 실 new-naia-agent(AGENT_PROVIDER=ollama) → 실 gemma4** 1턴:
- 입력 "한국어로 자기소개" → 한국어 474자 스트리밍 응답, usage(i28/o791), 12.2s, exit 0. **fake 아님 = 실 LLM 추론.**
- naia-admin(GPU0) 무접촉 보존. naia-omni(GPU1)=정지 상태(루크 것, 복원은 루크 관리).
→ 이식 UC1 수직(육체 os + 뇌 agent + 실 provider)이 **진짜 채팅을 낸다**. 남은 건 라이브 Tauri 앱 결선(B0 import 교체 + B3)뿐.

## 🎉 실 LLM 2종 PASS (2026-06-10) — 로컬 + 클라우드
- **ollama gemma4**(로컬 GPU, ollama-provider, 2-clean) — 한국어 474자 스트리밍.
- **GLM z.ai coding**(클라우드, openai-compat-provider, 2-clean, GPU 0, data-private GLM_KEY) — 한국어 응답.
→ 같은 ProviderPort 인터페이스로 로컬/클라우드 LLM 교체 가능(AGENT_PROVIDER=ollama|glm). naia-omni 는 GPU1 복원 완료(LLM 테스트는 GLM 으로 GPU 무경합).
