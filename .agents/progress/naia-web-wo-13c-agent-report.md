수용: 충족

## 1. 커밋 정보
- 커밋 해시: `6a33a84b978fad8df4042e8490aa46b9e4da3584`
- 커밋 메시지: `fix(browser): answer in the user's language and list full workspace paths for the web model (#156)`
- 캐시 스테이징 확인 (`git diff --cached --name-only`):
  ```
  src/main/adapters/browser-read-tools.ts
  src/main/adapters/webllm-provider.ts
  src/test/browser-agent.integration.test.ts
  src/test/browser-read-tools.contract.test.ts
  src/test/webllm-provider.contract.test.ts
  ```

---

## 2. 1절 항목별 바뀐 코드 위치

### 2-1. 답 언어 한 줄 (1-1)
- 파일: `src/main/adapters/webllm-provider.ts` (268-270행 부근)
- 내용: `toolsPrompt`의 마지막 `</tool_call>` 뒤에 빈 줄 하나와 `Always reply in the same language as the user's latest message, even when the files or tool results you read are in another language.` 문장을 추가함. (도구가 없어 `toolsPrompt`를 생성하지 않는 경우에는 추가되지 않음)

### 2-2. 목록에 루트 기준 전체 경로 (1-2)
- 파일: `src/main/adapters/browser-read-tools.ts`
  1. 176–208행 부근: `list_dir` 및 `read_file`의 도구 수준 `description`을 새 명세 문구로 수정함.
     - `list_dir`: `List files and folders at a path in the user's ADK workspace. Each line is "d <path>" for a folder or "f <path>" for a file, where <path> is the full path from the workspace root. Pass that path unchanged to read_file or list_dir.`
     - `read_file`: `Read a text file in the user's ADK workspace. Use the full path from the workspace root, exactly as list_dir shows it.`
  2. 256–260행 부근: `list_dir` 실행 시 출력 줄 생성부를 `segments.length > 0 ? `${segments.join("/")}/${e.name}` : e.name`으로 변환하여 루트(`segments`가 빈 배열)일 때는 이름만, 하위 폴더일 때는 루트 기준 전체 경로(`<d|f> <루트 기준 경로>`)가 출력되도록 수정함.

---

## 3. 기대값을 바꾼 기존 시험의 이전·이후 값

### 3-1. `src/test/webllm-provider.contract.test.ts`
1. `expectedToolsBlock1` (1162행 부근):
   - 이전:
     ```
     <tool_call>
     {"name": <function-name>, "arguments": <args-json-object>}
     </tool_call>`;
     ```
   - 이후:
     ```
     <tool_call>
     {"name": <function-name>, "arguments": <args-json-object>}
     </tool_call>

     Always reply in the same language as the user's latest message, even when the files or tool results you read are in another language.`;
     ```

2. `expectedToolsBlock2` (1191행 부근):
   - 이전:
     ```
     <tool_call>
     {"name": <function-name>, "arguments": <args-json-object>}
     </tool_call>`;
     ```
   - 이후:
     ```
     <tool_call>
     {"name": <function-name>, "arguments": <args-json-object>}
     </tool_call>

     Always reply in the same language as the user's latest message, even when the files or tool results you read are in another language.`;
     ```

3. `expectedToolsBlock` (1989행 부근 in `WO13A-P20`):
   - 이전:
     ```
     <tool_call>
     {"name": <function-name>, "arguments": <args-json-object>}
     </tool_call>`;
     ```
   - 이후:
     ```
     <tool_call>
     {"name": <function-name>, "arguments": <args-json-object>}
     </tool_call>

     Always reply in the same language as the user's latest message, even when the files or tool results you read are in another language.`;
     ```

### 3-2. `src/test/browser-read-tools.contract.test.ts`
1. `WO13A-T03b` (152행 부근):
   - 이전:
     ```ts
     expect(listRes.output).toBe("f philosophy.md");
     ```
   - 이후:
     ```ts
     expect(listRes.output).toBe("f .agents/context/philosophy.md");
     ```

2. `WO13A-T18` (333·336행 부근):
   - 이전:
     ```ts
     for (let i = 0; i < 100; i++) {
       expectedLines.push(`d d${String(i).padStart(3, "0")}`);
     }
     for (let i = 0; i < 100; i++) {
       expectedLines.push(`f f${String(i).padStart(3, "0")}`);
     }
     ```
   - 이후:
     ```ts
     for (let i = 0; i < 100; i++) {
       expectedLines.push(`d big/d${String(i).padStart(3, "0")}`);
     }
     for (let i = 0; i < 100; i++) {
       expectedLines.push(`f big/f${String(i).padStart(3, "0")}`);
     }
     ```

3. `WO13A-T20` (370행 부근):
   - 이전:
     ```ts
     expect(listRes.output).toBe("f hello.md");
     ```
   - 이후:
     ```ts
     expect(listRes.output).toBe("f notes/hello.md");
     ```

4. `WO13A-T24` (468·471행 부근):
   - 이전:
     ```ts
     for (let i = 0; i < 100; i++) {
       expected200Lines.push(`d d${String(i).padStart(3, "0")}`);
     }
     for (let i = 0; i < 100; i++) {
       expected200Lines.push(`f f${String(i).padStart(3, "0")}`);
     }
     ```
   - 이후:
     ```ts
     for (let i = 0; i < 100; i++) {
       expected200Lines.push(`d folder200/d${String(i).padStart(3, "0")}`);
     }
     for (let i = 0; i < 100; i++) {
       expected200Lines.push(`f folder200/f${String(i).padStart(3, "0")}`);
     }
     ```

5. `WO13A-T26` (500–533행 부근):
   - 이전:
     ```ts
     {
       name: "list_dir",
       description: "List files and folders at a path in the user's ADK workspace.",
       tier: "none",
       // ...
     },
     {
       name: "read_file",
       description: "Read a text file in the user's ADK workspace.",
       tier: "none",
       // ...
     }
     ```
   - 이후:
     ```ts
     {
       name: "list_dir",
       description:
         "List files and folders at a path in the user's ADK workspace. Each line is \"d <path>\" for a folder or \"f <path>\" for a file, where <path> is the full path from the workspace root. Pass that path unchanged to read_file or list_dir.",
       tier: "none",
       // ...
     },
     {
       name: "read_file",
       description:
         "Read a text file in the user's ADK workspace. Use the full path from the workspace root, exactly as list_dir shows it.",
       tier: "none",
       // ...
     }
     ```

---

## 4. 2절 새 시험 이름 (7개)

1. `WO13C-A1 tools-prompt-language` (`src/test/webllm-provider.contract.test.ts`)
2. `WO13C-A2 nested-full-path` (`src/test/browser-read-tools.contract.test.ts`)
3. `WO13C-A3 trailing-slash` (`src/test/browser-read-tools.contract.test.ts`)
4. `WO13C-A4 root-unchanged` (`src/test/browser-read-tools.contract.test.ts`)
5. `WO13C-A5 path-roundtrip` (`src/test/browser-read-tools.contract.test.ts`)
6. `WO13C-A6 descriptions` (`src/test/browser-read-tools.contract.test.ts`)
7. `WO13C-A7 integration` (`src/test/browser-agent.integration.test.ts`)

---

## 5. 3절 명령의 종료 값과 출력 끝 20줄

### 5-1. 변경 전 판정 명령

```bash
git status --porcelain --untracked-files=all > /tmp/wo13c/status-before.txt; rc=$?; echo "status-before exit=$rc"
git ls-files -m -o --exclude-standard -z -- . ':!.agents/session-contracts/.recovery' ':!.agents/progress/naia-web-wo-13c-agent-report.md' > /tmp/wo13c/list-before.z; rc=$?; echo "list-before exit=$rc"
xargs -0 -r sha256sum < /tmp/wo13c/list-before.z > /tmp/wo13c/hash-before.txt; rc=$?; echo "hash-before exit=$rc"
rm -f /tmp/wo13c/before.json; pnpm build > /tmp/wo13c/build-before.log 2>&1; rc=$?; echo "build-before exit=$rc"
pnpm vitest run --reporter=json --outputFile=/tmp/wo13c/before.json > /tmp/wo13c/test-before.log 2>&1; rc=$?; echo "test-before exit=$rc"
test -s /tmp/wo13c/before.json; rc=$?; echo "before-json rc=$rc"
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
(node:537214) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
JSON report written to /tmp/wo13c/before.json
```

---

### 5-2. 변경 뒤 판정 명령

#### (1) focus 테스트
```bash
rm -f /tmp/wo13c/focus.json /tmp/wo13c/after.json
pnpm vitest run src/test/webllm-provider.contract.test.ts src/test/browser-read-tools.contract.test.ts src/test/browser-agent.integration.test.ts --reporter=json --outputFile=/tmp/wo13c/focus.json > /tmp/wo13c/focus.log 2>&1; rc=$?; echo "focus exit=$rc"
```
종료 값: `focus exit=0`

`focus.log` 끝 20줄:
```
JSON report written to /tmp/wo13c/focus.json
```

#### (2) need.mjs 실행
```bash
node /tmp/wo13c/need.mjs /tmp/wo13c/focus.json 'WO13C-A1 tools-prompt-language' 'WO13C-A2 nested-full-path' 'WO13C-A3 trailing-slash' 'WO13C-A4 root-unchanged' 'WO13C-A5 path-roundtrip' 'WO13C-A6 descriptions' 'WO13C-A7 integration' > /tmp/wo13c/need.log 2>&1; rc=$?; echo "need exit=$rc"; cat /tmp/wo13c/need.log
```
종료 값: `need exit=0`
출력:
```
required=239 missing=0
```

#### (3) 3회 반복 실행
```bash
for i in 1 2 3; do pnpm vitest run src/test/webllm-provider.contract.test.ts src/test/browser-agent.integration.test.ts > /tmp/wo13c/rep-$i.log 2>&1; rc=$?; echo "rep$i exit=$rc"; done
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

 ✓ src/test/webllm-provider.contract.test.ts (252 tests) 146ms
 ✓ src/test/browser-agent.integration.test.ts (9 tests) 1434ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 정상 요청 처리, 깨진 JSON 뒤 복구, stop() 뒤 줄 차단 524ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 취소: cancel_stream 전송 시 종결 줄 도착 및 이후 줄 차단 322ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 정지: partial 수신 후 stop() 시 late 텍스트 및 finish 모두 차단 512ms

 Test Files  2 passed (2)
      Tests  261 passed (261)
   Start at  12:07:26
   Duration  1.82s (transform 253ms, setup 0ms, collect 431ms, tests 1.58s, environment 0ms, prepare 100ms)
```

`rep-2.log` 끝 20줄:
```
 RUN  v2.1.9 /var/home/luke/alpha-adk/projects/naia-web-probe/naia-agent

 ✓ src/test/webllm-provider.contract.test.ts (252 tests) 121ms
 ✓ src/test/browser-agent.integration.test.ts (9 tests) 1441ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 정상 요청 처리, 깨진 JSON 뒤 복구, stop() 뒤 줄 차단 522ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 취소: cancel_stream 전송 시 종결 줄 도착 및 이후 줄 차단 324ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 정지: partial 수신 후 stop() 시 late 텍스트 및 finish 모두 차단 511ms

 Test Files  2 passed (2)
      Tests  261 passed (261)
   Start at  12:07:28
   Duration  1.91s (transform 325ms, setup 0ms, collect 547ms, tests 1.56s, environment 0ms, prepare 71ms)
```

`rep-3.log` 끝 20줄:
```
 RUN  v2.1.9 /var/home/luke/alpha-adk/projects/naia-web-probe/naia-agent

 ✓ src/test/webllm-provider.contract.test.ts (252 tests) 157ms
 ✓ src/test/browser-agent.integration.test.ts (9 tests) 1445ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 정상 요청 처리, 깨진 JSON 뒤 복구, stop() 뒤 줄 차단 526ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 취소: cancel_stream 전송 시 종결 줄 도착 및 이후 줄 차단 325ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 정지: partial 수신 후 stop() 시 late 텍스트 및 finish 모두 차단 512ms

 Test Files  2 passed (2)
      Tests  261 passed (261)
   Start at  12:07:30
   Duration  1.89s (transform 305ms, setup 0ms, collect 520ms, tests 1.60s, environment 0ms, prepare 84ms)
```

#### (4) tsc 및 build
```bash
npx tsc --noEmit -p . > /tmp/wo13c/tsc.log 2>&1; rc=$?; echo "tsc exit=$rc"
pnpm build > /tmp/wo13c/build.log 2>&1; rc=$?; echo "build exit=$rc"
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
pnpm vitest run --reporter=json --outputFile=/tmp/wo13c/after.json > /tmp/wo13c/test-after.log 2>&1; rc=$?; echo "test-after exit=$rc"
test -s /tmp/wo13c/after.json; rc=$?; echo "after-json rc=$rc"
node /tmp/wo13c/cmp.mjs /tmp/wo13c/before.json /tmp/wo13c/after.json > /tmp/wo13c/cmp.log 2>&1; rc=$?; echo "cmp exit=$rc"; cat /tmp/wo13c/cmp.log
```
종료 값:
```
test-after exit=1
after-json rc=0
cmp exit=0
```
출력:
```
{"before":{"passed":2452,"failed":26,"fileErrors":0},"after":{"passed":2460,"failed":25,"fileErrors":0}}
new-fail=0 new-file-error=0 lost=0 renamed-exempt=0 new-skip=0 vanished=0 gained=8
```

`test-after.log` 끝 20줄:
```
hint: Using 'master' as the name for the initial branch. This default branch name
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
[naia-agent] memory preparing in background (model load / reindex)
[naia-agent] memory surfacing=off(no-embedding)
[naia-agent] memory preparing in background (model load / reindex)
[naia-agent] memory preparing in background (model load / reindex)
(node:579350) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
JSON report written to /tmp/wo13c/after.json
```

#### (6) 상태 및 해시 비교
```bash
git status --porcelain --untracked-files=all > /tmp/wo13c/status-after.txt; rc=$?; echo "status-after exit=$rc"
grep -v '\.agents/session-contracts/\.recovery/' /tmp/wo13c/status-before.txt | sort > /tmp/wo13c/sb.txt; grep -v '\.agents/session-contracts/\.recovery/' /tmp/wo13c/status-after.txt | sort > /tmp/wo13c/sa.txt; diff /tmp/wo13c/sb.txt /tmp/wo13c/sa.txt
git diff --stat
sha256sum -c /tmp/wo13c/hash-before.txt > /tmp/wo13c/hash-check.txt 2>&1; rc=$?; echo "hash-check exit=$rc"; grep -v ": OK$" /tmp/wo13c/hash-check.txt
```
출력:
```
status-after exit=0
0a1,5
>  M src/main/adapters/browser-read-tools.ts
>  M src/main/adapters/webllm-provider.ts
>  M src/test/browser-agent.integration.test.ts
>  M src/test/browser-read-tools.contract.test.ts
>  M src/test/webllm-provider.contract.test.ts
 src/main/adapters/browser-read-tools.ts      |   9 +-
 src/main/adapters/webllm-provider.ts         |   4 +-
 src/test/browser-agent.integration.test.ts   | 151 +++++++++++++++++++++++++++
 src/test/browser-read-tools.contract.test.ts | 108 +++++++++++++++++--
 src/test/webllm-provider.contract.test.ts    |  52 ++++++++-
 5 files changed, 309 insertions(+), 15 deletions(-)
hash-check exit=0
.agents/progress/naia-web-wo-02b-report.md: 성공
.agents/progress/naia-web-wo-03-report.md: 성공
.agents/progress/naia-web-wo-03b-report.md: 성공
.agents/progress/naia-web-wo-03c-report.md: 성공
.agents/progress/naia-web-wo-07-report.md: 성공
.agents/progress/naia-web-wo-13a-report.md: 성공
.agents/progress/naia-web-wo-13a2-report.md: 성공
```

---

## 6. 최종 판정 판정 조건 충족 확인

- `before-json rc=0`, `after-json rc=0`: 충족 (`before-json rc=0`, `after-json rc=0`)
- `focus`(0), `need`(0), 반복 세 번(0, 0, 0), `tsc`(0), `build`(0), `cmp`(0) 종료 값 0: 충족
- `need.log` 마지막 줄 `missing=0`: 충족 (`required=239 missing=0`)
- `cmp.log` 마지막 줄 `new-fail=0 new-file-error=0 lost=0 renamed-exempt=0 new-skip=0 vanished=0`: 충족
- `cmp.log` 첫 줄 JSON `after.failed` (25) <= `before.failed` (26) 및 `after.fileErrors` (0) <= `before.fileErrors` (0): 충족
- `list-before`(0), `hash-before`(0), `status-before`(0), `status-after`(0) 종료 값 0: 충족
- `hash-check`에서 0절 허용 파일 외 변경/깨짐 없음: 충족 (`hash-check exit=0`)
- `status` 차이 및 `git diff --stat`에 0절 허용 파일 5개만 노출: 충족
