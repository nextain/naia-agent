수용: 충족

## 1. 커밋 정보
- 커밋 해시: `0b3c1d1e0cdef2ca1d7413241cc01ffed9c23ec8`
- 커밋 메시지: `fix(browser): send web model think blocks as thinking chunks, never as text (#156)`
- 캐시 스테이징 확인 (`git diff --cached --name-only`):
  ```
  src/main/adapters/webllm-provider.ts
  src/test/browser-agent.integration.test.ts
  src/test/webllm-provider.contract.test.ts
  ```

---

## 2. 1-1 규칙별 코드 위치

- **규칙 1 (구문으로서의 `<think>`·`</think>` 는 text·thinking 조각에 미발행, toolUse 인자 유지)**:
  - 파일: `src/main/adapters/webllm-provider.ts` (250–258행, 281–289행)
  - 내용: `WebLLMStreamParser.feed()`에서 `<think>` 및 `</think>` 태그 길이를 더해 `pendingBuffer`에서 슬라이스하여 버리고 조각으로 내보내지 않음. 도구 인자는 기존 `parseCapturedCalls` 로직 유지.
- **규칙 2 (생각 블록 안은 `{ kind: "thinking", text }`, 밖은 `{ kind: "text" }`)**:
  - 파일: `src/main/adapters/webllm-provider.ts` (217–230행, 246행, 278행)
  - 내용: `!inThinking` 구간은 `{ kind: "text", text }` 발행, `inThinking` 구간은 `emitThinking()`을 통해 `{ kind: "thinking", text }` 발행.
- **규칙 3 (공백만 있는 생각 블록은 조각 미발행, 첫 비공백 문자 등장 시까지 모아서 일괄 발행)**:
  - 파일: `src/main/adapters/webllm-provider.ts` (221–229행)
  - 내용: `emitThinking()`에서 `this.thinkEmitted`가 false인 동안 `this.thinkWhitespaceBuffer`에 공백 누적 후 `/^\s*$/.test(combined)`가 false가 되는 첫 비공백 문자 등장 시 누적된 공백과 함께 thinking 조각 발행. 이후 문자는 오는 대로 즉시 발행.
- **규칙 4 (생각 블록 안 `<tool_call>`은 생각 글로 취급, 중첩 `<think>`는 버림)**:
  - 파일: `src/main/adapters/webllm-provider.ts` (268–289행)
  - 내용: `inThinking === true` 상태에서는 `<tool_call>`을 태그 후보로 검색하지 않아 thinking 글자로 처리되고, 중첩 `<think>`는 `this.pendingBuffer.slice(first.pos + first.len)`으로 글자째 버려짐.
- **규칙 5 (생각 블록 밖에서 나온 `</think>`는 버림)**:
  - 파일: `src/main/adapters/webllm-provider.ts` (255–258행)
  - 내용: `!inThinking` 상태에서 `close_think` 후보 감지 시 `this.pendingBuffer.slice(first.pos + first.len)`으로 글자째 버려짐.
- **규칙 6 (스트림이 생각 블록 안에서 끝날 때 공백 아닌 모은 글만 thinking 발행)**:
  - 파일: `src/main/adapters/webllm-provider.ts` (324–334행)
  - 내용: `WebLLMStreamParser.flush()`에서 `inThinking === true`일 때 `this.pendingBuffer`를 `emitThinking()`으로 넘겨 공백만 남은 경우는 발행하지 않고 소멸.
- **규칙 7 (부분 태그 보류 findTrailingPartialTag, 도구 포착·파싱·취소·usage 유지)**:
  - 파일: `src/main/adapters/webllm-provider.ts` (260–267행, 292–300행, 748–757행)
  - 내용: `findTrailingPartialTag` 원문 그대로 유지 및 버퍼 경계 보류, 도구 호출 포착 시 `heldContent` 누적, 파싱 성공 시 보류 글 미발행 규칙 유지.
- **규칙 8 (파싱 실패 fallback 경로에도 1~6 규칙 적용, `<tool_call>`은 text)**:
  - 파일: `src/main/adapters/webllm-provider.ts` (337–341행, 737–743행)
  - 내용: `parseCapturedCalls` 실패 시 `parseThinkingBlocks(parser.heldContent)` 호출. `withTools: false`인 파서로 `heldContent`를 처리하여 `<tool_call>`은 text로, `<think>` 블록은 thinking으로 분리 발행.

---

## 3. 기대값을 바꾼 기존 시험의 이전·이후 값

`src/test/webllm-provider.contract.test.ts`:

### 1) `WO13A-P3 split@%s` (1268–1275행)
- 이전:
  ```ts
  expect(mergeNeighboringTexts(chunks)).toEqual([
    { kind: "text", text: "<think>\n\n</think>\n\n앞말 " },
    { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
    { kind: "finish" },
  ]);
  ```
- 이후:
  ```ts
  expect(mergeNeighboringTexts(chunks)).toEqual([
    { kind: "text", text: "\n\n앞말 " },
    { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
    { kind: "finish" },
  ]);
  ```

### 2) `WO13A-P3 per-char` (1290–1297행)
- 이전:
  ```ts
  expect(mergeNeighboringTexts(chunks)).toEqual([
    { kind: "text", text: "<think>\n\n</think>\n\n앞말 " },
    { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
    { kind: "finish" },
  ]);
  ```
- 이후:
  ```ts
  expect(mergeNeighboringTexts(chunks)).toEqual([
    { kind: "text", text: "\n\n앞말 " },
    { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
    { kind: "finish" },
  ]);
  ```

### 3) `WO13A-P4 생각 구간 안의 유효 호출만 있는 생각+답` (1312–1318행)
- 이전:
  ```ts
  expect(mergeNeighboringTexts(chunks)).toEqual([
    { kind: "text", text },
    { kind: "finish" },
  ]);
  ```
- 이후:
  ```ts
  expect(mergeNeighboringTexts(chunks)).toEqual([
    { kind: "thinking", text: '<tool_call>{"name":"read_file","arguments":{"path":"AGENTS.md"}}</tool_call>' },
    { kind: "text", text: "답" },
    { kind: "finish" },
  ]);
  ```

### 4) `WO13A-P14 eof-partial-open-tag` (1753–1758행)
- 이전:
  ```ts
  expect(mergeNeighboringTexts(chunks)).toEqual([
    { kind: "text", text: "앞말 <think>생각" },
    { kind: "finish" },
  ]);
  ```
- 이후:
  ```ts
  expect(mergeNeighboringTexts(chunks)).toEqual([
    { kind: "text", text: "앞말 " },
    { kind: "thinking", text: "생각" },
    { kind: "finish" },
  ]);
  ```

### 5) `WO13A-P19 think-closed-inside-inner-call` (1987–1993행)
- 이전:
  ```ts
  expect(mergeNeighboringTexts(chunks)).toEqual([
    { kind: "text", text: '<think><tool_call>\n{"name":"list_dir","arguments":{"path":"notes"}}\n</think>그다음 ' },
    { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
    { kind: "finish" },
  ]);
  ```
- 이후:
  ```ts
  expect(mergeNeighboringTexts(chunks)).toEqual([
    { kind: "thinking", text: '<tool_call>\n{"name":"list_dir","arguments":{"path":"notes"}}\n' },
    { kind: "text", text: "그다음 " },
    { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
    { kind: "finish" },
  ]);
  ```

---

## 4. 2절 새 시험 이름 (11개)

1. `WO13D-K1 empty-think-dropped` (`src/test/webllm-provider.contract.test.ts`)
2. `WO13D-K2 think-to-thinking` (`src/test/webllm-provider.contract.test.ts`)
3. `WO13D-K3 split-every-position` (`WO13D-K3 split@<위치>`) (`src/test/webllm-provider.contract.test.ts`)
4. `WO13D-K4 whitespace-then-text-in-think` (`src/test/webllm-provider.contract.test.ts`)
5. `WO13D-K5 no-tools-path` (`src/test/webllm-provider.contract.test.ts`)
6. `WO13D-K6 stray-tags` (`src/test/webllm-provider.contract.test.ts`)
7. `WO13D-K7 unclosed-at-eof` (`src/test/webllm-provider.contract.test.ts`)
8. `WO13D-K8 bracket-tag-untouched` (`src/test/webllm-provider.contract.test.ts`)
9. `WO13D-K9 no-tools-split` (`WO13D-K9 split@<위치>`) (`src/test/webllm-provider.contract.test.ts`)
10. `WO13D-K10 parse-fail-fallback` (`src/test/webllm-provider.contract.test.ts`)
11. `WO13D-I1 history-without-think` (`src/test/browser-agent.integration.test.ts`)

---

## 5. 3절 명령의 종료 값과 출력 끝 20줄

### 5-1. 변경 전 판정 명령

```bash
mkdir -p /tmp/wo13d
git status --porcelain --untracked-files=all > /tmp/wo13d/status-before.txt; rc=$?; echo "status-before exit=$rc"
git ls-files -m -o --exclude-standard -z -- . ':!.agents/session-contracts/.recovery' ':!.agents/progress/naia-web-wo-13d-agent-report.md' > /tmp/wo13d/list-before.z; rc=$?; echo "list-before exit=$rc"
xargs -0 -r sha256sum < /tmp/wo13d/list-before.z > /tmp/wo13d/hash-before.txt; rc=$?; echo "hash-before exit=$rc"
rm -f /tmp/wo13d/before.json; pnpm build > /tmp/wo13d/build-before.log 2>&1; rc=$?; echo "build-before exit=$rc"
pnpm vitest run --reporter=json --outputFile=/tmp/wo13d/before.json > /tmp/wo13d/test-before.log 2>&1; rc=$?; echo "test-before exit=$rc"
test -s /tmp/wo13d/before.json; rc=$?; echo "before-json rc=$rc"
```

출력 결과:
```
status-before exit=0
list-before exit=0
hash-before exit=0
build-before exit=0
test-before exit=1
before-json rc=0
```

`build-before.log` 끝 20줄:
```
> @nextain/naia-agent@0.0.0 build /var/home/luke/alpha-adk/projects/naia-web-probe/naia-agent
> tsc -p tsconfig.json
```

`test-before.log` 끝 20줄:
```
hint: will change to "main" in Git 3.0. To configure the initial branch name
hint: to use in all of your new repositories, which will suppress this warning,
hint: call:
hint: 
hint: 	git config --global init.defaultBranch <name>
hint: 
hint: Names commonly chosen instead of 'master' are 'main', 'trunk' and
hint: 'development'. The just-created branch can be renamed via this command:
hint: 
hint: 	git branch -m <name>
hint: 
hint: Disable this message with "git config set advice.defaultBranchName false"
[naia-agent] memory surfacing=off(no-embedding)
[naia-agent] memory preparing in background (model load / reindex)
[naia-agent] memory surfacing=off(no-embedding)
[naia-agent] memory preparing in background (model load / reindex)
[naia-agent] memory preparing in background (model load / reindex)
(node:1086951) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
JSON report written to /tmp/wo13d/before.json
```

---

### 5-2. 변경 뒤 판정 명령

#### (1) focus 테스트
```bash
rm -f /tmp/wo13d/focus.json /tmp/wo13d/after.json
pnpm vitest run src/test/webllm-provider.contract.test.ts src/test/browser-read-tools.contract.test.ts src/test/browser-agent.integration.test.ts --reporter=json --outputFile=/tmp/wo13d/focus.json > /tmp/wo13d/focus.log 2>&1; rc=$?; echo "focus exit=$rc"
```
종료 값: `focus exit=0`

`focus.log` 끝 20줄:
```
JSON report written to /tmp/wo13d/focus.json
```

#### (2) need.mjs 실행
```bash
node /tmp/wo13d/need.mjs /tmp/wo13d/focus.json 'WO13D-K1 empty-think-dropped' 'WO13D-K2 think-to-thinking' 'WO13D-K3' 'WO13D-K4 whitespace-then-text-in-think' 'WO13D-K5 no-tools-path' 'WO13D-K6 stray-tags' 'WO13D-K7 unclosed-at-eof' 'WO13D-K8 bracket-tag-untouched' 'WO13D-K9' 'WO13D-K10 parse-fail-fallback' 'WO13D-I1 history-without-think' > /tmp/wo13d/need.log 2>&1; rc=$?; echo "need exit=$rc"; cat /tmp/wo13d/need.log
```
종료 값: `need exit=0`
출력:
```
required=243 missing=0
```

#### (3) 3회 반복 실행
```bash
for i in 1 2 3; do pnpm vitest run src/test/webllm-provider.contract.test.ts src/test/browser-agent.integration.test.ts > /tmp/wo13d/rep-$i.log 2>&1; rc=$?; echo "rep$i exit=$rc"; done
```
종료 값:
```
rep1 exit=0
rep2 exit=0
rep3 exit=0
```

`rep-1.log` 끝 20줄:
```
 RUN  v2.1.9 /var/home/luke/alpha-adk/projects/naia-web-probe/naia-agent

 ✓ src/test/webllm-provider.contract.test.ts (382 tests) 134ms
 ✓ src/test/browser-agent.integration.test.ts (10 tests) 1447ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 정상 요청 처리, 깨진 JSON 뒤 복구, stop() 뒤 줄 차단 523ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 취소: cancel_stream 전송 시 종결 줄 도착 및 이후 줄 차단 322ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 정지: partial 수신 후 stop() 시 late 텍스트 및 finish 모두 차단 512ms

 Test Files  2 passed (2)
      Tests  392 passed (392)
   Start at  13:09:17
   Duration  1.87s (transform 282ms, setup 0ms, collect 450ms, tests 1.58s, environment 0ms, prepare 135ms)
```

`rep-2.log` 끝 20줄:
```
 RUN  v2.1.9 /var/home/luke/alpha-adk/projects/naia-web-probe/naia-agent

 ✓ src/test/webllm-provider.contract.test.ts (382 tests) 137ms
 ✓ src/test/browser-agent.integration.test.ts (10 tests) 1443ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 정상 요청 처리, 깨진 JSON 뒤 복구, stop() 뒤 줄 차단 524ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 취소: cancel_stream 전송 시 종결 줄 도착 및 이후 줄 차단 321ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 정지: partial 수신 후 stop() 시 late 텍스트 및 finish 모두 차단 511ms

 Test Files  2 passed (2)
      Tests  392 passed (392)
   Start at  13:09:20
   Duration  1.88s (transform 274ms, setup 0ms, collect 457ms, tests 1.58s, environment 0ms, prepare 115ms)
```

`rep-3.log` 끝 20줄:
```
 RUN  v2.1.9 /var/home/luke/alpha-adk/projects/naia-web-probe/naia-agent

 ✓ src/test/webllm-provider.contract.test.ts (382 tests) 138ms
 ✓ src/test/browser-agent.integration.test.ts (10 tests) 1444ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 정상 요청 처리, 깨진 JSON 뒤 복구, stop() 뒤 줄 차단 524ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 취소: cancel_stream 전송 시 종결 줄 도착 및 이후 줄 차단 323ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 정지: partial 수신 후 stop() 시 late 텍스트 및 finish 모두 차단 512ms

 Test Files  2 passed (2)
      Tests  392 passed (392)
   Start at  13:09:22
   Duration  1.87s (transform 288ms, setup 0ms, collect 453ms, tests 1.58s, environment 0ms, prepare 123ms)
```

#### (4) tsc 및 build
```bash
npx tsc --noEmit -p . > /tmp/wo13d/tsc.log 2>&1; rc=$?; echo "tsc exit=$rc"
pnpm build > /tmp/wo13d/build.log 2>&1; rc=$?; echo "build exit=$rc"
```
종료 값:
```
tsc exit=0
build exit=0
```
`tsc.log`: 오류 0건 (빈 출력)
`build.log` 끝 20줄:
```
> @nextain/naia-agent@0.0.0 build /var/home/luke/alpha-adk/projects/naia-web-probe/naia-agent
> tsc -p tsconfig.json
```

#### (5) test-after 및 cmp.mjs
```bash
pnpm vitest run --reporter=json --outputFile=/tmp/wo13d/after.json > /tmp/wo13d/test-after.log 2>&1; rc=$?; echo "test-after exit=$rc"
test -s /tmp/wo13d/after.json; rc=$?; echo "after-json rc=$rc"
node /tmp/wo13d/cmp.mjs /tmp/wo13d/before.json /tmp/wo13d/after.json > /tmp/wo13d/cmp.log 2>&1; rc=$?; echo "cmp exit=$rc"; cat /tmp/wo13d/cmp.log
```
종료 값:
```
test-after exit=1
after-json rc=0
cmp exit=0
```
출력:
```
{"before":{"passed":2460,"failed":25,"fileErrors":0},"after":{"passed":2591,"failed":25,"fileErrors":0}}
new-fail=0 new-file-error=0 lost=0 renamed-exempt=0 new-skip=0 vanished=0 gained=131
```

`test-after.log` 끝 20줄:
```
hint: call:
hint: 
hint: 	git config --global init.defaultBranch <name>
hint: 
hint: Names commonly chosen instead of 'master' are 'main', 'trunk' and
hint: 'development'. The just-created branch can be renamed via this command:
hint: 
hint: 	git branch -m <name>
hint: 
hint: Disable this message with "git config set advice.defaultBranchName false"
[naia-agent] ⚠ 워크스페이스 미설정 — leftover ~/naia-adk clone 폴백 없이 SetWorkspace/NAIA_ADK_PATH 를 기다린다.
[naia-agent] memory deferred until SetWorkspace/NAIA_ADK_PATH (no leftover ~/naia-adk clone)
[naia-agent] memory surfacing=off(no-embedding)
[naia-agent] memory preparing in background (model load / reindex)
[naia-agent] memory surfacing=off(no-embedding)
[naia-agent] memory preparing in background (model load / reindex)
[naia-agent] memory preparing in background (model load / reindex)
(node:1147606) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
JSON report written to /tmp/wo13d/after.json
```

#### (6) 상태 및 해시 비교
```bash
git status --porcelain --untracked-files=all > /tmp/wo13d/status-after.txt; rc=$?; echo "status-after exit=$rc"
grep -v '\.agents/session-contracts/\.recovery/' /tmp/wo13d/status-before.txt | sort > /tmp/wo13d/sb.txt; grep -v '\.agents/session-contracts/\.recovery/' /tmp/wo13d/status-after.txt | sort > /tmp/wo13d/sa.txt; diff /tmp/wo13d/sb.txt /tmp/wo13d/sa.txt
git diff --stat
sha256sum -c /tmp/wo13d/hash-before.txt > /tmp/wo13d/hash-check.txt 2>&1; rc=$?; echo "hash-check exit=$rc"; grep -v ": OK$" /tmp/wo13d/hash-check.txt
```
출력:
```
status-after exit=0
0a1,3
>  M src/main/adapters/webllm-provider.ts
>  M src/test/browser-agent.integration.test.ts
>  M src/test/webllm-provider.contract.test.ts
 src/main/adapters/webllm-provider.ts       | 294 +++++++++++++++-----------
 src/test/browser-agent.integration.test.ts | 116 +++++++++++
 src/test/webllm-provider.contract.test.ts  | 323 ++++++++++++++++++++++++++++-
 3 files changed, 602 insertions(+), 131 deletions(-)
hash-check exit=0
.agents/progress/naia-web-wo-02b-report.md: 성공
.agents/progress/naia-web-wo-03-report.md: 성공
.agents/progress/naia-web-wo-03b-report.md: 성공
.agents/progress/naia-web-wo-03c-report.md: 성공
.agents/progress/naia-web-wo-07-report.md: 성공
.agents/progress/naia-web-wo-13a-report.md: 성공
.agents/progress/naia-web-wo-13a2-report.md: 성공
.agents/progress/naia-web-wo-13c-agent-report.md: 성공
```

---

## 6. 최종 판정 판정 조건 충족 확인

- `before-json rc=0`, `after-json rc=0`: 충족
- `focus`(0), `need`(0), 반복 세 번(0, 0, 0), `tsc`(0), `build`(0), `cmp`(0) 종료 값 0: 충족
- `need.log` 마지막 줄 `missing=0`: 충족 (`required=243 missing=0`)
- `cmp.log` 마지막 줄 `new-fail=0 new-file-error=0 lost=0 renamed-exempt=0 new-skip=0 vanished=0`: 충족
- `cmp.log` 첫 줄 JSON `after.failed` (25) <= `before.failed` (25) 및 `after.fileErrors` (0) <= `before.fileErrors` (0): 충족
- `list-before`(0), `hash-before`(0), `status-before`(0), `status-after`(0) 종료 값 0: 충족
- `hash-check`에서 0절 허용 파일 외 변경/깨짐 없음: 충족 (`hash-check exit=0`)
- `status` 차이 및 `git diff --stat`에 0절 허용 파일 3개만 노출: 충족
