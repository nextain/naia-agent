# UC5 agent(brain) 도구 실행 루프 수평 계약 — slice 1 (2026-06-10)

> 시나리오 SoT: `new-naia-os/docs/user-scenarios.md` UC5(도구 사용 — Chat→사고(의도)→능력·도구(skill/mcp)→표현), S20 time / S21 weather / S22 memo / S23 github / S25 mcp.
> 앵커: UC1 agent 계약(`UC5` 는 그 루프의 *확장*). wire 경계(H-agent) **불변** — toolUse·toolResult·approval_request 는 이미 chat-turn variant 에 존재(os MessageRouter 가 표시 처리, UC1 변종 E2E 로 검증됨).

## 슬라이스 경계 (bounded)
- **slice 1 (이 계약)**: agent 내부 **도구 실행 루프** — provider 가 tool 호출을 내면 agent 가 실행→결과를 대화에 엮어 provider 재호출→최종 텍스트까지. 도구 = agent 등록 built-in(결정론). 승인 불요(tier=none) 도구만.
- **slice 2 (후속)**: 승인 게이트(tier-gated → approval_request emit → os/user → approval_response → 재개). ApprovalPort.awaitDecision.
- **slice 1b (후속)**: openai-compat provider 의 실 streaming tool_calls 송수신(tools 전송 + delta.tool_calls 재조립). slice 1 은 fake provider 로 루프 아키텍처 입증.
- **범위 밖**: os-side ToolPort/EnvironmentPort 실행(execute_command sandbox·panel·browser = UC6/UC7), gateway/mcp 도구(S55/S56), 번들 ~60 스킬(S71 per-skill).

## §A. Old-Baseline (old agent 실코드 흐름)
old naia-os agent = LLM tool_calls → agent runtime 가 skill/tool 실행 → 결과를 tool 메시지로 대화에 append → LLM 재호출 → tool 없는 최종 응답까지 (multi-round agentic loop). 표시용 tool_use/tool_result 를 stream.
**판정**: 루프·multi-round threading = **이식**(패턴). ToolExecutorPort·ChatMessage tool 확장·반복상한 = **보충**(clean 포트화).

## §B. 포트 계약

### B.1 domain/ (순수, import 0)
- **ChatMessage 확장**(provider-agnostic, 어댑터가 provider API 로 매핑):
  - `{ role: "system"|"user"|"assistant"; content: string; toolCalls?: readonly ToolCall[] }`
  - `{ role: "tool"; toolCallId: string; content: string }`  ← 도구 결과 메시지
  - ⚠️ assistant 가 toolCalls 만 있고 본문 없을 때 `content: ""`(빈 문자열). slice 1b openai-compat 매핑 시 `content==="" && toolCalls?.length` → wire `content: null`(OpenAI tool_calls 메시지 규약)로 변환(어댑터 책임, domain 은 빈 문자열 유지).
- `ToolSpec = { name: string; description: string; parameters: unknown /* JSON schema */ }`
- `ToolCall = { id: string; name: string; args: unknown }`
- `ProviderChunk` 의 `toolUse{ id, name, args }` 기존 그대로. `mapProviderChunk(toolUse)` → AgentEmit toolUse 기존 그대로.
- **usage 의미(명세 고정)**: `ProviderChunk.usage{inputTokens,outputTokens}` = **그 provider.chat *호출(=라운드)* 의 누계 스냅샷**(델타 아님). 한 호출에서 usage 가 여럿 오면 **마지막 1개 채택**(스냅샷). 전체 turn usage = **라운드별 채택값의 합**(라운드 간 합산). ⚠️ UC1 핸들러의 `+= chunk.inputTokens`(델타 가정)는 slice 1 에서 "라운드 스냅샷을 라운드 종료 시 1회 합산"으로 교체.
- 순수 헬퍼 `threadToolRound(messages, roundText, calls, results)` → 다음 라운드 messages:
  append `{ role:"assistant", content: roundText /* 이 라운드 누적 텍스트, 없으면 "" */, toolCalls: calls }` **그 다음** 각 result 를 `{ role:"tool", toolCallId, content: result.output }` 로 append. 결정론. (라운드 텍스트가 history 에서 유실되지 않음.)

### B.2 ports/ (driven 추가)
```
interface ToolExecutorPort {
  specs(): readonly ToolSpec[]               # LLM 에 전달할 등록 도구 사양(빈 배열 가능)
  execute(call: ToolCall, opts: { signal?: AbortSignal }): Promise<{ output: string; isError?: boolean }>
    # ⚠️ no-throw 책임: 미등록/실행실패/타임아웃 = { output: <errMsg>, isError: true } 반환(throw 금지 — 루프 안정·LLM 이 복구 시도 가능). abort 시에만 reject 허용(루프가 cancelled 처리).
}
```
- `ProviderChatOpts` 에 `tools?: readonly ToolSpec[]` 추가(provider 가 LLM 에 전달; fake/미지원 provider 는 무시).

### B.3 app/ — ChatTurnHandler 루프 확장 (UC1 불변식 보존)
**terminal 래치**(`sawTerminal` bool) + **abort 가드**가 전 단계를 관문. `MAX_TOOL_ROUNDS=8` = **허용 도구라운드 최대치**(= 도구 실행 라운드 수; cap-th 결과로 provider 재호출은 *허용*, 그 재호출이 또 도구 요청 시에만 error).

상태: `toolRounds=0`, `totalUsage={0,0}`, `sawTerminal=false`.
```
loop:
  if sawTerminal: stop
  if signal.aborted: terminal_error("cancelled"); stop          # provider 호출 전 가드
  roundText="" ; calls=[] ; roundUsage=null ; sawFinish=false
  try:
    for await chunk of provider.chat(cfg, msgs, {systemPrompt, signal, tools: exec.specs()}):
       text/thinking → roundText += (text only) ; emit(map)      # 스트리밍 정상 표시(즉시) + history 누적
       toolUse       → calls.push(call)                          # ⚠️ emit 보류(실행 확정 후) — provider 가 complete toolUse 를 yield 하므로 지연 무해. cap overflow 시 orphan toolUse 방지(I6)
       usage         → roundUsage = chunk (마지막 채택, snapshot) # emit 안 함
       finish        → sawFinish=true ; break (종료자=finish 1회; 이후 chunk 무시)
  catch err:                                                     # provider.chat() rejection(throw) — UC1 계승
    if roundUsage: totalUsage += roundUsage                      # 부분 usage 1회 합산
    if signal.aborted: terminal_error("cancelled") else terminal_error("provider error: "+errMessage(err))
    stop
  if !sawFinish: # 스트림이 finish 없이 정상 EOF → provider error(UC1 계승)
    if roundUsage: totalUsage += roundUsage ; terminal_error("incomplete stream") ; stop
  if roundUsage: totalUsage += roundUsage                        # 라운드 스냅샷 1회 합산
  if signal.aborted: terminal_error("cancelled"); stop           # ⚠️ provider loop 종료 직후 가드(finish 직후 취소 시 finish/cap-error 가 cancel 보다 먼저 방출되는 것 차단 — cancel 단일 terminal 보장)
  if calls.empty:                                                # 최종 응답
     terminal_finish() ; stop                                   # usage 합산본 1회 + finish (래치)
  # 도구 라운드:
  if toolRounds >= MAX_TOOL_ROUNDS:                              # 이미 cap 회 실행함 + provider 가 또 도구 요청
     terminal_error("tool loop limit exceeded") ; stop          # terminal_error 가 usage 합산본 1회 emit(중복 emit 금지, I1)
  toolRounds += 1
  results=[]
  for call in calls:                                            # 실행 확정(cap 통과) — 이제 toolUse emit 안전
     if signal.aborted: terminal_error("cancelled"); stop       # 매 call 전 가드(레이스: 라운드 끝~execute 사이 취소). 아직 미emit → orphan 없음
     emit toolUse(call)                                         # ⚠️ 여기서 emit(실행 직전) — 반드시 toolResult 와 쌍(I6)
     r = await exec.execute(call, {signal})  (reject 시: aborted면 cancelled terminal; 아니면 r={output:err,isError:true})
     if signal.aborted: terminal_error("cancelled"); stop       # execute 직후 가드(execute 중 취소→toolResult 방출 금지; 이 call 의 toolUse 는 이미 나갔으나 turn 이 cancelled terminal 이므로 표시상 미완 tool 로 처리=수용)
     emit toolResult{toolCallId, output: r.output}              # 표시(toolUse 와 쌍)
     results.push(r)
  msgs = threadToolRound(msgs, roundText, calls, results)       # assistant(roundText+calls) + tool 메시지들
  # loop (provider 재호출)
```
**terminal 헬퍼**(래치로 정확히 1회 — usage 중복 emit 원천 차단): 두 종결 모두 이 헬퍼만 사용(직접 `emit usage` 금지).
`terminal_error(msg)` = `if !sawTerminal { emit usage(totalUsage); emit error(msg); sawTerminal=true }`.
`terminal_finish()`  = `if !sawTerminal { emit usage(totalUsage); emit finish;     sawTerminal=true }`.

**불변식 (UC1 계승 + UC5 추가)**:
- (I1) **usage** = 라운드 스냅샷의 합, terminal(finish/error) *직전* 정확히 1회. terminal 이후 무방출.
- (I2) **finish XOR error**: terminal 래치로 정확히 1개만 발생(레이스에서도 첫 terminal 만 win).
- (I3) **도구 실행 실패 ≠ terminal**: execute 가 `{isError:true}` 반환 시 toolResult 로 emit + threadToolRound 에 그 output 포함 → LLM 재호출(복구). 무한 retry 는 cap(I7)이 바운드. provider rejection / cap 초과 / cancel 만 terminal error.
- (I4) **cancel**: abort 를 provider.chat + exec.execute 양쪽 전파. **가드 지점 = (a) provider 호출 전 (b) provider loop 종료 직후(usage 합산 뒤, calls.empty/cap 판정 전) (c) 매 execute 전 (d) execute 직후**. 가드 통과 후 terminal_error("cancelled"), 래치로 단일 terminal. **terminal 이후 toolResult/finish 방출 금지**(orphan 방지). 이미 aborted 인 signal 을 넘겨도 execute 의 reject 에 의존하지 않고 가드가 선제 차단.
- (I5) **emit no-throw**(R11), **레지스트리 finally 해제**, **중복 requestId = 진단 로그·wire error 금지**(R10) — UC1 계승.
- (I6) **toolUse↔toolResult 쌍 + 순서**: toolUse 는 **실행 확정(cap 통과) 후, 각 call 실행 직전** emit(스트림 중 아님 — provider 가 complete toolUse yield, 버퍼링 무해). 따라서 emit 된 toolUse 는 반드시 toolResult 와 쌍. cap overflow 라운드의 tool 호출은 **emit 안 함**(orphan 없음). 같은 라운드 다수 call = **전부** 순서대로 (toolUse→execute→toolResult) 후 재호출(first-only 아님). **유일 예외(수용 경계)**: cancel 이 execute *중* 도착하면 그 in-flight call 의 toolUse 1건은 toolResult 없이 cancelled terminal — UC1 mid-turn truncation 과 동일 의미(무한 하드닝 회피, 명시적 bound).
- (I7) **cap = 허용 도구라운드 최대치**(round 단위). cap-th 라운드 실행 결과로 provider 1회 재호출(최종답 기회) → 그 재호출이 또 도구면 error. 무한 도구 루프 방지.
- (I8) **라운드 종료자 = finish 정확히 1회**. finish 없는 EOF = provider error("incomplete stream"). post-finish chunk 무시.

### B.4 adapters/
- **fake-provider**(slice 1 검증): 시나리오 주입 — 1라운드 toolUse(예: echo) 방출+finish → (agent 실행) → 2라운드 텍스트+finish. 결정론.
- **built-in ToolExecutor**(slice 1): 등록 도구 1개 — `echo`(args.text 반향, 순수·결정론) [+ 확장 여지]. 미등록 name → isError. specs() = echo 사양.
- **openai-compat-provider**(slice 1b): tools 를 body.tools 로 전송 + SSE delta.tool_calls 재조립(id/name/arguments 누적) → 완전 toolUse chunk yield. (slice 1 에선 미구현 — 계약만.)

### B.5 composition/ — ToolExecutorPort 주입(미주입=specs() 빈 + execute=isError, UC1 동작 회귀 없음 = 도구 없는 순수 채팅).

### B.6 검증 (2건+ 객관 기준)
- **계약 테스트**(vitest): (a) 1-tool 라운드 → toolUse→toolResult→재호출→finish 순서·usage 1회·finish 1회 (b) 미등록 tool → isError toolResult + 복구 (c) cap 초과 → error terminal(usage 1회, toolUse orphan 없음) (d) cancel 중 도구 실행 → error "cancelled" (e) 도구 0개(executor 미주입) → UC1 순수채팅 회귀 없음 (f) **같은 라운드 2-call → 두 call 모두 toolUse→toolResult 가 순서대로(call0 쌍 → call1 쌍) 전부 방출된 뒤 provider 재호출**(I6 first-only 회귀 검출) (g) cap overflow 라운드의 toolUse 는 미emit(orphan 없음 단언).
- **실 UI E2E**(`uc1-new-core-variants` 패턴 확장 또는 신규): fake provider+executor 로 agent 루프를 실 stdio 로 구동(또는 os 표시 경로) → toolUse·toolResult·최종텍스트 렌더.
- **codex 2-clean**: 이 계약 + 각 코드 컴포넌트 2연속 NONE.

### B.7 다음
slice 1 코드 → slice 1b(openai-compat tool_calls, GLM 실동작) → slice 2(승인 게이트 ApprovalPort.awaitDecision) → S20+ 실 스킬(time/weather/memo) per-tool.
