# UC1 agent(brain) 수평 계약 — ingress→conv→provider→egress (2026-06-10)

> brain 반쪽. 진실=UC1 시나리오(os 와 공유). **wire 경계(H-agent) = 이미 고정**(`agent-vertical-anchor-2026-06-10.md` §0): ingress 는 `AgentOutbound`(os 송신) 수용, egress 는 `AgentMessage`(os 분류) 방출 — os probe 양방향 게이트. 레이어 규칙=헥사고날(os STRUCTURE 동일). grounding=old-naia-os/agent 실코드.

---

## §A. Old-Baseline (old-naia-os/agent 실코드 흐름)
| 단계 | 소스 | 거동 |
|---|---|---|
| 수신 | `index.ts:1224 readline.on(line)`→`protocol.ts:238 parseRequest`(type 화이트리스트, 관대) | stdin JSON-line → `AgentRequest` |
| 분기 | `chat_request`→`:381 handleChatRequest` / cancel_stream·approval_response·creds_update→각 핸들러 | type 별 |
| 조립 | `system-prompt.ts` + `conversation/`(token-budget) + providerConfig(`enableThinking` top-level 주입) | 메시지+persona+budget |
| 추론 | `:~560 provider.chat(messages)` = `AgentStream`(AsyncGenerator<StreamChunk>) | LLM 스트림 |
| 방출 | `:602 for await chunk`→`writeLine({type,requestId,...})` | provider StreamChunk→wire AgentMessage |
| 제어 | `controller.signal.aborted`(cancel) · approval await · creds | shell→agent 반환경로 |
| DTO | provider `StreamChunk`(text·thinking·tool_use·usage·finish·audio) → wire(text·thinking·tool_use{toolCallId,toolName}·finish·error·usage·log_entry·…) | 매핑 |
| 추상화 | **없음** — index.ts 가 readline·provider·writeLine 직결(거대 함수) |

**판정**: 흐름·DTO=**이식**(old-auth). ingress/egress/provider/conv 포트 분리=**보충**.

---

## §B. 포트 계약

### B.1 domain/ (순수, import 0)
| 값객체 | 규칙 |
|---|---|
| `ChatRequest` | parseRequest 결과의 domain 형(requestId, provider:ProviderConfig, messages, systemPrompt?, enableTools?, **enableThinking?**(top-level), gatewayUrl?, disabledSkills?). wire `AgentOutbound.chat_request` 와 동형(os 측 정합). |
| `ProviderChunk` | provider-중립 스트림 단위 = `text|thinking|toolUse{id,name,args}|usage{in,out}|finish|audio{data}`(=old StreamChunk). LLM 출력 추상. |
| `AgentEmit` | egress 가 wire 로 내보낼 domain chunk = chat-turn AgentMessage 의 domain 표현(text·thinking·toolUse{toolCallId,toolName}·toolResult·finish·error·usage·logEntry·tokenWarning·audio). **권위=os AgentMessage 분류(공유)**. |
| `ChatTurn` | requestId 턴 상태기계: `streaming →(abort)→ cancelling → finish/error(terminal)`. provider 중립. |
| `mapProviderChunk(ProviderChunk): AgentEmit` | 순수 매핑(tool_use id→toolCallId,name→toolName; usage 누적; audio 통과). os 의 domain↔protocol 매핑과 대칭. |

### B.2 ports/
```
# driven (brain 이 의존)
ProviderPort:                         # LLM 추론 (이식 소스 providers/)
    chat(config, messages, opts): AsyncIterable<ProviderChunk>   # 스트림. abort signal 수용. rejection 전파
ConversationPort:                     # 대화조립 (conversation/ + system-prompt)
    assemble(req): { messages, systemPrompt }   # token-budget 적용. 순수에 가까움(이식 시 I/O 분리)
# driving-in (wire→brain)
AgentIngressPort:                     # stdin wire → AgentRequest (= H-agent 경계 agent측)
    onRequest(cb): Unsub              # parseRequest. AgentOutbound 전 variant 수용(미지=무시+log, silent drop 금지)
# driven-out (brain→wire)
AgentEgressPort:                      # AgentEmit → wire AgentMessage writeLine (= H-agent egress)
    emit(requestId, emit: AgentEmit): void   # requestId 결속. flat JSON-line
ControlPort:                          # cancel/approval/creds (chat_request 외 inbound)
    onCancel(cb)/onApproval(cb)/onCreds(cb)
```
> ⚠️ god-port 금지: provider/conversation/skill 독립. ingress 가 모든 inbound 받아 type 별 라우팅(os MessageRouter 대칭 — 단일 구독).

### B.3 app/
```
ChatTurnHandler (UC1 오케스트레이션):
  on chat_request → ConversationPort.assemble → ProviderPort.chat(stream)
    → for await chunk: AgentEgressPort.emit(requestId, mapProviderChunk(chunk))
    → ChatTurn 상태기계(streaming→finish/error 종결). cancel=abort→cancelling.
  # wire encode/decode 안 봄(adapter). provider 선택만 domain.
```

### B.4 adapters/
| 어댑터 | 포트 | 구현 |
|---|---|---|
| `StdioIngressAdapter` | AgentIngressPort | stdin readline→parseRequest→AgentRequest. (os StdioTransportAdapter 의 짝) |
| `StdioEgressAdapter` | AgentEgressPort | AgentEmit→wire JSON-line→stdout. flat newline JSON(os decodeAgentMessage 와 정합) |
| `OllamaProvider`/`OpenAIProvider`/`VllmProvider` | ProviderPort | 이식 소스 providers/. **fake provider(헤드리스 trace용)** = 카논 응답 에코 |
| `BudgetConversation` | ConversationPort | conversation/token-budget + system-prompt 조립 |

### B.5 composition/ — 단일 root. ingress+handler+provider+egress 주입. fake provider 주입 = 헤드리스.

### B.6 검증
- **계약 테스트**: fake ProviderPort(스트림 emit) → ChatTurnHandler → egress 캡처 = AgentEmit 순서·ChatTurn 종결·mapProviderChunk 정확(tool_use id→toolCallId).
- **wire 등가(공유 게이트)**: os `uc1-outbound-probe`(os outbound ⊆ 이 ingress 수용) + `uc1-variant-probe`(이 egress 출력 ⊆ os 분류). 재사용 — 양방향.
- **수직 결선**: os `uc1-trace-harness` AGENT_CMD=new-naia-agent 빌드본 → 1턴 end-to-end(fake provider).

## B.7 다음
2-clean 리뷰 → 코드 스캐폴드(src/main domain/ports/app/adapters) → 계약테스트 → 수직 결선.
