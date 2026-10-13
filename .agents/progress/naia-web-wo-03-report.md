# WO-03: naia-agent WebLLM 공급자 어댑터 실행 보고

## 1. 커밋 정보

- 커밋 sha: `ff9592f9b0cdf3062ed53a4ef0f91a5f78430a40` (`ff9592f`)
- 커밋 메시지: `feat(browser): add WebLLM provider adapter with injected engine (#156)`

## 2. 바꾼 파일 목록

- `src/main/adapters/webllm-provider.ts`
- `src/main/domain/provider-route.ts`
- `src/main/adapters/provider-resolver.ts`
- `src/main/composition/browser-agent.ts`
- `.agents/context/module-manifest.json`
- `src/test/webllm-provider.contract.test.ts`
- `src/test/browser-boundary.contract.test.ts`

## 3. 7절 명령 및 출력

### 시작 전 앵커 상태 (변경 전 기준값)

```bash
node scripts/check-file-anchors.mjs > /tmp/wo03-anchors-before.log 2>&1; echo "anchors-before exit=$?"
grep -c '^\[file-anchors\] RED — [0-9]*건 드리프트:$' /tmp/wo03-anchors-before.log; grep '^  ✗ ' /tmp/wo03-anchors-before.log | sort > /tmp/wo03-anchors-before.txt; wc -l < /tmp/wo03-anchors-before.txt
```

출력:
```
anchors-before exit=1
1
35
```

`head -1 /tmp/wo03-anchors-before.log`:
```
[file-anchors] RED — 35건 드리프트:
```

---

### 명령 1. tsc 타입 검사

```bash
pnpm exec tsc --noEmit -p .; echo "exit=$?"
```

출력 끝 20줄:
```
exit=0
```

---

### 명령 2. webllm-provider 계약 시험

```bash
pnpm vitest run src/test/webllm-provider.contract.test.ts; echo "exit=$?"
```

출력 끝 20줄:
```
 ✓ src/test/webllm-provider.contract.test.ts (16) 346ms
   ✓ WebLLM 공급자 어댑터 계약 시험 (FE-08) (16) 345ms
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

 Test Files  1 passed (1)
      Tests  16 passed (16)
   Start at  20:12:55
   Duration  778ms (transform 195ms, setup 0ms, collect 226ms, tests 346ms, environment 0ms, prepare 55ms)

exit=0
```

---

### 명령 3. 브라우저 경계 및 연관 시험 5개

```bash
pnpm vitest run src/test/browser-boundary.contract.test.ts src/test/browser-agent.integration.test.ts src/test/port-line-io.test.ts src/test/import-boundary.contract.test.ts src/test/all-providers-wiring.contract.test.ts; echo "exit=$?"
```

출력 끝 20줄:
```
 ✓ src/test/all-providers-wiring.contract.test.ts (11)
 ✓ src/test/browser-agent.integration.test.ts (3) 1358ms
 ✓ src/test/browser-boundary.contract.test.ts (42)
 ✓ src/test/import-boundary.contract.test.ts (3)
 ✓ src/test/port-line-io.test.ts (4)

 Test Files  5 passed (5)
      Tests  63 passed (63)
   Start at  20:13:00
   Duration  1.82s (transform 309ms, setup 0ms, collect 1.06s, tests 1.39s, environment 1ms, prepare 212ms)

exit=0
```

---

### 명령 4. 로깅 검사

```bash
node scripts/check-logging.mjs; echo "exit=$?"
```

출력 끝 20줄:
```
[check-logging] OK — src 전부 표준 로깅(DiagnosticLog). console.*/직접 write 0건.
exit=0
```

---

### 명령 5. 앵커 검사

```bash
node scripts/check-file-anchors.mjs > /tmp/wo03-anchors-after.log 2>&1; echo "anchors-after exit=$?"
head -1 /tmp/wo03-anchors-after.log
grep '^  ✗ ' /tmp/wo03-anchors-after.log | sort > /tmp/wo03-anchors-after.txt; echo "anchors-after=$(wc -l < /tmp/wo03-anchors-after.txt)"
comm -13 /tmp/wo03-anchors-before.txt /tmp/wo03-anchors-after.txt; echo "new-anchor-lines=$(comm -13 /tmp/wo03-anchors-before.txt /tmp/wo03-anchors-after.txt | wc -l)"
grep -n 'webllm-provider' /tmp/wo03-anchors-after.txt; echo "webllm-anchor-grep=$?"
```

출력 끝 20줄:
```
anchors-after exit=1
[file-anchors] RED — 35건 드리프트:
anchors-after=35
new-anchor-lines=0
webllm-anchor-grep=1
```

---

### 명령 6. 전체 시험 검증

```bash
pnpm test > /tmp/wo03-test.log 2>&1; echo "test exit=$?"
grep -E "^ (Test Files|     Tests|    Errors) " /tmp/wo03-test.log
grep -E "^ FAIL " /tmp/wo03-test.log | sort -u > /tmp/wo03-fail.txt
comm -13 /var/home/luke/alpha-adk/.agents/progress/naia-web-20261003/agent-baseline-failures-3b0e101c.txt /tmp/wo03-fail.txt; echo "new-fail-lines=$(comm -13 /var/home/luke/alpha-adk/.agents/progress/naia-web-20261003/agent-baseline-failures-3b0e101c.txt /tmp/wo03-fail.txt | wc -l)"
comm -23 /var/home/luke/alpha-adk/.agents/progress/naia-web-20261003/agent-baseline-failures-3b0e101c.txt /tmp/wo03-fail.txt
awk '/^⎯+ (Unhandled [A-Za-z]+|Uncaught Exception) ⎯+$/{getline; split($0,a,":"); cls=a[1]} /^This error originated in /{match($0,/"[^"]+"/); print cls" "substr($0,RSTART,RLENGTH)}' /tmp/wo03-test.log | sort > /tmp/wo03-errors.txt; echo "awk=$?"; cat /tmp/wo03-errors.txt
```

출력 끝 20줄:
```
test exit=1
 Test Files  5 failed | 172 passed | 3 skipped (180)
      Tests  25 failed | 2148 passed | 11 skipped (2184)
     Errors  2 errors
new-fail-lines=0
awk=0
AssertionError "src/test/uc-naia-pi-cli-process.integration.test.ts"
SyntaxError "src/test/uc-naia-pi-controlled.integration.test.ts"
```

## 4. 경계 시험 도달 파일 수와 목록

도달 파일 수: 23개

도달 파일 목록:
- `src/main/adapters/approval.ts`
- `src/main/adapters/budgeted-conversation.ts`
- `src/main/adapters/composite-tool-executor.ts`
- `src/main/adapters/diagnostic.ts`
- `src/main/adapters/fake-provider.ts`
- `src/main/adapters/memory-skill.ts`
- `src/main/adapters/port-line-io.ts`
- `src/main/adapters/protocol.ts`
- `src/main/adapters/redact.ts`
- `src/main/adapters/signal-util.ts`
- `src/main/adapters/stdio.ts`
- `src/main/adapters/webllm-provider.ts`
- `src/main/app/chat-turn-handler.ts`
- `src/main/composition/browser-agent.ts`
- `src/main/composition/uc1-wiring.ts`
- `src/main/domain/chat.ts`
- `src/main/domain/cost.ts`
- `src/main/domain/environment-segments.ts`
- `src/main/domain/memory.ts`
- `src/main/domain/persona.ts`
- `src/main/domain/security-wire.ts`
- `src/main/domain/surfacing.ts`
- `src/main/domain/workspace-context.ts`

## 5. 끝단 시험에서 받은 줄 원문 전부 (취소 시험 포함)

```json
[
  "{\"type\":\"text\",\"requestId\":\"e1\",\"text\":\"가\"}",
  "{\"type\":\"text\",\"requestId\":\"e1\",\"text\":\"나\"}",
  "{\"type\":\"text\",\"requestId\":\"e1\",\"text\":\"다\"}",
  "{\"type\":\"usage\",\"requestId\":\"e1\",\"inputTokens\":3,\"outputTokens\":5,\"cost\":0,\"model\":\"m\"}",
  "{\"type\":\"finish\",\"requestId\":\"e1\"}",
  "{\"type\":\"text\",\"requestId\":\"c1\",\"text\":\"가\"}",
  "{\"type\":\"usage\",\"requestId\":\"c1\",\"inputTokens\":0,\"outputTokens\":0,\"cost\":0,\"model\":\"m\"}",
  "{\"type\":\"error\",\"requestId\":\"c1\",\"message\":\"cancelled\"}",
  "{\"type\":\"text\",\"requestId\":\"c2\",\"text\":\"가\"}",
  "{\"type\":\"text\",\"requestId\":\"c2\",\"text\":\"나\"}",
  "{\"type\":\"text\",\"requestId\":\"c2\",\"text\":\"다\"}",
  "{\"type\":\"usage\",\"requestId\":\"c2\",\"inputTokens\":3,\"outputTokens\":5,\"cost\":0,\"model\":\"m\"}",
  "{\"type\":\"finish\",\"requestId\":\"c2\"}"
]
```

## 6. /tmp/wo03-fail.txt 전체

```
 FAIL  src/test/cli-manage-process.integration.test.ts > TEST-S-020 isolated HOME management flow > config is allowlisted, atomic-readable, and models/doctor JSON stay machine-readable
 FAIL  src/test/issue-team-benchmark.contract.test.ts > REQ-023 deterministic issue-team benchmark > rejects a adapterBoundary counterexample
 FAIL  src/test/issue-team-benchmark.contract.test.ts > REQ-023 deterministic issue-team benchmark > rejects a compositionBoundary counterexample
 FAIL  src/test/issue-team-benchmark.contract.test.ts > REQ-023 deterministic issue-team benchmark > rejects a convergence counterexample
 FAIL  src/test/issue-team-benchmark.contract.test.ts > REQ-023 deterministic issue-team benchmark > rejects a costAccounting counterexample
 FAIL  src/test/issue-team-benchmark.contract.test.ts > REQ-023 deterministic issue-team benchmark > rejects a duplicateDispatch counterexample
 FAIL  src/test/issue-team-benchmark.contract.test.ts > REQ-023 deterministic issue-team benchmark > rejects a legacyPreservation counterexample
 FAIL  src/test/issue-team-benchmark.contract.test.ts > REQ-023 deterministic issue-team benchmark > rejects a ordering counterexample
 FAIL  src/test/issue-team-benchmark.contract.test.ts > REQ-023 deterministic issue-team benchmark > rejects a parentBoundary counterexample
 FAIL  src/test/issue-team-benchmark.contract.test.ts > REQ-023 deterministic issue-team benchmark > rejects a productionRouting counterexample
 FAIL  src/test/issue-team-benchmark.contract.test.ts > REQ-023 deterministic issue-team benchmark > rejects a receiptIsolation counterexample
 FAIL  src/test/issue-team-benchmark.contract.test.ts > REQ-023 deterministic issue-team benchmark > rejects a recovery counterexample
 FAIL  src/test/issue-team-benchmark.contract.test.ts > REQ-023 deterministic issue-team benchmark > rejects a writeBoundary counterexample
 FAIL  src/test/issue-team-benchmark.contract.test.ts > REQ-023 deterministic issue-team benchmark > replays the real SQLite state machine with no paid call
 FAIL  src/test/multi-issue-benchmark.contract.test.ts > UC-ORCH-002 deterministic benchmark claim gates > rejects a completion counterexample
 FAIL  src/test/multi-issue-benchmark.contract.test.ts > UC-ORCH-002 deterministic benchmark claim gates > rejects a concurrency counterexample
 FAIL  src/test/multi-issue-benchmark.contract.test.ts > UC-ORCH-002 deterministic benchmark claim gates > rejects a costAccounting counterexample
 FAIL  src/test/multi-issue-benchmark.contract.test.ts > UC-ORCH-002 deterministic benchmark claim gates > rejects a fairness counterexample
 FAIL  src/test/multi-issue-benchmark.contract.test.ts > UC-ORCH-002 deterministic benchmark claim gates > rejects a isolation counterexample
 FAIL  src/test/multi-issue-benchmark.contract.test.ts > UC-ORCH-002 deterministic benchmark claim gates > rejects a restart counterexample
 FAIL  src/test/multi-issue-benchmark.contract.test.ts > UC-ORCH-002 deterministic benchmark claim gates > rejects a visibility counterexample
 FAIL  src/test/multi-issue-benchmark.contract.test.ts > UC-ORCH-002 deterministic benchmark claim gates > runs the real manager/SQLite workload and derives every passing observation
 FAIL  src/test/pi-cost-comparison-runner.contract.test.ts > Pi live cost-comparison runner > runs the production analyzer handler with a valid, wrong, and missing external journal key
 FAIL  src/test/uc-naia-pi-cli-process.integration.test.ts > UC-NAIA-PI actual CLI process and stored login
 FAIL  src/test/uc-naia-pi-cli-process.integration.test.ts > UC-NAIA-PI actual CLI process and stored login > reuses isolated-home login and produces equivalent direct/parent JSON evidence
```

## 7. /tmp/wo03-errors.txt 전체

```
AssertionError "src/test/uc-naia-pi-cli-process.integration.test.ts"
SyntaxError "src/test/uc-naia-pi-controlled.integration.test.ts"
```

## 8. 막힌 곳과 이유

1. `FakeWebLLMEngine`의 `streamGenerator()` 반환 타입이 처음에 `AsyncIterable`로 선언되어 generator의 `return`/`throw` 속성 접근 시 tsc 타입 에러가 발생함. `AsyncGenerator<WebLLMChatChunk, void, unknown>`으로 수정하여 해결함.
2. `inlineImages` 테스트 케이스에서 `InlineImage` 인터페이스의 프로퍼티가 `dataBase64`가 아닌 `data`여서 tsc 에러가 발생함. `data`로 수정하여 해결함.
3. `첫 조각 뒤 취소` 시험에서 바깥 `for await` 루프는 `return`으로 즉시 끝나지만 비동기 백그라운드 태스크로 수행되는 `drainStream`이 `done: true`에 도달하기 전 microtask 타이밍에 단언이 실행되어 `reachedDone`이 일시적으로 `false`로 관찰됨. 단언 직전 백그라운드 소진 대기(`await new Promise(r => setTimeout(r, 50))`)를 추가하여 해결함.
4. 전체 `pnpm test` 첫 실행 시 `memory-settings-reload.contract.test.ts`가 병렬 실행 간섭으로 실패하였으나, 단독 실행 및 전체 재실행 시 정상 통과하여 `new-fail-lines=0` 기준선과 일치함을 확인하고 기록함.
