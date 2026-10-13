# WO-03b WebLLM 공급자 취소 결함과 시험 보강 보고서

- 커밋 해시: `7b2d447`
## 1. 고친 내용 (2절 번호별)

### 1. 슬롯 해제 시점 (`src/main/adapters/webllm-provider.ts`)
- 엔진 스트림이 `done`에 도달한 순간, `yield { kind: "finish" }`를 내보내기 전에 다음 순서로 처리하도록 변경함:
  1. `removeAllAbortListeners()`: 이 요청의 abort 이벤트 리스너(`removeAbortListener()`, `opts.signal.removeEventListener("abort", onAbortSignal)`)를 모두 제거하여, 이후 이터레이터가 버려진 뒤 신호가 나중에 취소되더라도 공유 엔진에 `interruptGenerate()`를 부르지 않도록 함.
  2. `releaseSlotOnce()`: 슬롯을 즉시 해제하여 다음 대기 요청이 슬롯을 얻을 수 있도록 함.
  3. `if (opts.signal?.aborted) return;`: 취소 여부를 재확인하고, 취소되지 않은 경우에만 `yield { kind: "finish" };` 내보냄.
- 리스너 제거(`abortListenersRemoved`)와 슬롯 해제(`slotReleased`)는 플래그로 멱등성을 보장하여 각각 한 번만 실행되며, `finally` 블록에서 중복 실행되지 않도록 함.
- 취소 뒤 백그라운드 소진(`drainStream`)하는 동안에는 기존과 동일하게 `done`까지 슬롯을 쥐고 있다가 소진 완료 시 `releaseSlotOnce()`로 슬롯을 해제함.

### 2. 취소 뒤 추가 출력 (`src/main/adapters/webllm-provider.ts`)
- 엔진 조각 하나에 `content`와 `usage`가 함께 포함되어 있을 때, 소비자가 `text`를 받은 직후 abort하고 `next()`를 호출하면 `usage`가 추가로 방출되던 결함을 수정함.
- 외부로 청크를 내보내는 모든 지점(`text` yield 직전, `usage` yield 직전, `finish` yield 직전)마다 `if (opts.signal?.aborted)`를 확인하고, 취소된 경우 즉시 `callInterruptOnce()` 및 `return`하여 `finally`의 정리(`drainStream`) 경로로 이동하게 함.

### 3. 가짜 엔진의 끊기 확인 시점 (`src/test/webllm-provider.contract.test.ts`)
- 실제 WebLLM 엔진 동작과 일치하도록, 내용 조각을 `yield chunk`한 뒤에 `interruptSignal` 여부를 검사하도록 수정함.
- `FakeStreamRecord`에 `emittedChunks: WebLLMChatChunk[]`를 추가하여 가짜 엔진이 실제로 생성하여 방출한 모든 청크를 기록함.
- "첫 조각 전 취소" 시험에서 가짜 엔진이 첫 내용 조각("가")을 실제로 방출했음을 `expect(engine.streams[0].emittedChunks.some((c) => c.choices[0]?.delta?.content === "가")).toBe(true)`로 단언하고, 외부 소비자는 아무 조각도 받지 못했음(`res.done === true`)을 단언함.

### 4. 고정 지연 제거 (`src/test/webllm-provider.contract.test.ts`)
- 시험 코드의 고정 `setTimeout` 지연(354, 418, 457, 465, 551, 589줄 부근)을 제거함.
- `FakeWebLLMEngine`에 상태 약속을 추가함:
  - `createEntered`: `chat.completions.create` 진입 시점에 풂.
  - `bodyStarted`: 스트림 본문 첫 실행에서 엔진이 끊기 표시를 지운 직후(`interruptSignal = false`)에 풂.
  - `reachedDone`: 스트림의 마지막 yield 뒤 잠금 해제와 기록 갱신을 마친 시점에 풂.
- 상태 약속은 스트림 요청마다 새로 생성되며, 시험에서는 `withTimeout(promise, 1000, debugInfo)`(1초 제한 `Promise.race`)으로 대기함.
- 단, 원 지시서가 요구한 "엔진 준비 중 취소" 시험의 50ms 대기 후 abort는 그대로 유지함.

### 5. 기대값과 제한 시간 (`src/test/webllm-provider.contract.test.ts`)
- 후속 요청의 성공 단언을 단순 조각 개수가 아닌 정확한 출력 배열(`EXPECTED_FULL_CHUNKS`: text "가", "나", "다", usage 3/5, finish)과 일치하는지 `toEqual`로 검증함.
- 후속 요청 수집 및 상태 약속 대기에 모두 1초 제한(`withTimeout`)을 적용함.
- 모든 취소 시험 끝에 공통 단언 함수 `assertCancelledCleanup(engine, expectedInterruptCalls)`을 호출하여 잠금 해제 여부, `return()` 0회, `throw()` 0회, 그리고 기대한 `interruptGenerate` 호출 횟수를 검증함.

### 6. 타입 우회 제거 (`src/test/webllm-provider.contract.test.ts`)
- 701줄 부근의 `as unknown as ChatMessage`를 제거하고, `ChatMessage` 타입 정의에 부합하는 `[{ role: "tool", content: "res" }]`를 직접 전달함.
- 새로운 `as unknown as`, `as any`, `@ts-ignore`, `@ts-expect-error`를 추가하지 않음.

### 새 시험 3건 추가 (`src/test/webllm-provider.contract.test.ts`)
1. `finish 뒤 추가 next 없이 다음 요청: 슬롯이 풀려 둘째 요청 성공`: 첫 요청에서 `finish`까지만 받고 이터레이터를 방치(`next()`/`return()` 미호출)한 뒤, 같은 공급자로 둘째 요청을 보내어 1초 안에 정확한 출력 배열을 수신함.
2. `버려진 이전 요청의 신호: finish 후 방치된 이터레이터의 신호 A가 나중에 abort 되어도 둘째 요청에 무영향`: 첫 요청 신호 A로 `finish`까지 받고 방치한 후, 둘째 요청 신호 B로 첫 `text`를 받은 시점에 신호 A를 abort해도 `interruptGenerate`가 0회이고 둘째 요청이 정상 완료됨.
3. `한 조각에 content 와 usage: text 수신 직후 abort 시 다음 next()에서 usage가 나오지 않고 done: true`: 가짜 엔진이 `content`와 `usage`를 한 조각에 담아 보낼 때, 소비자가 `text`를 받은 직후 abort하고 `next()`를 호출하면 `usage` 없이 `done: true`로 끝나며 외부로 나온 청크는 `text` 하나뿐임을 검증함.

---

## 2. 3절 명령과 출력

### 1) 계약 시험 및 브라우저 경계 시험
명령:
```bash
pnpm vitest run src/test/webllm-provider.contract.test.ts src/test/browser-boundary.contract.test.ts; echo "exit=$?"
```
출력:
```
 ✓ src/test/webllm-provider.contract.test.ts (19)
 ✓ src/test/webllm-provider.contract.test.ts (19)
 · src/test/browser-boundary.contract.test.ts (42)
 ✓ src/test/webllm-provider.contract.test.ts (19)
 ✓ src/test/browser-boundary.contract.test.ts (42)
 ✓ src/test/browser-boundary.contract.test.ts (42)
 ✓ src/test/webllm-provider.contract.test.ts (19)

 Test Files  2 passed (2)
      Tests  61 passed (61)
   Start at  21:20:32
   Duration  1.73s (transform 589ms, setup 0ms, collect 2.03s, tests 173ms, environment 0ms, prepare 373ms)

exit=0
```

### 2) 계약 시험 5회 반복
명령:
```bash
for i in 1 2 3 4 5; do pnpm vitest run src/test/webllm-provider.contract.test.ts > /tmp/wo03b-rep-$i.log 2>&1; echo "rep$i exit=$?"; done
```
출력:
```
rep1 exit=0
rep2 exit=0
rep3 exit=0
rep4 exit=0
rep5 exit=0
```

### 3) TypeScript 타입 검사
명령:
```bash
npx tsc --noEmit -p .; echo "exit=$?"
```
출력:
```
exit=0
```

### 4) 전체 시험
명령:
```bash
pnpm test > /tmp/wo03b-test.log 2>&1; echo "test exit=$?"
```
출력:
```
test exit=1
```
출력 끝 20줄:
```
       |                                           ^
     41|       res.writeHead(200, { "Content-Type": "application/json" });
     42|       res.end(JSON.stringify({
 ❯ IncomingMessage.emit node:events:514:20
 ❯ endReadableNT node:internal/streams/readable:1772:12
 ❯ processTicksAndRejections node:internal/process/task_queues:90:21

This error originated in "src/test/uc-naia-pi-cli-process.integration.test.ts" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.
The latest test that might've caused the error is "reuses isolated-home login and produces equivalent direct/parent JSON evidence". It might mean one of the following:
- The error was thrown, while Vitest was running this test.
- If the error occurred after the test had been completed, this was the last documented test before it was thrown.
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 Test Files  5 failed | 172 passed | 3 skipped (180)
      Tests  25 failed | 2151 passed | 11 skipped (2187)
     Errors  2 errors
   Start at  21:21:29
   Duration  76.88s (transform 47.58s, setup 0ms, collect 138.89s, tests 211.53s, environment 64ms, prepare 20.81s)

 ELIFECYCLE  Test failed. See above for more details.
```

### 5) 결과 요약 및 실패 집계
명령:
```bash
grep -E "^ (Test Files|     Tests|    Errors) " /tmp/wo03b-test.log
grep -E "^ FAIL " /tmp/wo03b-test.log | sort -u > /tmp/wo03b-fail.txt
B=/var/home/luke/alpha-adk/.agents/progress/naia-web-20261003/agent-baseline-failures-3b0e101c.txt
comm -13 $B /tmp/wo03b-fail.txt; echo "new-fail-lines=$(comm -13 $B /tmp/wo03b-fail.txt | wc -l)"
comm -23 $B /tmp/wo03b-fail.txt
awk '/^⎯+ (Unhandled [A-Za-z]+|Uncaught Exception) ⎯+$/{getline; split($0,a,":"); cls=a[1]} /^This error originated in /{match($0,/"[^"]+"/); print cls" "substr($0,RSTART,RLENGTH)}' /tmp/wo03b-test.log | sort > /tmp/wo03b-errors.txt; echo "awk=$?"; cat /tmp/wo03b-errors.txt
```
출력:
```
 Test Files  5 failed | 172 passed | 3 skipped (180)
      Tests  25 failed | 2151 passed | 11 skipped (2187)
     Errors  2 errors
new-fail-lines=0
awk=0
AssertionError "src/test/uc-naia-pi-cli-process.integration.test.ts"
SyntaxError "src/test/uc-naia-pi-controlled.integration.test.ts"
```

(참고: `grep 'gw-' /tmp/wo03b-test.log` 검색 시 기준선 실패 중 키 문자열 `gw-***` 마스킹됨: `AssertionError: expected 'Bearer gw-***' to be 'Bearer stored-test-key'`)

---

## 3. 막힌 곳과 이유

1. 초기 `FakeStreamRecord` 타입 선언 시 기존 불리언 플래그 `reachedDone: boolean;`과 상태 약속 프로퍼티의 이름이 중복 선언되어 `npx tsc`에서 `TS2300: Duplicate identifier 'reachedDone'` 에러(exit=2)가 발생함.
   - 상태 약속은 `FakeWebLLMEngine`에 `createEntered`, `bodyStarted`, `reachedDone`으로 제공되고, 레코드에는 `reachedDonePromise`로 구분하여 명명함으로써 불리언 상태 `record.reachedDone`과 공존하도록 정리함.
   - 수정 후 `npx tsc --noEmit -p .`는 정상 `exit=0`으로 종료됨.
