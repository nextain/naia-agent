3189e3f61b732610c3cd5fff60a77c7d87c0d4b6
수용: 충족

# WO-07: 브라우저 조립 루트에 페르소나·워크스페이스 포트 넣기 보고서

- 작업 브랜치: `probe/naia-web-wo-02`
- 기준 커밋 해시: `5af5cf401b96748babfe9e977c65ab20fda18ccb` (WO-03c 커밋)
- 커밋 해시: `3189e3f61b732610c3cd5fff60a77c7d87c0d4b6`
- 커밋 메시지: `feat(browser): accept persona and workspace context ports in browser agent (#156)`

---

## 1. 작업 환경 및 시작 전 상태 확인

- 시작 전 `git log -1 --format=%H`: `5af5cf401b96748babfe9e977c65ab20fda18ccb` (일치)
- 시작 전 `git status --porcelain -- src`: 비어 있음 (일치)

---

## 2. 변경 내용

### 1) 브라우저 조립 루트 수정 (`src/main/composition/browser-agent.ts`)
- `startBrowserAgent(opts)` 의 인자 인터페이스에 `personaSource?: PersonaSourcePort`, `workspaceContext?: WorkspaceContextPort` 추가 (형은 `../ports/uc1.js`).
- `wireAgentUC1` 호출 시 provider와 동일한 조건부 전개 패턴으로 주입:
  ```ts
  ...(opts.personaSource !== undefined ? { personaSource: opts.personaSource } : {}),
  ...(opts.workspaceContext !== undefined ? { workspaceContext: opts.workspaceContext } : {}),
  ```
- 셸 Worker(WO-09)가 `@nextain/agent-core/...` 내부 경로를 직접 import하지 않고 브라우저 진입점만 쓸 수 있도록 파일 끝에 저장소 생성 함수와 형 다시 내보내기 추가:
  - `makePersonaSourceStore`, `type PersonaFsRead` (`../adapters/persona-source-store.js`)
  - `makeWorkspaceContextStore`, `type WorkspaceFsRead`, `type WorkspaceDirent` (`../adapters/workspace-context-store.js`)
  - `type PersonaSourcePort`, `type WorkspaceContextPort` (`../ports/uc1.js`)

### 2) 통합 시험 추가 (`src/test/browser-agent.integration.test.ts`)
- `describe("browser-agent 워크스페이스 포트 (FE-16)")` 블록 및 시험 4건 추가:
  - **시험 1**: `"두 포트를 넘기면 systemPrompt 에 페르소나와 워크스페이스가 들어간다"`
    - 가짜 fs 및 기록용 fake provider 구성 후 두 포트를 주입하여 `startBrowserAgent` 실행.
    - 단일 `chat_request` 전송 후 기록된 `systemPrompt`가 정확히 1개이고 `FE16-PERSONA-MARK`, `루미`, `Workspace root: /adk`, `Entrypoint: AGENTS.md`, `Projects (1): proj-a` 가 모두 포함되며 페르소나 표지가 `## Workspace` 보다 앞서는 것을 검증.
  - **시험 2**: `"페르소나를 바꾸면 다음 턴에 반영된다"`
    - 동일 Agent 인스턴스를 유지한 상태에서 턴 1 완료 후 가짜 fs의 `config.json`을 `FE16-PERSONA-MARK-2`로 교체.
    - 두 번째 `chat_request`를 전송하여 두 번째 `systemPrompt`에 `FE16-PERSONA-MARK-2`가 반영됨을 검증.
  - **시험 3**: `"포트가 없으면 systemPrompt 가 없다"`
    - 포트 없이 `startBrowserAgent`를 띄우고 `chat_request` 전송 시 기록된 `systemPrompt`가 `undefined`임을 검증(무회귀).
  - **시험 4**: `"이름만 바꾸면 지금은 본문 이름이 바뀌지 않는다(현행 동작 고정)"`
    - config.json에 `persona`가 `"You are Naia, an AI companion. Speak casually and warmly."`이고 `agentName`이 `"루미"`일 때, `composePersonaPrompt`의 이름 치환 규칙(Naia (낸)/Nan 치환)에 따라 본문 이름이 바뀌지 않아 `systemPrompt`에 `You are Naia, an AI companion.`이 포함되고 `루미`는 없음을 고정.
- 타입 우회(`as unknown as`, `as any`, `@ts-ignore`, `@ts-expect-error`) 없이 완전한 타입 정의로 구현.

---

## 3. 판정 명령 실행 결과

### 1) 시작 전 기준값 측정

명령:
```bash
pnpm test > /tmp/wo07-test-before.log 2>&1; echo "test exit=$?"
grep -E "^ (Test Files|     Tests|    Errors) " /tmp/wo07-test-before.log
grep -E "^ FAIL " /tmp/wo07-test-before.log | sort -u > /tmp/wo07-fail-before.txt; wc -l < /tmp/wo07-fail-before.txt
```

출력:
```
test exit=1
 Test Files  5 failed | 172 passed | 3 skipped (180)
      Tests  25 failed | 2152 passed | 11 skipped (2188)
     Errors  2 errors
25
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
   Start at  08:44:35
   Duration  71.87s (transform 9.92s, setup 0ms, collect 31.97s, tests 183.64s, environment 29ms, prepare 9.58s)

 ELIFECYCLE  Test failed. See above for more details.
```

---

### 2) 변경 후 판정 명령

#### (1) 브라우저 에이전트 통합 시험 및 경계 계약 시험
명령:
```bash
pnpm vitest run --reporter=verbose src/test/browser-agent.integration.test.ts src/test/browser-boundary.contract.test.ts; echo "exit=$?"
```

출력 끝 20줄:
```
 ✓ src/test/browser-boundary.contract.test.ts > browser-boundary 계약 — 브라우저 번들 런타임 순수성 (FE-05) > browser-agent 에서 도달 가능한 파일 목록에 webllm-provider.ts 가 포함된다
 ✓ src/test/browser-boundary.contract.test.ts > browser-boundary 계약 — 브라우저 번들 런타임 순수성 (FE-05) > 도달 가능한 모든 파일에서 node: / Node 내장 / 외부 패키지 import 가 0건이다
 ✓ src/test/browser-agent.integration.test.ts > browser-agent 통합 시험 (FE-05/FE-06) > 정상 요청 처리, 깨진 JSON 뒤 복구, stop() 뒤 줄 차단 525ms
 ✓ src/test/browser-agent.integration.test.ts > browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 취소: cancel_stream 전송 시 종결 줄 도착 및 이후 줄 차단 325ms
 ✓ src/test/browser-agent.integration.test.ts > browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 정지: partial 수신 후 stop() 시 late 텍스트 및 finish 모두 차단 511ms
 ✓ src/test/browser-agent.integration.test.ts > browser-agent 워크스페이스 포트 (FE-16) > 두 포트를 넘기면 systemPrompt 에 페르소나와 워크스페이스가 들어간다
 ✓ src/test/browser-agent.integration.test.ts > browser-agent 워크스페이스 포트 (FE-16) > 페르소나를 바꾸면 다음 턴에 반영된다
 ✓ src/test/browser-agent.integration.test.ts > browser-agent 워크스페이스 포트 (FE-16) > 포트가 없으면 systemPrompt 가 없다
 ✓ src/test/browser-agent.integration.test.ts > browser-agent 워크스페이스 포트 (FE-16) > 이름만 바꾸면 지금은 본문 이름이 바뀌지 않는다(현행 동작 고정)

 Test Files  2 passed (2)
      Tests  49 passed (49)
   Start at  08:50:07
   Duration  1.80s (transform 188ms, setup 0ms, collect 476ms, tests 1.43s, environment 0ms, prepare 72ms)

exit=0
```

#### (2) 반복 3회 실행
명령:
```bash
for i in 1 2 3; do pnpm vitest run src/test/browser-agent.integration.test.ts > /tmp/wo07-rep-$i.log 2>&1; echo "rep$i exit=$?"; done
```

출력:
```
rep1 exit=0
rep2 exit=0
rep3 exit=0
```

각 반복 로그 끝 20줄:
```
[rep1]
 RUN  v2.1.9 /var/home/luke/alpha-adk/projects/naia-web-probe/naia-agent

 ✓ src/test/browser-agent.integration.test.ts (7 tests) 1425ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 정상 요청 처리, 깨진 JSON 뒤 복구, stop() 뒤 줄 차단 528ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 취소: cancel_stream 전송 시 종결 줄 도착 및 이후 줄 차단 325ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 정지: partial 수신 후 stop() 시 late 텍스트 및 finish 모두 차단 513ms

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  08:47:40
   Duration  1.89s (transform 239ms, setup 0ms, collect 281ms, tests 1.42s, environment 0ms, prepare 39ms)

[rep2]
 RUN  v2.1.9 /var/home/luke/alpha-adk/projects/naia-web-probe/naia-agent

 ✓ src/test/browser-agent.integration.test.ts (7 tests) 1429ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 정상 요청 처리, 깨진 JSON 뒤 복구, stop() 뒤 줄 차단 529ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 취소: cancel_stream 전송 시 종결 줄 도착 및 이후 줄 차단 325ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 정지: partial 수신 후 stop() 시 late 텍스트 및 finish 모두 차단 513ms

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  08:47:42
   Duration  1.82s (transform 165ms, setup 0ms, collect 199ms, tests 1.43s, environment 0ms, prepare 60ms)

[rep3]
 RUN  v2.1.9 /var/home/luke/alpha-adk/projects/naia-web-probe/naia-agent

 ✓ src/test/browser-agent.integration.test.ts (7 tests) 1420ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 정상 요청 처리, 깨진 JSON 뒤 복구, stop() 뒤 줄 차단 529ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 취소: cancel_stream 전송 시 종결 줄 도착 및 이후 줄 차단 324ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 정지: partial 수신 후 stop() 시 late 텍스트 및 finish 모두 차단 512ms

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  08:47:44
   Duration  1.82s (transform 168ms, setup 0ms, collect 198ms, tests 1.42s, environment 0ms, prepare 47ms)
```

#### (3) tsc 타입 점검
명령:
```bash
npx tsc --noEmit -p .; echo "exit=$?"
```

출력:
```
exit=0
```

#### (4) 빌드
명령:
```bash
pnpm build; echo "build exit=$?"
```

출력:
```
> @nextain/naia-agent@0.0.0 build /var/home/luke/alpha-adk/projects/naia-web-probe/naia-agent
> tsc -p tsconfig.json

build exit=0
```

#### (5) dist 내 재내보내기 심볼 확인
명령:
```bash
grep -c "makePersonaSourceStore\|makeWorkspaceContextStore" dist/main/composition/browser-agent.js; echo "grep exit=$?"
```

출력:
```
2
grep exit=0
```

#### (6) 전체 시험
명령:
```bash
pnpm test > /tmp/wo07-test.log 2>&1; echo "test exit=$?"
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
      Tests  25 failed | 2156 passed | 11 skipped (2192)
     Errors  2 errors
   Start at  08:48:08
   Duration  71.80s (transform 9.83s, setup 0ms, collect 30.85s, tests 183.93s, environment 30ms, prepare 9.61s)

 ELIFECYCLE  Test failed. See above for more details.
```

(참고: 기준선 실패 로그 내 키 문자열 `gw-***` 마스킹: `AssertionError: expected 'Bearer gw-***' to be 'Bearer stored-test-key'`)

#### (7) 시험 집계 및 실패 라인 diff
명령:
```bash
grep -E "^ (Test Files|     Tests|    Errors) " /tmp/wo07-test.log
grep -E "^ FAIL " /tmp/wo07-test.log | sort -u > /tmp/wo07-fail.txt
comm -13 /tmp/wo07-fail-before.txt /tmp/wo07-fail.txt; echo "new-fail-lines=$(comm -13 /tmp/wo07-fail-before.txt /tmp/wo07-fail.txt | wc -l)"
```

출력:
```
 Test Files  5 failed | 172 passed | 3 skipped (180)
      Tests  25 failed | 2156 passed | 11 skipped (2192)
     Errors  2 errors
new-fail-lines=0
```

#### (8) git status 확인
명령:
```bash
git status --porcelain
```

출력:
```
?? .agents/progress/naia-web-wo-02b-report.md
?? .agents/progress/naia-web-wo-03-report.md
?? .agents/progress/naia-web-wo-03b-report.md
?? .agents/progress/naia-web-wo-03c-report.md
?? .agents/session-contracts/.recovery/
```

---

## 4. 판정 조건 충족 대조표

| 항목 | 조건 | 결과 | 판정 |
|---|---|---|---|
| 첫 명령 (vitest) | exit=0, 새 시험 4개 이름 노출 | exit=0, 시험 4건 정상 통과 | 충족 |
| 반복 3회 (rep 1~3) | 3회 모두 exit=0 | rep1, rep2, rep3 모두 exit=0 | 충족 |
| 타입 점검 (tsc) | exit=0 | exit=0 | 충족 |
| 빌드 (pnpm build) | exit=0 | exit=0 | 충족 |
| 재내보내기 grep | grep-c >= 1, grep exit=0 | 2개 검출, grep exit=0 | 충족 |
| 전체 시험 failed | 기준값(25)과 동일 | 25 failed (동일) | 충족 |
| 전체 시험 passed | 기준값(2152) + 4 = 2156 | 2156 passed (정확히 +4) | 충족 |
| 전체 시험 Errors | 기준값(2)과 동일 | 2 errors (동일) | 충족 |
| 신규 실패 파일 | new-fail-lines = 0 | new-fail-lines=0 | 충족 |
| git status | 허용 파일 및 미추적 보고 파일만 존재 | 커밋 완료 후 추적 파일 없음 | 충족 |
| 타입 우회 | `as unknown as`, `as any`, `@ts-ignore`, `@ts-expect-error` 없음 | 없음 | 충족 |

---

## 5. 막힌 곳과 이유

- 특이사항이나 막힌 곳 없이 순조롭게 진행되었습니다.
- 브라우저 경계 계약 시험(`browser-boundary.contract.test.ts`)의 순수성 검증 통과(위반 0건) 및 신규 추가된 4건의 통합 시험 모두 안정적으로 통과하였습니다.
