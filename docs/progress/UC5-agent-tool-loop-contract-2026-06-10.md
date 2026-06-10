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

## §C. slice 1b — openai-compat provider 의 실 tool_calls (GLM 실동작)
slice 1 의 fake provider 를 실 provider 로 대체. `makeOpenAICompatProvider` 가 (1) tools 전송 (2) tool-bearing 메시지 매핑 (3) SSE delta.tool_calls 재조립 → 완전 toolUse chunk yield. **agent 루프(slice 1)·wire·ToolExecutor 불변** — provider 어댑터만 변경. domain ProviderChunk.toolUse{id,name,args} 그대로 사용.

### C.1 요청 매핑 (domain → OpenAI wire)
- **tools**: `opts.tools?.length` 일 때만 body 에 `tools: specs.map(s => ({ type:"function", function:{ name:s.name, description:s.description, parameters:s.parameters } }))` 추가. (없으면 tools 키 자체 생략 — 기존 채팅 동작 불변.) `tool_choice` 는 미설정(provider 기본=auto).
- **메시지 매핑**(각 ChatMessage → OpenAI message):
  - `assistant` + `toolCalls?.length`: `{ role:"assistant", content: content==="" ? null : content, tool_calls: toolCalls.map(c => ({ id:c.id, type:"function", function:{ name:c.name, arguments: JSON.stringify(c.args ?? {}) } })) }`. (content "" + toolCalls → null = OpenAI 규약.)
  - `tool`: `{ role:"tool", tool_call_id: m.toolCallId, content: m.content }`. ⚠️ `toolCallId` 없으면 **mapping error throw**(skip 금지 — assistant tool_calls ↔ 결과 대응이 깨진 채 요청 의미 변경 방지; rejection→handler catch→terminal error). 정상 경로엔 threadToolRound 가 항상 설정.
  - 그 외(system/user/일반 assistant): `{ role: m.role, content: m.content }`(기존).

### C.2 응답 파싱 (SSE delta.tool_calls 재조립)
- 기존 `delta.content` → text chunk 즉시 yield(불변).
- **delta.tool_calls**(배열, 각 `{ index, id?, type?, function?:{ name?, arguments? } }`): ⚠️ **index 검증 먼저** — `index` 가 non-negative integer(`Number.isInteger(index) && index >= 0`) 아니면(누락/음수/비정수/실수) **throw**(누적 전; 잘못된 index 는 call 병합·순서 오류 유발). 통과 시 index 별 누적 버퍼 `acc[index] = { id, name, args:"", excluded:false, conflict:false }`:
  - `id` 도착 시 설정(첫 조각). ⚠️ 이미 nonempty id 가 설정된 index 에 후속 delta 가 **다른 nonempty id** 를 가져오면 **즉시 throw 하지 말고 `conflict=true` 마커만** 세움(동일 id 재전송·빈 id 후속은 무시). `function.name` 동일(다른 nonempty name 후속 → conflict 마커). `function.arguments`(문자열 조각)는 **이어붙임**(args += fragment).
  - ⚠️ **type 가드**: delta 에 `type` 이 존재하고 `"function"` 이 아니면 그 index 를 `excluded=true` 로 표시(non-function tool = 미지원). ⚠️ excluded 인 index 는 **이후 모든 필드(id/name/args/conflict) 무시** — 미지원 호출의 충돌은 오류 아님("미지원=무시"). type 미존재(스트림 조각엔 흔함)는 function 으로 간주.
  - ⚠️ **conflict 는 finalize 에서만 평가**(누적 중 throw 금지) — 후속 delta 가 그 index 를 excluded 로 밝힐 수 있으므로(레이스). finalize 가 non-excluded index 만 검증.
- **usage/finish 도 finalize 에서만**(스트림 중 즉시 yield 금지): `usage`(inTok/outTok)는 스트림 중 *누적만*(기존), `finish` 도 mid-stream yield 안 함. 종료 단위 산출(toolUse·usage·finish) 전부 단일 finalize 가 순서대로 방출 → `toolUse → usage → finish` 순서 보장.
- **단일 finalize 경로**(`finalized` 가드로 정확히 1회 — `[DONE]` *또는* EOF 중 먼저 도달한 쪽에서만 실행, 다른 쪽은 가드로 no-op → 이중 yield 차단). 순서: **(1) 원자적 toolUse 배열 yield → (2) usage(누적값, inTok|outTok>0 일 때) → (3) finish**:
  - ⚠️ **abort = 단일 commit point**: 배치 yield *시작 전* `signal.aborted` 1회 검사 — true 면 toolUse·usage·finish 전부 yield 안 함(acc 폐기, abort 가 정상 EOF 로 관찰돼도 부분 flush 방지). false 면 **commit** = 추가 검사 없이 배치 완주 yield. ⚠️ async generator 는 각 yield 에서 suspend 하므로 yield *사이* abort 가 들 수 있으나 provider 가 per-yield 로 막지 않음 — **all-or-none 은 소비 측에서 성립**: agent runRound 가 `Promise.race([it.next(), abortP])` 로 abort 후 `it.next()` 결과를 안 읽고 멈춤(잔여 chunk 미소비). 기존 usage/finish yield 와 동일 모델(provider 단독 보장 불요).
  - ⚠️ **2단계(parse-all-then-yield-all, 원자적)**: 먼저 누적된 acc 를 **index 오름차순**, `excluded` 아닌 것만 전부 검증해 `{id,name,args}` **완성 배열**을 만든다. 각 non-excluded index 검증: **conflict 마커면 throw**(id/name 혼선), 그 다음 name/args 검증(아래). 이 단계서 어떤 위반이든 throw — 어떤 toolUse 도 아직 yield 안 함 → 부분 방출 없음. 검증 통과 후에만 배열을 순서대로 일괄 yield. (index 순 parse↔yield 교차 금지.)
  - ⚠️ **provider id 중복 거부**: parse-all 중 *nonempty* provider 제공 id 가 배치 내 둘 이상 같으면 **throw**(protocol 손상 — 같은 id 의 결과 결속이 모호. 합성 id 충돌 회피(아래)는 빈 id 만 다루므로 이건 별도). 빈 id 만 합성 대상.
    - `id` = acc.id, 없으면 **배치 내 유일 합성**: provider 제공 id 전체를 used 집합에 먼저 모으고, `call_${index}` 가 used 에 있으면 `call_${index}_1`, `_2`… 충돌 없는 첫 값(결정론·배치 내 유일 — 합성 id 가 다른 call 의 provider id 와 겹쳐 결과 결속이 모호해지는 것 방지). 합성 id 도 used 에 추가.
    - `name` = acc.name — **빈/미설정이면 throw**(protocol 손상; name 없는 tool_call 은 "완전 toolUse" 아님. unknown-tool isError 로 오분류 금지 — 그건 *유효한* name 이 실행기에 미등록일 때만).
    - `args` = acc.args 가 **빈 문자열이면 `{}`**(인자 없는 도구 = 정상). 아니면 `JSON.parse(acc.args)` 후 **반드시 plain object(non-null, non-array) 검증** — parse 실패 *또는* 결과가 object 아님(null/배열/문자열/숫자)이면 **throw**(malformed arguments = protocol 손상 → terminal "provider error"). 빈 객체로 무마하면 인자 없이 도구 오실행 위험이라 금지. (function arguments 는 JSON object 규약.)
- 순서: **text chunk(스트림 중) → finalize 에서 모든 toolUse chunk(index 순) → usage → finish**. (agent runRound 는 toolUse 를 calls 로 버퍼링하므로 순서 무관하나 결정적 순서 고정.)

### C.3 불변식·경계 (slice 1 계승 + 1b)
- (C-I1) **tools *및* tool-bearing 메시지(assistant.toolCalls·tool role)가 모두 없는 기존 text-only 입력 = 동작 완전 동일**(tools 키 생략 + 메시지 매핑이 기존 {role,content} 경로 → delta.tool_calls 안 옴 → toolUse 0). (tool-bearing 메시지가 있으면 C.1 새 매핑 적용 = 의도된 차이.)
- (C-I2) reader cleanup(finally cancel)·`[DONE]` 종료·`{error}` 이벤트 throw·null 가드 = 기존 2-clean 그대로.
- (C-I3) tool_calls 재조립은 **provider 호출 1회(라운드) 범위** — 라운드 종료 시 acc 비움(라운드 간 누수 없음, 새 호출=새 generator=새 acc).
- (C-I4) abort: 기존 signal 전파(opts.signal) 그대로. **commit point 모델**(C.2): finalize 진입 전 abort 면 배치 전체 미yield(폐기). commit 후 yield 간 abort 는 provider 가 안 막고 소비자(agent runRound abort-race)가 잔여 미소비로 처리 — provider 단독 all-or-none 보장 불요(async-gen suspension 상 불가능하며 기존 usage/finish 와 동일). 부분 누적 tool_calls 는 finalize 전 abort 면 미yield.
- **경계 밖**: parallel tool_calls 의 정확한 OpenAI/GLM 변종 차이(zai 가 표준 따른다고 가정), tool_choice 강제, function 외 tool type(미지원=무시).

### C.4 검증
- **mock fetch 계약 테스트**(기존 `uc1-openai-compat.contract.test.ts` 패턴): (a) tools 전달 시 body.tools 매핑 정확 (b) SSE delta.tool_calls 다조각 재조립(id 첫조각·arguments 분할) → 완전 toolUse{id,name,args 파싱} (c) text+tool_calls 혼합 → text chunk + toolUse 둘 다 (d) arguments JSON **손상 → throw**(provider error); arguments **빈 문자열 → args={}** (e) id 누락 → call_{index} 합성 (f) tools·tool-bearing 메시지 미전달 → 기존 text-only 회귀 없음 (g) assistant(toolCalls)+tool 메시지 매핑 → body.messages 형상(content null·tool_call_id) / tool 메시지 toolCallId 누락 → throw (h) type!=="function" delta → 해당 index 제외(yield 안 함) (i) finalize 단일성: `[DONE]` 후 EOF 와도 toolUse 이중 yield 없음 (j) **원자성**: 다중 call 중 뒤 call args 손상 → throw + 선행 toolUse **0개** 방출(parse-all-then-yield) (k) **abort commit-point**: finalize 진입 전 aborted signal → toolUse·usage·finish **전부 미방출** (l) **EOF-only**(`[DONE]` 없이 스트림 EOF) → finalize 배치(toolUse→usage→finish) 정확히 1회 방출 (m) **중복 provider id**(두 call 같은 nonempty id) → throw / 빈 id 2개 + 충돌 prefix → 유일 합성. (n) **conflict 지연**: 같은 index 에 다른 nonempty id/name 후속 → finalize 에서만 throw(누적 중 아님) (o) **excluded 억제**: id/name 충돌난 index 가 후속 non-function type 으로 excluded → 오류 없이 yield 제외. (p) **invalid index**(누락/음수/비정수) → throw (q) **빈 name** → throw (r) **non-object args**(`null`·배열·문자열·숫자 = JSON-valid 지만 비객체) → throw.
- **루프 결합**(선택): makeOpenAICompatProvider(mock fetch, 2-라운드: 1라운드 tool_calls·2라운드 text) + echo executor + ChatTurnHandler → uc5 루프 시퀀스. (slice 1 stdio 통합의 provider 교체판.)
- **codex 2-clean**: §C + openai-compat-provider 코드 2연속 NONE.
