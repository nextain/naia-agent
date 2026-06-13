# new-naia-agent 아키텍처 — brain 반쪽 (온보딩)

> agent 는 os→agent→adk 의 **뇌/처리**다. 전체 사상(직교 2축·인지 계층·UC 추가 레시피)의 SoT 는
> `new-naia-os/docs/ARCHITECTURE.md`. 이 문서는 agent(brain) 측 구체만 다룬다.

## 1. 위치

```
new-naia-os(UI) ──gRPC──> [ new-naia-agent ] ──저장/불러오기──> naia-adk(settings SoT)
```
- 셸이 spawn → agent 가 stdout 에 `GRPC_LISTENING <addr>` 출력 → 셸 tonic 클라가 connect.
- agent 는 `SetWorkspace(adkPath)` 로 naia-adk settings 로딩 → provider/model 구성. 키는 OS 키체인(평문 금지).
- 대화 = `Chat(server-stream)`. 셸은 메시지만, agent 가 recall→provider→save→스트림.

## 2. 인지 계층

- **입력층** `ports/uc1.ts AgentIngressPort` — transport-neutral 수신(gRPC 서버가 여기로).
- **처리** `app/chat-turn-handler.ts` — recall(memory.recall)→systemPrompt 주입→provider 라운드(도구 루프)→save(memory.save)→finish.
- **출력층** `AgentEgressPort` — AgentEvent(text/thinking/toolUse/usage/finish/…) emit.
- transport 어댑터: `adapters/grpc/`(production) + `adapters/stdio.ts`(테스트 in-process). 둘 다 같은 Ingress/Egress 포트 구현 = 직교.

## 3. 헥사고날 레이어

| 레이어 | 예 |
|---|---|
| `domain/` | chat.ts(계약 union, os 와 1:1), memory.ts, cost.ts, provider-route.ts |
| `app/` | chat-turn-handler.ts |
| `ports/` | uc1.ts, memory.ts |
| `adapters/` | grpc/, naia-memory.ts, naia-settings-store.ts, keychain-secret-store.ts, *-provider.ts, *-skills.ts, workspace-project.ts |
| `composition/` | index.ts |

## 4. wire 계약 (H-agent)

- 수신 union = os `AgentOutbound`(chat_request|cancel_stream|approval_response|creds_update)와 1:1.
- 송신 union = os chat-turn `AgentMessage`. proto SoT = `src/main/adapters/grpc/naia_agent.proto`.
- ⚠️ os/agent `domain/chat.ts` 가 손-중복(1:1 주석 단언). 동기 강제 = wire probe(os 측, CI). proto cross-repo 해시 일치는 follow-up(공유 패키지 결정 후).

## 5. 흔들림 방지 (CI 게이트)
`check-compile-integrity`(tsc) · `check-logging`(DiagnosticLog 강제) · `check-file-anchors`(`module-manifest.json` 32 파일 {layer,uc,contract}) · vitest(`src/test/uc*.contract/integration.test.ts`) — 전부 `.github/workflows/self-trust-gates.yml` `code-gates` job 에서 자동실행. PreToolUse 훅(file-anchor-guard)은 인터랙티브 세션 1차 방어.

## 6. 새 UC = os/docs/ARCHITECTURE.md §6 레시피 따름
agent 반쪽: 포트(`ports/`) → 도메인(`domain/`) → 어댑터(`adapters/`) → 와이어(`composition/`) → file-anchor 등록(`module-manifest.json`) → 계약 테스트(`src/test/`). wire 변경 시 proto + union 동시.
