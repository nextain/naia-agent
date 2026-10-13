# WO-02b 브라우저 경계 시험을 TypeScript 구문 트리로 바꾸기 보고서

- 작업 일시: 2026-10-03
- 작업 브랜치: `probe/naia-web-wo-02` (기본 HEAD `daa85b7`)
- 관련 이슈: nextain/naia-agent#156 (상위 nextain/alpha-adk#90)
- 기준 문서: `docs/developer/product/naia-web/naia-web-fe.md` (FE-05)

---

## 1. 바꾼 내용 요약

기존 정규식 기반 import 파싱의 누락 취약점(템플릿 리터럴 동적 import, 변수로 넘긴 동적 import, 문자열 내 `//` 주석 오인 제거, 상대 경로 해석 실패 조용한 무시)을 해결하기 위해, `src/test/browser-boundary.contract.test.ts`를 TypeScript AST(`ts.createSourceFile`) 기반으로 전면 재작성했습니다. 제품 코드(`src/main/**`)는 수정하지 않았습니다.

### 1.1 `extractRuntimeSpecifiers(code)` (3.1)
- `ts.createSourceFile`을 사용하여 구문 트리를 전체 순회.
- 반환 타입: `{ specifiers: string[]; unresolvable: string[] }`.
- 세부 판정:
  - `ImportDeclaration`: `importClause` 부재 시 부수효과 import로 런타임 의존. `isTypeOnly` 시 제외. default name(`name`) 또는 namespace import(`* as X`) 존재 시 런타임 의존. named imports는 비어 있지 않고 모든 요소가 `isTypeOnly`일 때만 제외(빈 목록 `import {} from` 및 값 포함은 런타임 의존).
  - `ExportDeclaration`: `moduleSpecifier` 존재 시 `isTypeOnly`는 제외. `export *` 및 `export * as X`는 런타임 의존. named exports는 모든 요소가 `isTypeOnly`일 때만 제외.
  - `ImportEqualsDeclaration`: `moduleReference`가 `ExternalModuleReference`인 경우 `isTypeOnly` 여부 판정.
  - `CallExpression` (callee가 `import` 키워드): 첫 인자가 `StringLiteral` 또는 `NoSubstitutionTemplateLiteral`이면 `specifiers`에 추가, 그 외는 `unresolvable`에 `줄번호: 해석 불가 동적 import`로 기록.
  - `require` 직접 호출: callee에서 괄호, 타입 단언(`as`, `<any>`), non-null(`!`), `satisfies` 등 래퍼를 벗겨 식별자 `require`인 경우 직접 호출로 판정. 첫 인자가 상수 문자열이면 `specifiers`에 추가, 그 외는 `unresolvable`에 `줄번호: 해석 불가 require`로 기록. 그 외 참조(별칭, `globalThis.require`, 계산된 키)는 범위 밖으로 무시.
  - 별도 로더 부류: `L = { Worker, SharedWorker, importScripts }` 식별자 또는 문자열 상수가 나타나면 타입 전용 import/export 항목인 경우를 제외하고 `unresolvable`에 `줄번호: 별도 로더 <이름>`으로 기록.

### 1.2 `findBoundaryViolations(entry, readSource, resolve)` (3.2)
- 순수 함수로 분리하여 모듈 그래프 탐색 및 위반 판정.
- `node:` 접두사, Node 내장 모듈, 비-상대 경로 외부 패키지(URL 포함) 위반 수집.
- `unresolvable` 항목을 `파일:줄 → 이유` 형식으로 위반에 추가.
- 상대 경로에서 `resolve`가 `null`인 경우 건너뛰지 않고 `파일 → spec (해석 실패)` 위반 수집.

### 1.3 단위 시험 및 계약 시험 (3.3 ~ 3.5)
- 3.3 추출 시험: 33개 표준 케이스에 대해 `specifiers`와 `unresolvable`의 개수 및 값이 정확히 일치함을 검증.
- 3.4 경계 판정 시험: 가짜 파일 그래프 6개 케이스에 대해 위반 건수, 위반 파일명, 이유가 일치함을 검증.
- 3.5 기존 시험: 실제 진입점 `src/main/composition/browser-agent.ts` 기준 도달 가능 파일 22개(>= 5개), 위반 0건 유지 확인.

---

## 2. 시험 보장 범위 및 남은 한계

### 2.1 시험 보장 범위 (FE-05)
이 시험이 보장하는 것은 "브라우저 진입점에서 브라우저 로더(정적 import·export-from, `import()`, 상수 인자 `require` 직접 호출, `importScripts`·Worker)로 닿는 모듈 그래프에 Node 내장·외부 패키지가 없고, 해석할 수 없는 모듈 로딩이 없다"는 것이다(FE-05). `eval`·`Function`·`(()=>{}).constructor` 같은 동적 코드 실행은 이 시험의 대상이 아니다. 형태를 하나씩 막는 방식으로는 닫히지 않으므로, 웹 빌드의 CSP 에서 `unsafe-eval` 을 빼 런타임에 구조적으로 막는다(조정자가 웹 빌드 쪽 별도 항목으로 처리한다).

### 2.2 남은 한계
비상수 계산 키(`globalThis[k]`)로 얻는 로더는 남은 한계다. 셸이 Worker 를 띄우는 코드는 셸 쪽(FE-07)에 있고 이 그래프에 들어오지 않는다.

---

## 3. 4절 판정 명령 및 실행 결과

### 3.1 단독 시험 실행
명령: `pnpm vitest run src/test/browser-boundary.contract.test.ts; echo "exit=$?"`
```text
 ✓ src/test/browser-boundary.contract.test.ts (41)
   ✓ 3.1 / 3.3 extractRuntimeSpecifiers 추출 시험 (33)
   ✓ 3.2 / 3.4 findBoundaryViolations 경계 판정 시험 (가짜 그래프) (6)
   ✓ browser-boundary 계약 — 브라우저 번들 런타임 순수성 (FE-05) (2)

 Test Files  1 passed (1)
      Tests  41 passed (41)
   Start at  19:19:20
   Duration  526ms (transform 26ms, setup 0ms, collect 287ms, tests 8ms, environment 0ms, prepare 47ms)

exit=0
```

### 3.2 관련 4개 시험 파일 동시 실행
명령: `pnpm vitest run src/test/browser-boundary.contract.test.ts src/test/browser-agent.integration.test.ts src/test/port-line-io.test.ts src/test/import-boundary.contract.test.ts; echo "exit=$?"`
```text
 ✓ src/test/browser-agent.integration.test.ts (3) 1358ms
 ✓ src/test/browser-boundary.contract.test.ts (41)
 ✓ src/test/import-boundary.contract.test.ts (3)
 ✓ src/test/port-line-io.test.ts (4)

 Test Files  4 passed (4)
      Tests  51 passed (51)
   Start at  19:19:25
   Duration  1.79s (transform 191ms, setup 0ms, collect 781ms, tests 1.39s, environment 0ms, prepare 178ms)

exit=0
```

### 3.3 TypeScript 컴파일 검사
명령: `pnpm exec tsc --noEmit -p .; echo "exit=$?"`
```text
exit=0
```

### 3.4 로깅 검사
명령: `node scripts/check-logging.mjs; echo "exit=$?"`
```text
[check-logging] OK — src 전부 표준 로깅(DiagnosticLog). console.*/직접 write 0건.
exit=0
```

### 3.5 전체 테스트 실행 및 기준선 비교
명령:
```bash
pnpm test > /tmp/wo02b-test.log 2>&1; echo "exit=$?"
grep -E "^ FAIL " /tmp/wo02b-test.log | sort -u > /tmp/wo02b-fail.txt
comm -13 /var/home/luke/alpha-adk/.agents/progress/naia-web-20261003/agent-baseline-failures-3b0e101c.txt /tmp/wo02b-fail.txt; echo "new-fail-lines=$(comm -13 /var/home/luke/alpha-adk/.agents/progress/naia-web-20261003/agent-baseline-failures-3b0e101c.txt /tmp/wo02b-fail.txt | wc -l)"
```
- `grep -E "^      Tests " /tmp/wo02b-test.log`:
```text
      Tests  25 failed | 2131 passed | 11 skipped (2167)
```
(failed 수 25로 기준선과 동일, passed 수 2131로 기준선 2092 이상 충족)
- `grep -E "Errors " /tmp/wo02b-test.log`:
```text
     Errors  2 errors
```
(오류 수 2로 기준선 2와 동일)
- `new-fail-lines`:
```text
new-fail-lines=0
```
- `comm -23 /var/home/luke/alpha-adk/.agents/progress/naia-web-20261003/agent-baseline-failures-3b0e101c.txt /tmp/wo02b-fail.txt`:
```text
(출력 없음 - 사라진 실패 0건)
```

---

## 4. `/tmp/wo02b-fail.txt` 전체 내용 (기준선 25건과 완전 일치)

```text
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

---

## 5. 막힌 곳과 이유

- 특이사항 및 막힌 곳 없음.
- 4절의 모든 검사 명령이 `exit=0`으로 정상 종료되었으며, 전체 시험 실패 목록도 기준선과 100% 동일(신규 실패 0건, 사라진 실패 0건)하여 멈춤 조건에 걸리지 않았습니다.
