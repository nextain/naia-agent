# WO-03c 첫 엔진 next 전 취소의 interrupt 순서 보고서

- 작업 브랜치: `probe/naia-web-wo-02`
- 기준 커밋 해시: `7b2d447`

---

## 1. 고친 내용 (3절 번호별)

### 1) `callInterruptOnce` 내 `engineNextCalled` 검사 추가 (`src/main/adapters/webllm-provider.ts`)
- WebLLM 엔진은 스트림의 첫 `next()`가 호출될 때 내부 인터럽트 표시(`interruptSignal`)를 지우는 특성이 있음.
- 따라서 엔진 스트림 생성 직후 첫 `next()`가 호출되기 전(`engineNextCalled === false`) 취소가 발생했을 때 `callInterruptOnce()`가 인터럽트를 미리 호출하면, 이후 `drainStream`에서 첫 `next()`를 호출할 때 인터럽트 표시가 지워지고 `interruptCalled`가 이미 참이어서 인터럽트를 재호출하지 못하는 결함이 있었음.
- `callInterruptOnce` 내부에서 `engineNextCalled`가 거짓이면 아무 동작도 수행하지 않고 `interruptCalled` 플래그도 변경하지 않도록 수정함:
  ```ts
  const callInterruptOnce = () => {
    if (!engineNextCalled) {
      return;
    }
    if (!interruptCalled) {
      interruptCalled = true;
      try {
        void engine.interruptGenerate();
      } catch {
        // ignore
      }
    }
  };
  ```
- 이로써 첫 `next()` 전 취소 시에는 항상 `finally`의 `drainStream` 정리 경로가 담당하여 "첫 `next()` 먼저 호출, 그 다음 `interruptGenerate()` 호출" 순서를 보장함.
- `onAbortSignal` 및 기타 호출 지점(369, 397, 405줄 부근)은 변경 없이 유지함.

### 2) 정리 경로 상태 전달 확인 (`src/main/adapters/webllm-provider.ts`)
- 생성기 본문 진입 직후 첫 `next()` 전에 `opts.signal?.aborted`인 경우:
  - `callInterruptOnce()`가 아무 작업도 하지 않아 `engineNextCalled = false`, `interruptCalled = false` 상태 유지.
  - `return`으로 생성기가 종료되면서 `finally` 블록 진입.
  - `normalDone`과 `slotReleased`가 거짓이므로 `drainStream(engine, engineIt, false, false, null)`이 호출됨.
  - `drainStream`은 `nCalled = false`이므로 `it.next()`를 먼저 호출하여 엔진 본문을 시작시키고, `iCalled = false`이므로 `eng.interruptGenerate()`를 호출한 뒤 스트림이 `done`에 이를 때까지 소진하고 슬롯을 해제함.
- `createRace === ABORTED`인 경우:
  - 기존에 이미 `drainStream(engine, lateIt, false, false, null)`로 `engineNextCalled=false, interruptCalled=false`를 정상 전달하고 있음을 확인함.

### 3) 회귀 시험 추가 (`src/test/webllm-provider.contract.test.ts`)
- 시험 이름: `"create 성공 직후, 첫 next 전 취소"`
- 가짜 엔진의 `chat.completions.create` 반환 약속에 `.then(() => queueMicrotask(() => ac.abort()))` 관찰자를 연결하여, 공급자가 `await Promise.race`를 거쳐 스트림 소비 루프에 진입하기 전에 abort가 일어나도록 유도함.
- 기대값 검증:
  - 바깥으로 나온 것이 없음 (텍스트·usage·finish 0개). 바깥 이터레이터는 1초 안에 `done: true` 반환.
  - 가짜 엔진 기록상 스트림의 첫 `next()`가 `interruptGenerate`보다 먼저 호출되었고(`interruptCalls[0].streamStarted === true`), `interruptGenerate`는 정확히 1회 호출됨.
  - 가짜 엔진 스트림의 `finishReason`이 `"abort"`로 정상 종료됨.
  - 해당 스트림이 1초 안에 `reachedDone`에 도달하고 잠금이 해제됨.
  - 동일 공급자의 후속 요청이 1초 안에 정확한 출력 배열(`EXPECTED_FULL_CHUNKS`: 가, 나, 다, usage 3/5, finish)을 수신함.
  - 공통 정리 단언 함수 `assertCancelledCleanup(engine, 1)` 호출로 잠금 해제, 엔진 스트림 `return()`/`throw()` 0회 검증.

---

## 2. 고치기 전 실패 출력

수정 전 코드(`src/main/adapters/webllm-provider.ts` 미수정 상태)에서 새로 추가한 회귀 시험 실행 결과:

```
 ❯ src/test/webllm-provider.contract.test.ts (20)
   ❯ WebLLM 공급자 어댑터 계약 시험 (FE-08) (20)
     ✓ 스트리밍: 가, 나, 다 내용 조각 및 usage 조각 후 finish 순서 확인
     ✓ 요청 모양: systemPrompt와 system 메시지 결합 및 config.model 무시 확인
     ✓ 생각 끄기: Qwen3 모델에서 enableThinking 설정 및 비-Qwen3/미지정 시 제외
     ✓ 첫 조각 뒤 취소: 첫 조각 수신 후 abort 시 즉시 종료 및 잠금 해제
     ✓ 취소 후 같은 엔진 두 번째 요청 성공
     ✓ 첫 조각 전 취소: 스트림 본문 시작 후 표시 지운 뒤 interruptGenerate 호출 및 다음 요청 성공
     ✓ create() 대기 중 취소: 늦게 돌아온 스트림 백그라운드 소진 및 다음 요청 성공
     ✓ 대기 요청 취소가 활성 생성을 끊지 않음
     ✓ 소비자 return(): yield에 멈춘 상태에서 return() 호출 시 즉시 완료 및 백그라운드 소진
     ✓ ChatTurnHandler 식 취소: next() 대기 중 abort 후 return() 동시 호출
     ✓ 엔진 준비 중 취소: getEngine 미해결 약속 상태에서 abort 및 슬롯 인계
     ✓ 시작 전 취소: 이미 끊긴 신호 전달 시 즉시 종료 및 getEngine 미호출
     ✓ 오류 매핑 세 가지: getEngine 실패, create 실패, 스트림 읽기 중 실패
     ✓ 지원하지 않는 메시지: tool role, toolCalls, inlineImages 각각 거부
     ✓ 경로 해석: resolveProviderRoute, makeProviderResolver 주입 및 미주입 거부
     ✓ 브라우저 조립 루트를 거치는 끝단 통합 시험
     ✓ finish 뒤 추가 next 없이 다음 요청: 슬롯이 풀려 둘째 요청 성공
     ✓ 버려진 이전 요청의 신호: finish 후 방치된 이터레이터의 신호 A가 나중에 abort 되어도 둘째 요청에 무영향
     ✓ 한 조각에 content 와 usage: text 수신 직후 abort 시 다음 next()에서 usage가 나오지 않고 done: true
     × create 성공 직후, 첫 next 전 취소

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/test/webllm-provider.contract.test.ts > WebLLM 공급자 어댑터 계약 시험 (FE-08) > create 성공 직후, 첫 next 전 취소
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ src/test/webllm-provider.contract.test.ts:1070:52
    1068| 
    1069|     expect(engine.interruptCalls.length).toBe(1);
    1070|     expect(engine.interruptCalls[0].streamStarted).toBe(true);
       |                                                    ^
    1071|     expect(engine.streams[0].finishReason).toBe("abort");
    1072| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 19 passed (20)
   Start at  21:39:49
   Duration  644ms (transform 217ms, setup 0ms, collect 272ms, tests 111ms, environment 0ms, prepare 76ms)
```

고치기 전에는 `streamStarted`가 `false`인 상태에서 `interruptGenerate()`가 먼저 호출되어 단언 실패가 발생함을 확인하였음.

---

## 3. 4절 판정 명령과 출력

### 1) 계약 시험 및 브라우저 경계 시험
명령:
```bash
pnpm vitest run src/test/webllm-provider.contract.test.ts src/test/browser-boundary.contract.test.ts; echo "exit=$?"
```
출력 끝 20줄:
```
 ✓ src/test/browser-boundary.contract.test.ts (42)
 ❯ src/test/webllm-provider.contract.test.ts (20)
   ❯ WebLLM 공급자 어댑터 계약 시험 (FE-08) (20)
     ✓ 스트리밍: 가, 나, 다 내용 조각 및 usage 조각 후 finish 순서 확인
     ✓ 요청 모양: systemPrompt와 system 메시지 결합 및 config.model 무시 확인
     ✓ 생각 끄기: Qwen3 모델에서 enableThinking 설정 및 비-Qwen3/미지정 시 제외
     ✓ 첫 조각 뒤 취소: 첫 조각 수신 후 abort 시 즉시 종료 및 잠금 해제
     ✓ 취소 후 같은 엔진 두 번째 요청 성공
     ✓ 첫 조각 전 취소: 스트림 본문 시작 후 표시 지운 뒤 interruptGenerate 호출 및 다음 요청 성공
     ✓ create() 대기 중 취소: 늦게 돌아온 스트림 백그라운드 소진 및 다음 요청 성공
     ✓ 대기 요청 취소가 활성 생성을 끊지 않음
     ✓ 소비자 return(): yield에 멈춘 상태에서 return() 호출 시 즉시 완료 및 백그라운드 소진
     ✓ ChatTurnHandler 식 취소: next() 대기 중 abort 후 return() 동시 호출
     ✓ 엔진 준비 중 취소: getEngine 미해결 약속 상태에서 abort 및 슬롯 인계
     ✓ 시작 전 취소: 이미 끊긴 신호 전달 시 즉시 종료 및 getEngine 미호출
     ✓ 오류 매핑 세 가지: getEngine 실패, create 실패, 스트림 읽기 중 실패
     ✓ 지원하지 않는 메시지: tool role, toolCalls, inlineImages 각각 거부
     ✓ 경로 해석: resolveProviderRoute, makeProviderResolver 주입 및 미주입 거부
 ✓ src/test/browser-boundary.contract.test.ts (42)
 ✓ src/test/webllm-provider.contract.test.ts (20)
 ✓ src/test/browser-boundary.contract.test.ts (42)
 ✓ src/test/browser-boundary.contract.test.ts (42)
 ✓ src/test/webllm-provider.contract.test.ts (20)

 Test Files  2 passed (2)
      Tests  62 passed (62)
   Start at  21:40:29
   Duration  596ms (transform 264ms, setup 0ms, collect 633ms, tests 114ms, environment 0ms, prepare 89ms)

exit=0
```

### 2) 계약 시험 5회 반복
명령:
```bash
for i in 1 2 3 4 5; do pnpm vitest run src/test/webllm-provider.contract.test.ts > /tmp/wo03c-rep-$i.log 2>&1; echo "rep$i exit=$?"; done
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
pnpm test > /tmp/wo03c-test.log 2>&1; echo "test exit=$?"
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
      Tests  25 failed | 2152 passed | 11 skipped (2188)
     Errors  2 errors
   Start at  21:40:57
   Duration  72.97s (transform 18.35s, setup 0ms, collect 60.71s, tests 236.01s, environment 34ms, prepare 13.47s)

 ELIFECYCLE  Test failed. See above for more details.
```

### 5) 결과 요약 및 집계
명령:
```bash
grep -E "^ (Test Files|     Tests|    Errors) " /tmp/wo03c-test.log
grep -E "^ FAIL " /tmp/wo03c-test.log | sort -u > /tmp/wo03c-fail.txt
B=/var/home/luke/alpha-adk/.agents/progress/naia-web-20261003/agent-baseline-failures-3b0e101c.txt
comm -13 $B /tmp/wo03c-fail.txt; echo "new-fail-lines=$(comm -13 $B /tmp/wo03c-fail.txt | wc -l)"
comm -23 $B /tmp/wo03c-fail.txt
awk '/^⎯+ (Unhandled [A-Za-z]+|Uncaught Exception) ⎯+$/{getline; split($0,a,":"); cls=a[1]} /^This error originated in /{match($0,/"[^"]+"/); print cls" "substr($0,RSTART,RLENGTH)}' /tmp/wo03c-test.log | sort > /tmp/wo03c-errors.txt; echo "awk=$?"; cat /tmp/wo03c-errors.txt
```
출력:
```
 Test Files  5 failed | 172 passed | 3 skipped (180)
      Tests  25 failed | 2152 passed | 11 skipped (2188)
     Errors  2 errors
new-fail-lines=0
awk=0
AssertionError "src/test/uc-naia-pi-cli-process.integration.test.ts"
SyntaxError "src/test/uc-naia-pi-controlled.integration.test.ts"
```

(참고: 전체 시험 로그 중 기준선 실패에서 나타나는 키 문자열 `gw-***` 마스킹: `AssertionError: expected 'Bearer gw-***' to be 'Bearer stored-test-key'`)

---

## 4. 막힌 곳과 이유

- 특별히 막힌 부분 없이 순조롭게 진행됨.
- 회귀 시험에서 `chat.completions.create`가 반환하는 promise에 `.then(() => queueMicrotask(() => ac.abort()))` 관찰자를 부착하여 공급자가 `await Promise.race`를 재개하기 직전에 정확히 abort가 트리거되도록 구성하였고, 수정 전 코드에서 기대대로 정확히 실패(reproduction)함을 확인한 뒤 수정 작업을 진행함.
