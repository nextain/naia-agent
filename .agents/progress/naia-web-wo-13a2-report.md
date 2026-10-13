수용: 충족

## 1. 커밋 정보
- 커밋 해시: `61e501285ca5f564f600165d1bac1ad50a967b37`
- 커밋 메시지: `fix(browser): count every webllm chat() request and tighten WO-13a tests (#156)`
- 캐시 스테이징 확인 (`git diff --cached --name-only`):
  ```
  src/main/adapters/webllm-provider.ts
  src/test/browser-agent.integration.test.ts
  src/test/browser-read-tools.contract.test.ts
  src/test/webllm-provider.contract.test.ts
  ```

---

## 2. 고친 내용 (2절 항목별)

### 2-1. 구현: 요청 번호 (WO-13a 5-1 4번)
- 파일: `src/main/adapters/webllm-provider.ts`
- 내용: `chat()` 메서드 본문 맨 처음(메시지 사전 검증 및 시작 전 취소 확인보다 앞)으로 `const requestNumber = ++requestCounter;` 이동. `chat()`이 호출될 때마다 요청 번호가 1씩 증가하도록 수정.

### 2-2. 시험 수정
1. `WO13A-P18 request-number`
   - 파일: `src/test/webllm-provider.contract.test.ts`
   - 내용: 동일 공급자 인스턴스로 (가) 이미 취소된 신호로 `chat()` 호출 후 끝까지 읽음(빈 배열 확인), (나) `inlineImages`가 든 메시지로 `chat()` 호출하여 거부 예외 수신, (다) 유효 `read_file` 호출 1개를 흘리는 `chat()` 호출을 수행하고, (다)의 `toolUse.id`가 정확히 `webllm-call-6-0`인지 단언. 가짜 엔진의 분기를 호출 횟수 3일 때만 2개 흘리고 4번째 엔진 호출(다)에서는 1개만 흘리도록 수정하고 조각 배열 전체를 `toEqual`로 단언.
2. `WO13A-P17 cancel-at-eof`
   - 파일: `src/test/webllm-provider.contract.test.ts`
   - 내용: 실제 `AbortController`를 생성하고 `Object.defineProperty(controller.signal, "aborted", { get: () => eofReached })`로 신호의 `aborted` 속성을 정의하여 `abort()` 이벤트 없이 EOF 직후 취소 상태로 전이되도록 재작성. 엔진 제너레이터가 유효 호출 하나(`앞말 ` + 블록)를 흘린 후 `eofReached = true`로 두고 return. 기대 조각 배열 `[{ kind: "text", text: "앞말 " }]` (`toolUse`·`finish` 없음) 단언.
3. `WO13A-P2 toolNames 필터링 및 opts.tools 순서 보존`
   - 파일: `src/test/webllm-provider.contract.test.ts`
   - 내용: 시스템 메시지 `"SYS"`를 준 요청에서 엔진이 수신한 시스템 메시지 내용이 `"SYS\n\n" + expectedToolsBlock`과 `toBe`로 일치함을 단언. 순서 보존 사례(`read_file` 다음 `list_dir`) 역시 `"SYS\n\n" + expectedToolsBlock2`와 `toBe`로 일치함을 단언. 두 사례 모두 공급자가 방출한 조각 배열 전체(`[{ kind: "text", text: "ok" }, { kind: "finish" }]`)를 `toEqual`로 단언.
4. `WO13A-P20 no-system-message` 및 `WO13A-P10`
   - 파일: `src/test/webllm-provider.contract.test.ts`
   - 내용:
     - `WO13A-P20 no-system-message`: 공급자가 방출한 조각 배열 전체를 `toEqual`(`[{ kind: "text", text: "ok" }, { kind: "finish" }]`)로 단언.
     - `WO13A-P10`: `toolNames` 없음 인스턴스와 `toolNames: BROWSER_READ_TOOL_NAMES` 있음 인스턴스 두 경우 모두 엔진이 받은 메시지 배열이 기대값과 `toEqual`인지 단언하고, 공급자가 방출한 조각 배열 전체를 `toEqual`로 단언.
5. `WO13A-P9 cancel-after-first-tooluse keep-reading`
   - 파일: `src/test/webllm-provider.contract.test.ts`
   - 내용: `finish` 조각을 수신한 뒤 한 번 더 `it.next()`를 호출하여 `{ done: true, value: undefined }`인지 단언.
6. `WO13A-T18` 및 `WO13A-T24`
   - 파일: `src/test/browser-read-tools.contract.test.ts`
   - 내용:
     - `WO13A-T18`: 반복문으로 기대 출력 문자열(`d d000`..`d d099`, `f f000`..`f f099`, 끝에 `…(more entries)`)을 구성하여 `output`과 `toBe`로 전체 비교.
     - `WO13A-T24`: 200개 항목 폴더를 디렉터리 100개(`d000`..`d099`)와 파일 100개(`f000`..`f099`)로 구성하고, 반복문으로 구성한 기대 출력 문자열과 `toBe`로 전체 비교(`…(more entries)` 없음).
7. `WO13A-T15` 및 `WO13A-T20`
   - 파일: `src/test/browser-read-tools.contract.test.ts`
   - 내용:
     - `WO13A-T15`: 네 응답(`read_file nope/x.md`, `list_dir keys`, `list_dir env`, `list_dir NAIA-SETTINGS2`) 각각에 대해 `output.toLowerCase()`에서 입력 경로 자체를 제외한 응답 안내에 `naia-settings`, `.env`, `.keys` 셋이 모두 없음을 단언.
     - `WO13A-T20`: 두 응답(`read_file notes/env`, `list_dir notes/keys`) 각각에 대해 `output.toLowerCase()`에 `.env`, `.keys` 둘 다 없음을 단언.
8. `WO13A-I`
   - 파일: `src/test/browser-agent.integration.test.ts`
   - 내용: 승인 요청 카운팅 조건에 `approval_request`를 추가(`gatewayApprovalRequest`, `gateway_approval_request`, `approval_request`), 셋을 합친 수가 0인지 단언.

---

## 3. 판정 명령 실행 결과

### 3-1. 변경 전 판정 명령

```bash
git status --porcelain --untracked-files=all > /tmp/wo13a2/status-before.txt; rc=$?; echo "status-before exit=$rc"
git ls-files -m -o --exclude-standard -z -- . ':!.agents/session-contracts/.recovery' ':!.agents/progress/naia-web-wo-13a2-report.md' > /tmp/wo13a2/list-before.z; rc=$?; echo "list-before exit=$rc"
xargs -0 -r sha256sum < /tmp/wo13a2/list-before.z > /tmp/wo13a2/hash-before.txt; rc=$?; echo "hash-before exit=$rc"
rm -f /tmp/wo13a2/before.json; pnpm build > /tmp/wo13a2/build-before.log 2>&1; rc=$?; echo "build-before exit=$rc"
pnpm vitest run --reporter=json --outputFile=/tmp/wo13a2/before.json > /tmp/wo13a2/test-before.log 2>&1; rc=$?; echo "test-before exit=$rc"
test -s /tmp/wo13a2/before.json; rc=$?; echo "before-json rc=$rc"
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
[naia-agent] ⚠ 워크스페이스 미설정 — leftover ~/naia-adk clone 폴백 없이 SetWorkspace/NAIA_ADK_PATH 를 기다린다.
[naia-agent] memory deferred until SetWorkspace/NAIA_ADK_PATH (no leftover ~/naia-adk clone)
[naia-agent] memory surfacing=off(no-embedding)
[naia-agent] memory preparing in background (model load / reindex)
[naia-agent] memory surfacing=off(no-embedding)
[naia-agent] memory preparing in background (model load / reindex)
[naia-agent] memory preparing in background (model load / reindex)
(node:1690297) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
JSON report written to /tmp/wo13a2/before.json
```

---

### 3-2. 변경 뒤 판정 명령

#### (1) focus 테스트 실행
```bash
rm -f /tmp/wo13a2/focus.json /tmp/wo13a2/after.json
pnpm vitest run src/test/webllm-provider.contract.test.ts src/test/browser-read-tools.contract.test.ts src/test/browser-agent.integration.test.ts --reporter=json --outputFile=/tmp/wo13a2/focus.json > /tmp/wo13a2/focus.log 2>&1; rc=$?; echo "focus exit=$rc"
```
출력:
```
focus exit=0
```
`focus.log` 끝 20줄:
```
JSON report written to /tmp/wo13a2/focus.json
```

#### (2) need.mjs 실행
```bash
node /tmp/wo13a2/need.mjs /tmp/wo13a2/focus.json WO13A-K WO13A-P1 WO13A-P2 WO13A-P4 WO13A-P5 WO13A-P6 WO13A-P10 'WO13A-P7 bad-json' 'WO13A-P7 hidden-name' 'WO13A-P7 args-null' 'WO13A-P7 args-array' 'WO13A-P7 args-string' 'WO13A-P7 unclosed' 'WO13A-P7 valid-plus-invalid' 'WO13A-P7 valid-then-unclosed' 'WO13A-P7 tag-in-string' 'WO13A-P12 escaped-tag' 'WO13A-P14 eof-partial-open-tag' 'WO13A-P16 think-tag-in-args' 'WO13A-P17 cancel-at-eof' 'WO13A-P18 request-number' 'WO13A-P19 think-closed-inside-inner-call' 'WO13A-P20 no-system-message' 'WO13A-P21 no-overlap' 'WO13A-P8 usage-between-text' 'WO13A-P9 cancel-after-first-tooluse keep-reading' 'WO13A-P9 cancel-after-first-tooluse return' 'WO13A-P8 usage-same-chunk' 'WO13A-P8 usage-first' 'WO13A-P8 usage-last-chunk' 'WO13A-P11 think-split-after-capture' 'WO13A-P11 usage-between-tag-pieces' 'WO13A-P3 merge-helper' 'WO13A-P9 cancel-held-call' 'WO13A-P9 cancel-after-usage' 'WO13A-P9 cancel-partial-tag' WO13A-T01 WO13A-T02 WO13A-T03 WO13A-T03b WO13A-T04 WO13A-T05 WO13A-T06 WO13A-T07 WO13A-T08 WO13A-T09 WO13A-T10 WO13A-T11 WO13A-T12 WO13A-T13 WO13A-T14 WO13A-T15 WO13A-T16 WO13A-T17 WO13A-T18 WO13A-T19 WO13A-T20 WO13A-T21 'WO13A-T22 stat' 'WO13A-T22 list' 'WO13A-T22 readText' WO13A-T23 WO13A-T24 WO13A-T25 WO13A-T26 WO13A-I > /tmp/wo13a2/need.log 2>&1; rc=$?; echo "need exit=$rc"; cat /tmp/wo13a2/need.log
```
출력:
```
need exit=0
required=298 missing=0
```

#### (3) 3회 반복 실행
```bash
for i in 1 2 3; do pnpm vitest run src/test/webllm-provider.contract.test.ts src/test/browser-agent.integration.test.ts > /tmp/wo13a2/rep-$i.log 2>&1; rc=$?; echo "rep$i exit=$rc"; done
```
출력:
```
rep1 exit=0
rep2 exit=0
rep3 exit=0
```

`rep-1.log` 끝 20줄:
```
 RUN  v2.1.9 /var/home/luke/alpha-adk/projects/naia-web-probe/naia-agent

 ✓ src/test/webllm-provider.contract.test.ts (251 tests) 129ms
 ✓ src/test/browser-agent.integration.test.ts (8 tests) 1429ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 정상 요청 처리, 깨진 JSON 뒤 복구, stop() 뒤 줄 차단 523ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 취소: cancel_stream 전송 시 종결 줄 도착 및 이후 줄 차단 325ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 정지: partial 수신 후 stop() 시 late 텍스트 및 finish 모두 차단 513ms

 Test Files  2 passed (2)
      Tests  259 passed (259)
   Start at  07:26:17
   Duration  1.81s (transform 243ms, setup 0ms, collect 402ms, tests 1.56s, environment 0ms, prepare 104ms)
```

`rep-2.log` 끝 20줄:
```
 RUN  v2.1.9 /var/home/luke/alpha-adk/projects/naia-web-probe/naia-agent

 ✓ src/test/webllm-provider.contract.test.ts (251 tests) 130ms
 ✓ src/test/browser-agent.integration.test.ts (8 tests) 1429ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 정상 요청 처리, 깨진 JSON 뒤 복구, stop() 뒤 줄 차단 524ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 취소: cancel_stream 전송 시 종결 줄 도착 및 이후 줄 차단 322ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 정지: partial 수신 후 stop() 시 late 텍스트 및 finish 모두 차단 512ms

 Test Files  2 passed (2)
      Tests  259 passed (259)
   Start at  07:26:19
   Duration  1.81s (transform 260ms, setup 0ms, collect 394ms, tests 1.56s, environment 0ms, prepare 83ms)
```

`rep-3.log` 끝 20줄:
```
 RUN  v2.1.9 /var/home/luke/alpha-adk/projects/naia-web-probe/naia-agent

 ✓ src/test/webllm-provider.contract.test.ts (251 tests) 127ms
 ✓ src/test/browser-agent.integration.test.ts (8 tests) 1434ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 정상 요청 처리, 깨진 JSON 뒤 복구, stop() 뒤 줄 차단 525ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 취소: cancel_stream 전송 시 종결 줄 도착 및 이후 줄 차단 324ms
   ✓ browser-agent 통합 시험 (FE-05/FE-06) > 진행 중 정지: partial 수신 후 stop() 시 late 텍스트 및 finish 모두 차단 511ms

 Test Files  2 passed (2)
      Tests  259 passed (259)
   Start at  07:26:21
   Duration  1.87s (transform 370ms, setup 0ms, collect 497ms, tests 1.56s, environment 0ms, prepare 87ms)
```

#### (4) tsc 및 build
```bash
npx tsc --noEmit -p . > /tmp/wo13a2/tsc.log 2>&1; rc=$?; echo "tsc exit=$rc"
pnpm build > /tmp/wo13a2/build.log 2>&1; rc=$?; echo "build exit=$rc"
```
출력:
```
tsc exit=0
build exit=0
```

`tsc.log` 끝 20줄: (출력 없음, 오류 0건)
`build.log` 끝 20줄:
```
> @nextain/naia-agent@0.0.0 build /var/home/luke/alpha-adk/projects/naia-web-probe/naia-agent
> tsc -p tsconfig.json
```

#### (5) test-after 및 cmp.mjs
```bash
pnpm vitest run --reporter=json --outputFile=/tmp/wo13a2/after.json > /tmp/wo13a2/test-after.log 2>&1; rc=$?; echo "test-after exit=$rc"
test -s /tmp/wo13a2/after.json; rc=$?; echo "after-json rc=$rc"
node /tmp/wo13a2/cmp.mjs /tmp/wo13a2/before.json /tmp/wo13a2/after.json > /tmp/wo13a2/cmp.log 2>&1; rc=$?; echo "cmp exit=$rc"; cat /tmp/wo13a2/cmp.log
```
출력:
```
test-after exit=1
after-json rc=0
cmp exit=0
{"before":{"passed":2453,"failed":25,"fileErrors":0},"after":{"passed":2453,"failed":25,"fileErrors":0}}
new-fail=0 new-file-error=0 lost=0 renamed-exempt=0 new-skip=0 vanished=0 gained=0
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
(node:1773359) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
JSON report written to /tmp/wo13a2/after.json
```

#### (6) 상태 및 해시 비교
```bash
git status --porcelain --untracked-files=all > /tmp/wo13a2/status-after.txt; rc=$?; echo "status-after exit=$rc"
grep -v '\.agents/session-contracts/\.recovery/' /tmp/wo13a2/status-before.txt | sort > /tmp/wo13a2/sb.txt; grep -v '\.agents/session-contracts/\.recovery/' /tmp/wo13a2/status-after.txt | sort > /tmp/wo13a2/sa.txt; diff /tmp/wo13a2/sb.txt /tmp/wo13a2/sa.txt
git diff --stat
sha256sum -c /tmp/wo13a2/hash-before.txt > /tmp/wo13a2/hash-check.txt 2>&1; rc=$?; echo "hash-check exit=$rc"; grep -v ": OK$" /tmp/wo13a2/hash-check.txt
```
출력:
```
status-after exit=0
0a1,4
>  M src/main/adapters/webllm-provider.ts
>  M src/test/browser-agent.integration.test.ts
>  M src/test/browser-read-tools.contract.test.ts
>  M src/test/webllm-provider.contract.test.ts
src/main/adapters/webllm-provider.ts         |   4 +-
 src/test/browser-agent.integration.test.ts   |   8 +-
 src/test/browser-read-tools.contract.test.ts |  52 +++++----
 src/test/webllm-provider.contract.test.ts    | 169 ++++++++++++++++++++++-----
 4 files changed, 177 insertions(+), 56 deletions(-)
hash-check exit=0
.agents/progress/naia-web-wo-02b-report.md: 성공
.agents/progress/naia-web-wo-03-report.md: 성공
.agents/progress/naia-web-wo-03b-report.md: 성공
.agents/progress/naia-web-wo-03c-report.md: 성공
.agents/progress/naia-web-wo-07-report.md: 성공
.agents/progress/naia-web-wo-13a-report.md: 성공
```

---

## 4. 최종 판정 판정 조건 충족 확인

- `before-json rc=0`, `after-json rc=0`: 충족 (`before-json rc=0`, `after-json rc=0`)
- `focus`(0), `need`(0), 반복 세 번(0, 0, 0), `tsc`(0), `build`(0), `cmp`(0) 종료 값 0: 충족
- `need.log` 마지막 줄 `missing=0`: 충족 (`required=298 missing=0`)
- `cmp.log` 마지막 줄: `new-fail=0 new-file-error=0 lost=0 renamed-exempt=0 new-skip=0 vanished=0 gained=0`: 충족
- `cmp.log` 첫 줄 JSON `after.failed` (25) <= `before.failed` (25) 및 `after.fileErrors` (0) <= `before.fileErrors` (0): 충족
- `list-before`(0), `hash-before`(0) 종료 값 0: 충족
- `hash-check`에서 1절 허용 파일 외 변경/깨짐 없음: 충족 (`hash-check exit=0`)
- `status` 차이 및 `git diff --stat`에 1절 허용 파일 4개만 노출: 충족
