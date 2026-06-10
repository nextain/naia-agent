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
| `AgentRequest` | inbound domain 폐쇄 union = `ChatRequest | CancelRequest{requestId} | ApprovalResponse{requestId,toolCallId,decision} | CredsUpdate{provider,secret}`. **os `AgentOutbound` 와 1:1**(ingress 가 wire→이 union 디코드). |
| `ChatRequest` | requestId, provider:ProviderConfig, messages, systemPrompt?, enableTools?, **enableThinking?**(top-level), gatewayUrl?, disabledSkills?. wire `AgentOutbound.chat_request` 와 동형(os 정합). |
| `ProviderChunk` | provider-중립 *도메인 정규화* 스트림 단위 = `text|thinking|toolUse{id,name,args}|usage{in,out}|finish`. ⚠️ old `StreamChunk`(raw, snake `tool_use`)와 *별 레이어* — **provider 어댑터가 raw→ProviderChunk 정규화**(camel). audio=UC2 범위라 UC1 제외. **error variant 없음 — provider 실패=rejection(throw)**, handler catch 가 AgentEmit error 생성(mapProviderChunk 는 error 안 만듦). |
| `AgentEmit` | egress 가 wire 로 내보낼 chat-turn domain chunk = os chat-turn AgentMessage 의 domain 표현(폐쇄): `text·thinking·toolUse{toolCallId,toolName}·toolResult·approvalRequest·gatewayApprovalRequest·finish·error·usage·logEntry·tokenWarning`. **권위=os AgentMessage chat-turn 분류(공유, audio 제외=nonchat/UC2)**. `error`=handler 가 provider rejection catch 시 생성(ProviderChunk 매핑 아님). |
| `ChatTurn` | requestId 턴 상태기계. 상태=`streaming|cancelling|finished|errored`(terminal=finished,errored). **정상: streaming→finished(provider finish chunk) / →errored(error chunk)**. **취소: streaming→(abort)→cancelling→finished/errored**. **provider 예외/무-terminal EOF: →errored**. provider 중립·순수. |
| `mapProviderChunk(ProviderChunk): AgentEmit` | **1:1 순수 매핑**(toolUse id→toolCallId, name→toolName). ⚠️ usage *누적은 여기 아님* — ChatTurnHandler 상태(B.3). os domain↔protocol 매핑과 대칭. |

### B.2 ports/
```
# driven (brain 이 의존)
ProviderPort:                         # LLM 추론 (이식 소스 providers/)
    chat(config, messages, opts): AsyncIterable<ProviderChunk>   # 스트림. abort signal 수용. rejection 전파
ConversationPort:                     # 대화조립 (conversation/ + system-prompt)
    assemble(req): { messages, systemPrompt }   # token-budget 적용. 순수에 가까움(이식 시 I/O 분리)
# driving-in (wire→brain) — ⚠️ **단일 구독자**(os MessageRouter 대칭): 모든 inbound 한 곳, type 별 라우팅
AgentIngressPort:                     # stdin wire → AgentRequest (= H-agent 경계 agent측)
    onRequest(cb): Unsub              # parseRequest 후 *전 AgentOutbound variant*(chat_request·cancel_stream·approval_response·creds_update) 단일 cb 로. router 가 type 분기→해당 app 핸들러. 미지=무시+log(silent drop 금지)
# driven-out (brain→wire)
AgentEgressPort:                      # AgentEmit → wire AgentMessage writeLine (= H-agent egress)
    emit(requestId, emit: AgentEmit): void   # requestId 결속. flat JSON-line
# control = app 핸들러 인터페이스(별도 stdin 구독 아님 — ingress router 가 호출):
#   ChatTurnHandler.onCancel(requestId) / onApprovalResponse(...) / onCredsUpdate(...)
```
> ⚠️ god-port 금지: provider/conversation/skill 독립. ingress 가 모든 inbound 받아 type 별 라우팅(os MessageRouter 대칭 — 단일 구독).

### B.3 app/
```
ChatTurnHandler (UC1 오케스트레이션, ingress router 가 type 별 호출):
  onChatRequest(req):
    providerConfig = { ...req.provider, enableThinking: req.enableThinking }   # ⚠️ top-level enableThinking → providerConfig 명시 주입(os outbound top-level 송신, baseline 등가)
    { messages, systemPrompt } = ConversationPort.assemble(req)
    stream = ProviderPort.chat(providerConfig, messages, { systemPrompt, abort })
    let sawTerminal=false, usage={in:0,out:0}
    try {
      for await chunk of stream:
        if chunk.kind==="usage": usage 누적(emit 안 함)            # ⚠️ usage 는 스트림 누적만(중복방출 방지, S1)
        else: e=mapProviderChunk(chunk); emit(req.requestId, e); if e.kind==="finish": sawTerminal=true; state=finished   # provider 정상 종료=finish chunk 만(ProviderChunk 에 error 없음; 실패=rejection→catch)
    } catch (err) { emit(req.requestId, {kind:error,message}); state=errored; sawTerminal=true }  # provider rejection→error+terminal
    # 종결 규칙(S1): 정상은 provider 가 finish chunk 방출(sawTerminal). 무-terminal EOF(예외도 finish 도 없음)=조기종료→ emit error+errored. (finish 강제 안 함)
    if !sawTerminal: emit(req.requestId, {kind:error,message:"incomplete stream"}); state=errored
    emit(req.requestId, {kind:usage, ...usage})                    # ⚠️ 누적 usage *1회* 종결 시(중복 아님)
  onApprovalResponse(req): 보류 중 approval Promise resolve(decision) → 해당 turn 추론 계속  # ApprovalPort 결속
  onCredsUpdate(req): provider 자격 저장 갱신(다음 chat 부터 적용). turn 상태 무관
  onCancel(requestId): abort signal set → ChatTurn streaming→cancelling(비종결; 후속 finished/errored 가 종결)
  # wire encode/decode·demux 안 봄(adapter). provider 선택만 domain.
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
