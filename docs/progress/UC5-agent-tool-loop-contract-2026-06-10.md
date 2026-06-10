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
  - `assistant` + `toolCalls?.length`: `{ role:"assistant", content: content==="" ? null : content, tool_calls: toolCalls.map(c => ({ id:c.id, type:"function", function:{ name:c.name, arguments: JSON.stringify(c.args) } })) }`. (content "" + toolCalls → null = OpenAI 규약. args 는 parse 단계서 항상 plain object 보장이라 `?? {}` 불요·생략 — null→{} 변환 같은 의미 변경 방지.)
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

## §D. slice 2 — 승인 게이트 (tier-gated 도구, UC13)
agent 루프가 **tier-gated 도구를 실행 전 사용자 승인 대기**. wire 의 `approval_request`(agent emit, 기존 chat-turn variant)·`approval_response`(inbound AgentOutbound, 기존) 사용. slice 1 의 call 처리 단계만 확장 — 루프 골격·wire·usage·terminal 래치 불변.
**범위**: agent 측(emit approval_request + await + approve/reject 분기). **os 측 표시/응답 송신 = os UC13(범위 밖, 후속)** — os MessageRouter 는 approval_request 를 이미 chat-turn(approvalRequest)으로 라우팅(UC1 §B.4), 응답 송신 배선만 os 후속.

### D.1 tier 출처
- `ToolSpec` 에 `tier?: string` 추가. **미설정 또는 `"none"` = 자동 실행**(slice 1 경로, approval 불요). 그 외(예 "ask") = **승인 필요**.
- `exec.specs()` 의 **name 은 유일**(executor 계약). 루프가 `call.name` 으로 tier 조회. 미등록 도구 = tier none(어차피 execute isError — approval 무의미). ⚠️ **보수적**: 같은 name 이 둘 이상 매치(계약 위반 상황)면 가장 제한적 tier(= 승인필요) 채택 — gated→auto 로 **조용히 강등 금지**.

### D.2 ApprovalPort 확장 (2단계 — register-before-emit)
```
interface ApprovalPort {
  resolve(requestId, toolCallId, decision): void   # inbound approval_response 처리. UC1 no-op → slice 2 실구현
  prepareDecision(requestId, toolCallId, opts:{signal?}): { promise: Promise<"approve"|"reject">; dispose: () => void }
}
```
- `prepareDecision`: 보류를 **즉시 등록** 후 `{promise, dispose}` 반환. ⚠️ **키는 구조적**(nested `Map<requestId, Map<toolCallId, pending>>` 또는 충돌 불가능 키) — `requestId|toolCallId` 문자열 concat 금지(둘 중 하나에 `|` 포함 시 다른 쌍과 충돌해 오결정). handler 가 *먼저 호출해 등록* → 그 다음 approval_request emit → 그 다음 `promise` await. ⚠️ **fast/sync resolve 유실 방지**(emit 전 등록 완료).
  - ⚠️ **abort 원자성 (check→listen→recheck)**: ① `signal.aborted` 검사 — 이미 true 면 promise 즉시 reject(미등록/즉시 dispose). ② false 면 abort listener 설치(abort → reject + 보류 제거 + listener 해제). ③ listener 설치 **직후 `signal.aborted` 재검사** — 그새 abort 됐으면(check~listen 윈도우) 즉시 reject + 정리. 이 3단계로 check↔listen 경합(이벤트 놓쳐 영구 대기) 제거.
  - `dispose()`: 보류가 **아직 미해소면 제거 후 promise 를 reject(settle)** + abort listener 해제 — 무한 pending 방지(first-settlement 보장). 이미 해소(resolve/abort)됐으면 **no-op**(idempotent). handler `finally` 에서 항상 호출(예외/정상 무관). reject 는 handler 의 `void promise.catch(()=>{})` 가 관찰(unhandled 없음).
  - **단일 settlement**: resolve·abort·dispose 중 첫 효력만, 이후 no-op(**delete-before-settle** — settle 전 보류 맵에서 제거해 재진입·중복 차단).
- `resolve`: key 보류를 **먼저 제거한 뒤** settle. 미등록 key(보류 없음/이미 해소/지연·중복) = **no-op**. listener 해제.

### D.3 handler 루프 — call 처리 확장 (slice 1 §B.3 의 `for call in calls` 내부)
```
for call in calls:
  if signal.aborted: terminal_error("cancelled"); stop        # (c) 기존
  # ⚠️ cid = **turn-unique correlation id**(D-I7): turn used-set 기준 — 후보 = call.id, used 면 `${call.id}#r${toolRounds}`, 그것도 used 면 `${call.id}#r${toolRounds}_2`, `_3`… **unused 까지 반복**(한정값 자체 충돌도 검사 — provider 가 `x#r1` 같은 값을 직접 줄 수도 있음). 확정 cid 를 used-set 에 추가. 이후 toolUse·approval_request·toolResult·threadToolRound 전부 **cid 일관**(LLM correlation 유지 + 지연 approval_response 오결정 차단).
  cid = turnUniqueCorrelationId(call.id)   # loop-until-unused (§C 합성 id 와 동일 보장)
  emit toolUse({...call, toolCallId: cid})                    # 표시(승인 대상 노출, cid)
  tier = tierOf(call.name)                                    # specs 조회, 없으면 "none"(중복 매치=승인필요 보수)
  if tier != "none":                                          # 승인 필요
     if signal.aborted: terminal_error("cancelled"); stop     # (e) prepare 전 가드
     const { promise, dispose } = approval.prepareDecision(requestId, cid, {signal})  # 등록 먼저(turn-unique 키)
     void promise.catch(() => {})  # ⚠️ rejection 관찰자 즉시 부착 — await 안 하는 early-stop(e2)서 unhandled rejection 방지(실제 결정은 아래 await).
     if signal.aborted: dispose(); terminal_error("cancelled"); stop  # (e2) prepare 직후·emit 전 가드(prepare 중 abort 시 해소불가 approval_request emit 방지)
     decision = "reject"
     try:
       emit approval_request{toolCallId: cid, toolName: call.name, tier}  # 등록 후 emit(fast resolve 안전, cid)
       try: decision = await promise
       catch: decision = "reject"                              # abort 면 아래 (f) 가 cancelled; 비-abort reject = 안전 기본
     finally: dispose()                                        # 항상 정리(누수 방지, idempotent)
     if signal.aborted: terminal_error("cancelled"); stop      # (f) await 후 가드(abort 단일 cancelled)
     if decision == "reject":
        emit toolResult{toolCallId: cid, output: "도구 호출이 거부되었습니다"}  # 거부도 toolResult 쌍(I6, cid)
        results.push({id: cid, output: "도구 호출이 거부되었습니다", isError: true})
        continue                                               # 실행 안 함 — 다음 call
  # approve 또는 비-gated → slice 1 그대로(cid 사용):
  r = await exec.execute(call, {signal}) ...                   # (d) 가드 등 slice 1 동일(executor 는 id 무관)
  emit toolResult{toolCallId: cid, output: r.output}; results.push({id: cid, ...r})
# threadToolRound 는 cid 로 묶은 calls(assistant tool_calls id=cid) + 결과(tool 메시지 toolCallId=cid) 사용 — turn 내 일관.
msgs = threadToolRound(msgs, roundText, callsWithCid, results)
```
⚠️ call 단위 `dispose`(finally)로 미해소 보류 즉시 정리 — 별도 turn-finally 추적 불요. **cid turn-unique + requestId turn-unique(§B.4.1) ⇒ (requestId,cid) wire correlation 키가 turn 내 유일 → 지연/cross-round approval_response 오결정 없음**. reused requestId 충돌도 dispose 로 차단.

### D.4 불변식 (slice 1 계승 + slice 2)
- (D-I1) **비-gated(tier none) = slice 1 동작 완전 동일**(approval_request 미방출).
- (D-I2) **toolUse↔toolResult 쌍 유지**: gated 도구도 approve→실행 toolResult / reject→거부 toolResult. 모든 emit 된 toolUse 는 toolResult 와 쌍. (cancel 중 in-flight = 기존 수용 bound — toolUse/approval_request 후 cancel 시 toolResult 없이 cancelled.)
- (D-I3) **reject ≠ terminal**: 거부 = toolResult(isError) + threadToolRound 포함 → LLM 재호출(복구·대안 제시). 무한 retry 는 cap(I7) 바운드.
- (D-I4) **cancel**: approval 대기 중 abort → promise reject → terminal "cancelled"(단일 래치). 가드 = (e) prepare 전 (e2) prepare 직후·emit 전 (f) await 후 + catch. dispose 가 finally 에서 보류·listener 정리. terminal 이후 무방출.
- (D-I5) **순서·결속**: prepareDecision(등록) → emit toolUse 는 이미 됨 → emit approval_request → (decision) → toolResult. 전부 requestId·toolCallId 결속. **등록이 emit 보다 먼저**(fast resolve 유실 방지).
- (D-I6) **단일 settlement·정리**: resolve 는 delete-before-settle(미등록/중복/지연 = no-op). 모든 종결 경로(resolve/abort/dispose)가 보류 제거 + listener 해제, 첫 효력만. dispose idempotent — 누수 없음.
- (D-I7) **correlation 키 turn-unique**: requestId turn-unique(§B.4.1) + cid turn-unique(used-set·round 접미사) ⇒ `(requestId, cid)` wire 승인 correlation 키가 turn 내 유일. 합성 `call_{index}` 라운드 반복·provider id 재사용에도 지연/cross-round approval_response 가 다른 보류를 오결정하지 않음. cid 는 toolUse·approval_request·toolResult·threadToolRound 전부 일관.
- (I1·I2·I5·I7 등 slice 1 계승): usage 1회·finish XOR error 래치·emit no-throw·cap 등 불변.

### D.5 검증
- 계약 테스트: (a) gated approve → toolUse→approval_request→execute→toolResult→재호출→finish (b) gated reject → toolUse→approval_request→toolResult(거부)→재호출→finish(execute 안 함) (c) non-gated → approval_request 미방출(slice 1 동일) (d) approval 대기 중 cancel → cancelled terminal·toolResult 미emit·usage 1회 (e) 다중 call 혼합(gated+non-gated) 순서·쌍 (f) 미지 approval_response(보류 없는 id) → no-op (g) **fast/sync resolve**(emit 직후 즉시 resolve)도 유실 없이 반영(register-before-emit) (h) **dispose idempotent**: 해소 후/중복 dispose 무해, 보류 누수 없음 (i) **abort 원자(check→listen→recheck)**: 이미 aborted signal → 즉시 cancelled; listener 설치 직후 abort 도 즉시 settle(영구 대기 없음) (j) **중복 tier name**(계약 위반) → 승인필요(보수) (k) **cid turn-unique**: 두 라운드가 같은 call.id(예 합성 call_0) 사용 → 2라운드는 round 접미사로 한정(`call_0#r2`)되어 1라운드의 지연 approval_response(call_0)가 2라운드 보류를 건드리지 않음; toolUse/approval/toolResult/thread 전부 cid 일관.
- 라이브(선택): GLM + gated 도구 + approve/reject.
- **codex 2-clean**: §D + ApprovalPort 구현 + handler 확장 코드 2연속 NONE.

## §E. 실 스킬 — S20 time / S21 weather / S22 memo (ToolExecutorPort 구현)
echo(데모)를 실 스킬로. ToolExecutorPort(§B.2, 2-clean) 뒤의 concrete 어댑터 — 포트·루프·승인 불변. 도구 5개를 한 `makeBuiltinSkillsExecutor(deps)` 가 제공.

### E.1 deps 주입(순수·테스트성)
- `clock(): Date` (S20), `fetchWeather(lat,lon,signal): Promise<{tempC:number; code:number}>` (S21, 외부 — **기본값 없음**; live entry 가 open-meteo 구현 주입, 테스트는 mock 주입), `memo: MemoStore` (S22).
- `MemoStore = { save(title,content): void; list(): readonly string[]; get(title): string|null }`. **memo 는 기본값 = in-memory Map**(항상 가용; 파일영속 = 후속, entry 가 주입 가능). **clock·fetchWeather 는 기본값 없음**(테스트성 위해 ()=>new Date 금지) — 미주입 시 해당 도구만 isError(E-I4). 즉 memo_*는 항상 가용, get_time/get_weather 는 dep 주입 시에만 가용.

### E.2 도구 5개 (name · tier · args · 동작)
| name | tier | args | 동작 | 결과 |
|---|---|---|---|---|
| `get_time` | none | `{timezone?: string}` | clock() → ISO 문자열(+tz 있으면 Intl 포맷) | 시각 문자열 |
| `get_weather` | none | `{latitude:number, longitude:number}` | fetchWeather | "기온 X°C, 코드 Y" |
| `memo_list` | none | `{}` | memo.list() | 저장소 순서 유지 `titles.join("\n")`; 빈 목록은 "(없음)" |
| `memo_get` | none | `{title:string}` | memo.get(title) | 내용 / "(없음)" |
| `memo_save` | **ask** | `{title:string, content:string}` | memo.save (mutate) → 승인 게이트(§D) | "저장됨: <title>" |

### E.3 불변식 (각 도구 — 통합 no-throw / abort)
- (E-I1 abort) execute **진입 즉시** `signal.aborted` 검사 → **reject**(abort). **mutating(memo_save)** 은 mutation *직전* 재검사 → reject(취소 후 부작용 방지). **async dep(fetchWeather 등) await *직후* 재검사** → reject(취소 무시하는 dep 이 abort 후 성공 반환·검증·포맷하는 것 차단). 그 외 reject 금지.
- (E-I1b no-throw 경계) **arg 파싱·검증·dep 호출(clock/fetch/memo)·결과 포맷 전부 단일 try/catch 안**. catch 시: `signal.aborted` 면 **reject**(전파), 아니면 `{output:<msg>, isError:true}`. ⚠️ **msg 추출 자체가 fail-safe**: 임의 throw 값(예: .message getter 가 throw·toString throw 하는 객체)을 문자열화하는 과정이 또 throw 할 수 있으므로 중첩 try/catch 로 추출하고 실패 시 고정 문자열("tool error")로 폴백 — execute 가 절대 throw 하지 않음(abort 제외). ⚠️ fetch 의 AbortError 도 동일 — *AbortError 종류로 분류하지 않고* `signal.aborted` 여부로만 reject 판정(비-abort 실패는 isError). 미등록 name 도 isError.
- (E-I2 arg 검증, 읽기 전·no-throw 경계 안) **plain-object 술어** = `v!==null && typeof v==="object" && !Array.isArray(v)`. 아니면 isError. 필드 읽기는 경계 안(getter/proxy throw → catch→isError). `latitude/longitude` = **`Number.isFinite` 후** 범위(-90..90 / -180..180), 아니면 isError(NaN/Infinity 배제). `title/content` = string 필수, `timezone` = optional·**존재 시 string**(아니면 isError; 없으면 UTC).
- (E-I3 tier) memo_save=**ask**, 나머지(time/weather/memo_list/memo_get)=none. specs() 노출(§D tierOf).
- (E-I4 deps 미주입) clock/fetchWeather 미주입 시 get_time/get_weather → isError("<tool> unavailable"). memo 는 기본 in-memory 라 항상 가용(memo_* unavailable 없음). executor 생성 성공(부분 가용).
- (E-I5 결정론·포맷 고정) get_time 기본 = `clock().toISOString()`(UTC ISO, 결정론). timezone 주어지면 `Intl.DateTimeFormat("en-US", {timeZone, year:numeric, month/day:2-digit, hour/minute/second:2-digit, hourCycle:"h23", era:"short"})` 의 **`formatToParts()`** (⚠️ `era:"short"` 포함 — en-US era="AD" 검증용; 없으면 era part 부재로 전부 isError) 로 year/month/day/hour/minute/second part 를 뽑아 **직접 `YYYY-MM-DD HH:mm:ss (tz)` 조립**(locale 문자열 형식·구분자 변동 제거, hourCycle h23 로 자정 24:00:00 방지). year 는 `padStart(4,"0")`, month/day/hour/minute/second 는 `padStart(2,"0")` 로 자리수 보장. ⚠️ **연도 1..9999 CE 만 지원** — clock 연도가 아니라 **formatToParts 의 *zoned* `era` + `year` 를 검증**(tz 오프셋이 경계서 BCE/연10000 로 넘길 수 있으므로 zoned 기준): `era` part 가 CE(AD) 가 아니거나 zoned year 가 1..9999 밖이면 **isError**. 이로써 BCE/확장연도 클래스 전체를 한 지점에서 종결(현재 시각 도구엔 현실적으로 불가 → 명시적 수용 bound, era 무한 처리 회피). 유효하지 않은 tz → Intl 생성자 throw → catch → isError. clock() 반환 = 유효 Date(`!isNaN(getTime())`) 검증 후 포맷. **memo.list() = string 배열(아니면 isError), memo.get() = string|null(그 외 타입이면 isError)** 검증 후 사용. 모든 dep 동기 throw 도 catch→isError. **fetchWeather 반환 `tempC`·`code` 는 포맷 전 `Number.isFinite` 검증** — 둘 중 하나라도 비유한수면 isError(malformed 응답을 "기온 NaN°C" 로 성공처리 금지). clock/fetchWeather/memo 주입으로 테스트(라이브만 실 clock/open-meteo/store).

### E.4 검증
- 계약 테스트: (a) get_time(주입 clock) → UTC ISO; tz 주면 고정 포맷 (b) get_weather(mock fetch) → 포맷 / 비-abort fetch reject → isError / aborted signal → reject (c) memo_save→list→get 왕복(주입 store) (d) arg 누락/타입오류·배열·null → isError(throw 아님) (e) 미등록 name → isError (f) memo_save tier=ask(specs) · 읽기 tier=none (g) clock/fetchWeather 미주입 → get_time/get_weather isError; memo 미주입이어도 memo_* 정상(기본 in-memory) (h) **lat/lon = NaN/Infinity/범위밖 → isError** (i) **invalid timezone → isError**(Intl throw catch) (j) **getter throw 하는 args / 동기 throw 하는 clock·memo → isError**(no-throw 경계) (k) **이미 aborted signal 로 execute → reject**(진입 검사) (l) **memo_save: mutation 직전 abort → reject·미저장** (m) **malformed weather**(tempC/code 비유한수) → isError (n) **get_weather: fetchWeather await 직후 abort** → reject(검증/포맷 전) (o) **malformed memo 반환**(list 비배열·get 비string/null) → isError (p) **clock 무효 Date** → isError.
- 라이브(선택): GLM + get_time/memo(로컬) + get_weather(open-meteo). memo_save 는 승인 게이트.
- **codex 2-clean**: §E + makeBuiltinSkillsExecutor 코드 2연속 NONE.
