# R4 Phase 1 — Week 1 Spec (5일, 정량화)

> **session_id**: c03e4e41-9ef4-4809-9ec2-60329e3db5fa
> **상위**: `r4-hybrid-wrapper-2026-04-26.md`, `r4-week0-cross-review-summary.md`, `r4-week0-cross-review-2nd-summary.md`
> **status**: **LOCK (2026-04-26 R4 Week 0 종료)**
> **purpose**: Phase 1 정량화 (P0-3 처리, Paranoid optimism bias A1 완화)
>
> ## opencode CLI spike 결과 (2026-04-26)
> - `opencode-ai@1.14.25` install 성공
> - **`opencode run --format json "<prompt>"`** = 1-turn JSON event stream 지원 (Phase 1에 정확히 fit)
> - `--continue / --session <id>` session 관리, `-m provider/model` 명시 가능
> - `opencode acp` = 별도 ACP server mode (Phase 2 진입 시)
> - `--print-logs` stderr (debug용)
> - **결론**: Phase 1은 ACP 없이 `opencode run --format json`으로 직접 호출. JSON event stream → NaiaStreamChunk 변환 (ACP 대비 단순, refactor 비용 낮음)

---

## 1. Phase 1 success criterion (정량 — Paranoid P0-5 fix)

사용자가 다음 명령 실행:

```bash
pnpm naia-agent "src/utils/hello.ts에 hello(name: string): string 함수 추가해"
```

**기대 출력 (CLI text-only, UI 없음, Phase 1 한정)**:

```
[알파] task 시작: src/utils/hello.ts에 hello() 함수 추가
[opencode 0001] spawning opencode (workdir=/path/to/repo) ...
[opencode 0001] phase: planning
[opencode 0001] phase: editing
  ✚ src/utils/hello.ts (+5 line)
[opencode 0001] phase: testing
[verify] running pnpm test ...
[verify] test 24/24 PASS (3.2s)
[verify] running pnpm typecheck ...
[verify] typecheck PASS (1.8s)
[알파] 완료
        files: 1 (+5/-0)
        tests: 24/24 PASS
        typecheck: PASS
        elapsed: 12.4s
```

### 검증 체크리스트 (5건 모두 ✓)

| # | 검증 | 측정 |
|:---:|---|---|
| 1 | opencode child process spawn 성공 | exit code 0, session_start emit |
| 2 | workspace file watcher가 src/utils/hello.ts 추가 감지 | workspace_change emit (kind:"add") |
| 3 | `pnpm test` 자동 실행 + pass/fail count parse | verification_result emit (pass:true) |
| 4 | 수치 보고 정확 (file/line/test count) | report.stats 정확 |
| 5 | E2E 1회 사용자 직접 실행 + "유용 vs 무용" 판단 | 사용자 답변 |

### 명시적 OUT-of-scope (Phase 1 안 함)

| 항목 | 이연 |
|---|---|
| ACP 정식 통합 (event capture, approval gate) | Phase 2 |
| Sub-session 카드 UI (CLI text dashboard) | Phase 3 |
| Voice interrupt ("중지중지") | Phase 4 |
| Multi-session 병렬 | Phase 3 |
| alpha-memory 통합 | Phase 3 |
| Claude SDK adapter | Phase 2~3 |
| naia-shell UI 통합 | Phase 4 |
| Adversarial review | Phase 4 |
| vllm-omni audio | Phase 4 |
| **assertion-level verification** ("hello() 호출 가능성 자동 test") — Paranoid P1-4 | Phase 2+ |

→ Phase 1 verification = **"기존 test 미파괴 + 변경 사실 보고"** 수준 (정직 명시).

---

## 2. 일별 task spec (5일, 정량 시간 + 여유)

### Day 1 (월) — shell adapter + 의존 lint setup (4h target, 4h 여유)

| step | 시간 | deliverable |
|---|---|---|
| 1.1 | 30min | **(Architect P0-2)** `packages/adapters/shell/` + 5 신규 pkg (workspace/verification/apps-cli/adapters-opencode-cli) tsconfig project references + eslint `import/no-restricted-paths` rules 통합 setup |
| 1.2 | 1h | `ShellAdapter implements SubAgentAdapter` (단순 child_process spawn, stdio passthrough, workdir 강제 cwd) |
| 1.3 | 1h | `events()` 구현 (stdout 텍스트를 NaiaStreamChunk로 변환 — text_delta + session_start/end) + redact wrapper (P0-6) |
| 1.4 | 30min | `cancel()` (SIGTERM + 500ms 후 SIGKILL — C12 contract) |
| 1.5 | 1h | unit test (mock child_process, contract test C1~C10 일부, A6 path traversal fixture) |
| **합** | **4h** | shell adapter PR-ready + 5 pkg lint/tsconfig 정합 |

**검증**: `pnpm test --filter @nextain/agent-adapter-shell` 통과 + `pnpm lint` 0 error

### Day 2 (화) — opencode CLI `run --format json` adapter (5h target, 7h 여유)

> Phase 1 = `opencode run --format json "<prompt>"` 사용. JSON event stream 받아 NaiaStreamChunk 변환. ACP는 Phase 2.

| step | 시간 | deliverable |
|---|---|---|
| **2.0** | **15min** | **(P0-2 obligatory smoke) `pnpm smoke:opencode "hello"` — Day 2 첫 작업. fail 시 즉시 fallback (사용자 PATH or shell-only)** |
| 2.1 | 30min | `packages/adapters/opencode-cli/` pkg 신설 (tsconfig + eslint import rules — Day 1과 정합) |
| 2.2 | 30min | opencode binary resolve (priority: `OPENCODE_BIN` env > `npx opencode-ai@1.14.25` > 사용자 PATH `which opencode`) |
| 2.3 | 1h | `OpencodeRunAdapter extends ShellAdapter` (workdir/env 격리, path traversal 방지 — A6) |
| 2.4 | 1.5h | `opencode run --format json "<prompt>" -m <provider/model>` invoke + JSON event NDJSON parse + NaiaStreamChunk emit |
| 2.5 | 30min | scripts/smoke-opencode.ts (P0-3 fix) + package.json `"smoke:opencode"` script 추가 |
| 2.6 | 30min | unit test (mock JSON event sequence, contract test C1~C10) |
| 2.7 | 30min | A8 — opencode-ai 1.14.25 + ACP SDK 호환성 확인 메모 (Phase 2 spike에 위임 가능, Phase 1은 CLI만) |
| **합** | **5h** | opencode-cli adapter PR-ready |

**검증**: `pnpm smoke:opencode "src/utils/hello.ts에 hello() 함수 추가"` 동작 + JSON event stream 파싱 검증

**JSON event spec**: `--format json`이 emit하는 event 종류는 Day 2.4 시 `opencode run --format json "test" 2>/dev/null | head -30`로 실측 후 spec 작성 (변경 가능성 있음, opencode-ai 자체 spec).

### Day 3 (수) — workspace watcher + diff (4h target, 4h 여유)

| step | 시간 | deliverable |
|---|---|---|
| 3.1 | 30min | `packages/workspace/` pkg 신설 + chokidar 의존 |
| 3.2 | 1h | `ChokidarWatcher implements WorkspaceWatcher` (debounce 100ms, .gitignore 적용, **fallback `usePolling:true`** — Architect P1 + Paranoid fallback) |
| 3.3 | 30min | `GitDiff` (lazy `git diff --numstat` + per-path, stash/rebase 상태 처리 — Paranoid P1-2) |
| 3.4 | 30min | `WorkspaceChange` emit (NaiaStreamChunk) |
| 3.5 | 1h | unit test (race condition rapid write + stash/rebase + **A7 — 5개 파일 동시 write ordering 검증**) |
| 3.6 | 30min | E2E test fixture (file 5개 동시 write → 정확 stats + ordering) |
| **합** | **4h** | workspace pkg PR-ready |

### Day 4 (목) — verification orchestrator + reporter (4.5h target, 3.5h 여유)

| step | 시간 | deliverable |
|---|---|---|
| 4.1 | 30min | `packages/verification/` pkg 신설 |
| 4.2 | 1h | `TestVerifier` (`pnpm test` + vitest output parse → pass/fail/total) — **(P0-3 isolation) `git stash` 전 + `git stash pop` 후 강제 wrapper** (사용자 repo 보호) |
| 4.3 | 30min | `TypeCheckVerifier` (`pnpm typecheck` exit code) |
| 4.4 | 1h | `VerificationOrchestrator` (병렬 실행 + 3중 방어 D27 — abort/memory/timeout 60s + partial result emit on timeout) |
| 4.5 | 30min | `Reporter.format()` — 수치 보고 string 생성 |
| 4.6 | 30min | unit test (P0-3 격리 검증 — repo 사전/사후 git status 동일 여부) |
| 4.7 | 30min | `--no-verify` CLI flag 추가 (verification 생략, 변경 사실만 보고 — 사용자 환경 보호 fallback) |
| **합** | **4.5h** | verification pkg PR-ready |

### Day 5 (금) — apps/cli/repl + 통합 + E2E (5h target, 3h 여유 — Architect P0-1 재분배)

| step | 시간 | deliverable |
|---|---|---|
| 5.0 | 30min | **StreamMerger spike** (Architect P0-1) — interleave 정책 결정: `(A) 동일 sessionId 내 strict order` + `(B) 다른 sessionId 간 emit timestamp 오름차순 round-robin merge` 채택. fixture 1건 작성 |
| 5.1 | 1h | `apps/cli/` pkg + `bin/naia-agent` wire (기존 R3 bin 갱신, anthropic-direct path 제거 또는 deprecation warning — A9 처리) |
| 5.2 | 1.5h | Conversation + Supervisor minimal (단일 sub-agent, single turn, `extraSystemPrompt=""` 빈값 — alpha-memory는 Phase 3) |
| 5.3 | 1h | StreamMerger 구현 (5.0 spike 정책 반영) |
| 5.4 | 1h | NaiaStreamChunk → CLI text rendering (§1 기대 출력 형식) + `--no-verify` flag 통합 |
| 5.5 | 1h | E2E test ("hello() 함수 추가" 시나리오, mock LLM + 실제 opencode CLI mock) |
| 5.6 | 30min | CHANGELOG entry + README update + bin help text |
| 5.7 | 30min | 사용자에게 "직접 실행해 봐" 보고 + Phase 1 retro spec |
| **합** | **5h** | Phase 1 deliverable + 사용자 검증 대기 |

**E2E 검증** (수동, 사용자 본인):

```bash
cd ~/some-test-repo
pnpm naia-agent "src/utils/hello.ts에 hello(name: string): string 함수 추가해"
# 위 §1 기대 출력 확인
```

---

## 3. 시간 buffer 정리 (정직)

| | 작업 시간 | 여유 |
|---|---|---|
| Day 1 | 4h (linting setup +30min 포함) | 4h |
| Day 2 | 5h (smoke + JSON event parse) | 3h |
| Day 3 | 4h | 4h |
| Day 4 | 4.5h (격리 + --no-verify 포함) | 3.5h |
| Day 5 | 5h (StreamMerger spike + 분량 재분배) | 3h |
| **합** | **22.5h** | **17.5h** |
| **총합** | **40h (5일 × 8h)** |  |

**실제 여유 비율**: 17.5h / 40h = **44%** (Paranoid P0-1 정직 고지)

**1인 hidden cost 인정**:
- debug / type error / dep resolve / env issue → 평균 1.5~2배 hidden cost
- 즉 22.5h 작업 → 실제 33~45h 가능 → **5일 내 완료 confidence 약 50%** (낙관 65% / 비관 30%)
- 안전 장치: fallback chain 5건 + smoke test 의무 (Day 2.0) + checkpoint 일별 commit
- emergency 1건 처리 가능 (4시간 spike + 4시간 alternative path)

**가는 게 맞나?** — Yes. opencode `run --format json` confirmed (P0-2 resolved), 외부 의존 모두 npm public, fallback path 명확. **proceed**.

emergency 처리 가능:
- opencode-ai 1.14.25 binary install 실패 → fallback shell + manual prompt
- chokidar OS 호환 (Linux 확인됨, macOS/Windows는 Phase 2)
- vitest output parse format 변경 → exit code only fallback
- pnpm test 5분 초과 → timeout 60s 강제 (D27)

---

## 4. 4 success criterion 매핑 (AGENTS.md slice gate)

매트릭스 slice gate 4건 (생략 불가):

| # | gate | Phase 1 매핑 |
|:---:|---|---|
| (a) | 새 실행 가능 명령 | `pnpm naia-agent "<prompt>"` (Day 5) |
| (b) | 단위 테스트 1+ | shell/opencode-cli/workspace/verification 각 pkg test (Day 1~4) |
| (c) | 통합 검증 1+ | E2E test (Day 5) + smoke `pnpm smoke:opencode` |
| (d) | README/CHANGELOG entry | Day 5.6 |

---

## 5. fallback paths (안 되면)

| 시나리오 | fallback |
|---|---|
| opencode-ai 1.14.25 install 실패 | 사용자 PATH의 opencode binary 사용 (env `OPENCODE_BIN`) |
| ACP/SDK 모두 안 됨 | 단순 stdio passthrough (Phase 1은 어쨌든 ACP 미사용) |
| chokidar 안 됨 | polling watcher (`chokidar usePolling:true`) |
| pnpm test 자동 실행 실패 | `--no-verify` 옵션 (검증 생략, 보고만) |
| **전체 Phase 1 실패** | Path A (IDE 회귀) 또는 Path C (손으로 계속). sunk cost 1주만 |

---

## 6. R3 → R4 마이그레이션 (Paranoid R3-R4 위험)

### 폐기 대상 (Phase 1 시작 전 또는 진행 중)

| R3 코드 | 처리 |
|---|---|
| `packages/providers/anthropic.ts` | dev-only 강등 — Phase 1 conversation에서 anthropic 직접 호출 안 함 (any-llm 사용) |
| `packages/providers/anthropic-vertex.ts` | 폐기 — any-llm이 vertex routing |
| `packages/runtime/skills/{bash,file-ops}` | dev-only 강등 — production은 opencode 위임. 기존 250 PASS test는 유지 (skill spec 검증) |
| `packages/runtime/utils/{dangerous-commands,path-normalize}` | naia-adk로 이동 후보 (Phase 3) |

### 유지 (R3 → R4 변환)

| R3 코드 | R4 위치 |
|---|---|
| `packages/types/` | 그대로 + 신규 (sub-agent/verification/workspace/stream-extended) |
| `packages/observability/` | 그대로 (Logger.fn() trace 표준) |
| `packages/providers/openai-compat.ts` | 유지 (any-llm 호출용) |
| `packages/core/agent.ts` | 그대로 + Conversation/Supervisor 신규 add (별도 파일) |

### F01 forbidden_action 처리

`F01: 스켈레톤 미존재 시 코드 변경 차단` — bin/naia-agent.ts 이미 존재 (R3, Slice 1c++) → F01 자동 해제됨. Phase 1 코드 작업 가능.

---

## 7. 2차 cross-review (Phase 1 spec 한정)

본 spec lock 전 2차 cross-review:

| reviewer | focus |
|---|---|
| Architect | 일별 시간 추정 합리성 / 모듈 분할 / Phase 1 OUT-of-scope 명확성 |
| Reference-driven | 기존 R3 코드 (250 PASS) 변환 / 폐기 결정 적정성 |
| Paranoid | 시간 buffer 충분성 (50% 여유 인정?) / fallback path 현실성 / E2E 검증 의미 |

→ 2차 review 후 Phase 1 lock + Day 1 시작.
