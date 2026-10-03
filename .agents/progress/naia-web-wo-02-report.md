# naia-web-wo-02 작업 보고

## 1. 커밋 sha 목록

- `33241a33fc7038637849aacfecc33f5277de5c0b`: feat(browser): add browser composition entry and MessagePort LineIO adapter
- `e49d6d6e24d27208aa08ded4742fcf6485c9fef5`: docs(probe): record WO-02 verification report

## 2. 바꾼 파일 목록

- `src/main/composition/index.ts`
- `src/main/composition/uc1-wiring.ts`
- `src/main/composition/browser-agent.ts`
- `src/main/adapters/port-line-io.ts`
- `.agents/context/module-manifest.json`
- `src/test/browser-boundary.contract.test.ts`
- `src/test/port-line-io.test.ts`
- `src/test/browser-agent.integration.test.ts`
- `.agents/progress/naia-web-wo-02-report.md`

## 3. 경계 시험이 모은 파일 수와 목록

- 모인 파일 수: 22개
- 목록:
  - `src/main/composition/browser-agent.ts`
  - `src/main/composition/uc1-wiring.ts`
  - `src/main/adapters/port-line-io.ts`
  - `src/main/adapters/stdio.ts`
  - `src/main/adapters/protocol.ts`
  - `src/main/adapters/fake-provider.ts`
  - `src/main/adapters/approval.ts`
  - `src/main/adapters/diagnostic.ts`
  - `src/main/adapters/redact.ts`
  - `src/main/adapters/budgeted-conversation.ts`
  - `src/main/adapters/memory-skill.ts`
  - `src/main/adapters/composite-tool-executor.ts`
  - `src/main/adapters/signal-util.ts`
  - `src/main/app/chat-turn-handler.ts`
  - `src/main/domain/chat.ts`
  - `src/main/domain/cost.ts`
  - `src/main/domain/environment-segments.ts`
  - `src/main/domain/memory.ts`
  - `src/main/domain/persona.ts`
  - `src/main/domain/security-wire.ts`
  - `src/main/domain/surfacing.ts`
  - `src/main/domain/workspace-context.ts`

## 4. 취소 시험에서 받은 `c1` 줄 원문 전부

```json
{"type":"text","requestId":"c1","text":"partial"}
{"type":"usage","requestId":"c1","inputTokens":0,"outputTokens":0,"cost":0,"model":"m"}
{"type":"error","requestId":"c1","message":"cancelled"}
```

## 5. 6절 명령별 종료 코드와 출력 끝 20줄

### 5.1 `pnpm build; echo "exit=$?"`

- 종료 코드: `exit=0`
- 출력 끝부분:

```text
> @nextain/naia-agent@0.0.0 build /var/home/luke/alpha-adk/projects/naia-web-probe/naia-agent
> tsc -p tsconfig.json

exit=0
```

### 5.2 `pnpm vitest run src/test/browser-boundary.contract.test.ts src/test/browser-agent.integration.test.ts src/test/port-line-io.test.ts src/test/import-boundary.contract.test.ts; echo "exit=$?"`

- 종료 코드: `exit=0`
- 출력 끝 20줄:

```text
 ✓ src/test/browser-boundary.contract.test.ts (2)
 ✓ src/test/browser-agent.integration.test.ts (3) 1359ms
 ✓ src/test/import-boundary.contract.test.ts (3)
 ✓ src/test/port-line-io.test.ts (4)

 Test Files  4 passed (4)
      Tests  12 passed (12)
   Start at  18:32:46
   Duration  1.79s (transform 210ms, setup 0ms, collect 437ms, tests 1.39s, environment 1ms, prepare 257ms)

exit=0
```

### 5.3 `node scripts/check-file-anchors.mjs 2>&1 | grep '✗'; echo "exit=${PIPESTATUS[0]}"`

- 종료 코드: `exit=1`
- `✗` 줄 수: 35줄 (기준 커밋과 동일 수치, 신규 3개 파일 미포함)
- 출력 끝 20줄:

```text
  ✗ 미계약 코드(앵커 없음): src/main/domain/anyllm-provider-catalog.ts — module-manifest.json 에 {layer,uc,contract} 선언 먼저.
  ✗ 미계약 코드(앵커 없음): src/main/domain/coding-job.ts — module-manifest.json 에 {layer,uc,contract} 선언 먼저.
  ✗ 미계약 코드(앵커 없음): src/main/domain/durable-supervisor.ts — module-manifest.json 에 {layer,uc,contract} 선언 먼저.
  ✗ 미계약 코드(앵커 없음): src/main/domain/jeonju-course.ts — module-manifest.json 에 {layer,uc,contract} 선언 먼저.
  ✗ 미계약 코드(앵커 없음): src/main/domain/llm-roles.ts — module-manifest.json 에 {layer,uc,contract} 선언 먼저.
  ✗ 미계약 코드(앵커 없음): src/main/domain/surfacing.ts — module-manifest.json 에 {layer,uc,contract} 선언 먼저.
  ✗ 미계약 코드(앵커 없음): src/main/ports/coding-job.ts — module-manifest.json 에 {layer,uc,contract} 선언 먼저.
  ✗ 미계약 코드(앵커 없음): src/main/ports/durable-supervisor.ts — module-manifest.json 에 {layer,uc,contract} 선언 먼저.
  ✗ 미계약 코드(앵커 없음): src/main/ports/outbound-delivery.ts — module-manifest.json 에 {layer,uc,contract} 선언 먼저.
  ✗ 미계약 코드(앵커 없음): src/main/ports/surfacing.ts — module-manifest.json 에 {layer,uc,contract} 선언 먼저.
  ✗ stale 앵커(파일 없음): src/main/adapters/panel-tool-executor.ts
  ✗ stale 앵커(파일 없음): src/main/adapters/cron-skills.ts
  ✗ src/main/adapters/panel-tool-executor.ts: contract 문서 부재(stale 앵커): .agents/progress/panel-skill-grpc-port-2026-06-24.md
exit=1
```

### 5.4 `node scripts/check-logging.mjs; echo "exit=$?"`

- 종료 코드: `exit=0`
- 출력:

```text
[check-logging] OK — src 전부 표준 로깅(DiagnosticLog). console.*/직접 write 0건.
exit=0
```

### 5.5 `pnpm test; echo "exit=$?"`

- 종료 코드: `exit=1`
- 결과 요약: `Test Files 5 failed | 171 passed | 3 skipped (179)`, `Tests 25 failed | 2092 passed | 11 skipped (2128)`
- 실패 파일 5건:
  - `src/test/uc-naia-pi-cli-process.integration.test.ts`
  - `src/test/cli-manage-process.integration.test.ts`
  - `src/test/issue-team-benchmark.contract.test.ts`
  - `src/test/multi-issue-benchmark.contract.test.ts`
  - `src/test/pi-cost-comparison-runner.contract.test.ts`
- 출력 끝 20줄:

```text
 ❯ IncomingMessage.<anonymous> src/test/uc-naia-pi-cli-process.integration.test.ts:40:43
     38|       upstreamCalls += 1;
     39|       expect(body.model).toBe("grok-4.3");
     40|       expect(req.headers["x-anyllm-key"]).toBe("Bearer stored-test-key…
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
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 Test Files  5 failed | 171 passed | 3 skipped (179)
      Tests  25 failed | 2092 passed | 11 skipped (2128)
     Errors  2 errors
   Start at  18:33:06
   Duration  72.34s (transform 14.04s, setup 0ms, collect 49.03s, tests 212.23s, environment 34ms, prepare 11.55s)

 ELIFECYCLE  Test failed. See above for more details.
exit=1
```

## 6. 막힌 곳과 그 이유

- 없음.
