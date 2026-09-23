# naia-agent 아키텍처 — brain 반쪽 (온보딩)

> agent 는 os→agent→adk 의 **뇌/처리**다. 전체 사상(직교 2축·인지 계층·UC 추가 레시피)의 SoT 는
> [naia-os](https://github.com/nextain/naia-os) 측 `docs/ARCHITECTURE.md`. 이 문서는 agent(brain) 측 구체만 다룬다.

## 1. 위치

```
naia-os(UI) ──gRPC──> [ naia-agent ] ──저장/불러오기──> naia-adk(settings SoT)
```
- 셸이 spawn → agent 가 stdout 에 `GRPC_LISTENING <addr>` 출력 → 셸 tonic 클라가 connect.
- agent 는 `SetWorkspace(adkPath)` 로 naia-adk settings 로딩 → provider/model 구성. 키는 OS 키체인(평문 금지).
- 대화 = `Chat(server-stream)`. 셸은 메시지만, agent 가 recall→provider→save→스트림.

## 2. 인지 계층

- **입력층** `ports/uc1.ts AgentIngressPort` — transport-neutral 수신(gRPC 서버가 여기로).
- **처리** `app/chat-turn-handler.ts` — recall(memory.recall)→systemPrompt 주입→provider 라운드(도구 루프)→save(memory.save)→finish.
- **출력층** `AgentEgressPort` — AgentEvent(text/thinking/toolUse/usage/finish/…) emit.
- transport 어댑터: `adapters/grpc/`(production) + `adapters/stdio.ts`(테스트 in-process). 둘 다 같은 Ingress/Egress 포트 구현 = 직교.

### 떠오름(#692, #693)
작은 LLM(memory 역할) 또는 유사도 임계치 기반으로 연관성이 높은 기억을 다음 턴의 프롬프트로 선별·준비하고, 능동적 기억 회상 도구(`skill_memory_recall`)를 제공한다.
- 3가지 동작 모드: `on-llm`(작은 LLM 비동기 선별 + 미판단 임계치 게이트), `on-threshold`(작은 LLM 없이 코사인 유사도 임계치 0.86 게이트 + 단순발화 필터), `off`(자동 기억 주입 완전 생략).
- `domain/surfacing.ts`: 순수 도메인 로직(후보군 추출·프롬프트 조립·응답 파싱·블록 렌더링·판정 후보 필터링·자격 판정 `decideSurfacing`, 임계치 계산 및 trivial 검사 `isTrivialMemoryText`, 임계치 필터 `thresholdJudge`/`selectRecallByThreshold`).
- `ports/surfacing.ts`: `SurfacingPort`(consume/schedule/mode/policy/active/close) 및 스냅샷·임계치 정책 계약 정의.
- `app/memory-surfacer.ts`: 비동기 스케줄러, 타임아웃(8s)·TTL(15m) 관리, 모델 부재 시 백오프(10m), 후보 취합 및 작은 LLM 호출 오케스트레이션 (`on-llm` 모드에서만 동작, `touch: false` 회상).
- `adapters/memory-skill.ts`: 능동적 장기기억 회상 도구 `skill_memory_recall` 구현 (읽기 전용, `touch: false`, 비밀 마스킹, JSON 출력 규격).
- 합성 배선(`scripts/builds/compose-agent-deps.mjs`, `composition/index.ts` `wireAgentUC1`): memory 및 knowledge backend와 연동하여 surfacer 인스턴스를 주입하고 `skill_memory_recall` 실행기를 배선한다. `chat-turn-handler.ts`는 턴 시작 시 모드별 기억을 주입(임계치 적용 시 수치 통계 기록)하고, Discord/processing 요청 시 메모리 도구 및 정책을 안전하게 제외하며 unadvertised 도구 호출을 가드한다.

## 3. 헥사고날 레이어

| 레이어 | 예 |
|---|---|
| `domain/` | chat.ts(계약 union, os 와 1:1), memory.ts, cost.ts, provider-route.ts, surfacing.ts |
| `app/` | chat-turn-handler.ts, memory-surfacer.ts |
| `ports/` | uc1.ts, memory.ts, surfacing.ts |
| `adapters/` | grpc/, naia-memory.ts, naia-settings-store.ts, keychain-secret-store.ts, *-provider.ts, *-skills.ts, workspace-project.ts |
| `composition/` | index.ts |

## 4. wire 계약 (H-agent)

- 수신 union = os `AgentOutbound`(chat_request|cancel_stream|approval_response|creds_update)와 1:1.
- 송신 union = os chat-turn `AgentMessage`. proto SoT = `src/main/adapters/grpc/naia_agent.proto`.
- ⚠️ os/agent `domain/chat.ts` 가 손-중복(1:1 주석 단언). 동기 강제 = wire probe(os 측, CI). proto cross-repo 해시 일치는 follow-up(공유 패키지 결정 후).

## 5. 흔들림 방지 (CI 게이트)
`check-compile-integrity`(tsc) · `check-logging`(DiagnosticLog 강제) · `check-file-anchors`(`module-manifest.json` — `src/main` 의 모든 `.ts` 가 {layer,uc,contract} 앵커와 1:1 등록) · vitest(`src/test/uc*.contract/integration.test.ts`) — 전부 `.github/workflows/self-trust-gates.yml` `code-gates` job 에서 자동실행. PreToolUse 훅(file-anchor-guard)은 인터랙티브 세션 1차 방어.

## 6. 새 UC = os/docs/ARCHITECTURE.md §6 레시피 따름
agent 반쪽: 포트(`ports/`) → 도메인(`domain/`) → 어댑터(`adapters/`) → 와이어(`composition/`) → file-anchor 등록(`module-manifest.json`) → 계약 테스트(`src/test/`). wire 변경 시 proto + union 동시.
