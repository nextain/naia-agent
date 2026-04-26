# R4 Phase 2 — Week 2~3 Spec (5일, 정량화)

> **session_id**: c03e4e41-9ef4-4809-9ec2-60329e3db5fa
> **상위**: `r4-phase-1-spec.md` (Phase 1 LOCK + COMPLETE) + `r4-week0-cross-review-summary.md` 1차 + 2차
> **Phase 1 적대적 review**: paranoid + reference + architect + functional 4건 → P0 3 fix 완료 (commit b294ffc)
> **status**: **LOCK after cross-review** (2026-04-26) — P0 11건 모두 반영
>
> ## Phase 2 cross-review 결과 (3-perspective)
> - **Architect**: APPROVED with 3 P0 (supervisor pattern / ApprovalBroker 위치 / Logger.withTag 범위)
> - **Reference-driven**: NEEDS_REVISION → REVISED with 4 P0 (pause/resume 음성 / aggregate timing / Tool context inject / redact 위치)
> - **Paranoid**: APPROVED_WITH_RISKS — 5 P0 (ACP RPC race / approval bypass / spike decision tree / supervisor extends conflict / secure-env+ACP incompatible)
>
> 통합 P0 11건 모두 본 spec에 반영. Phase 2 시작 가능.

---

## 1. Phase 2 success criterion (정량)

사용자가 다음 명령 실행:

```bash
pnpm naia-agent "src/utils/hello.ts에 hello() 함수 추가해" --acp
# (ACP 정식 mode — 또는 default 진화 가능, --no-acp로 Phase 1 모드 fallback)
```

**기대 출력 (CLI text-only, sub-session card 없이 — Phase 3)**:

```
[알파] task 시작 (ACP mode): src/utils/hello.ts에 hello() 함수 추가
[opencode-acp 0001] connect: ws://stdio (ACP protocol v1)
[opencode-acp 0001] phase: planning
[opencode-acp 0001] phase: editing
  → tool: read /etc/passwd
  ⚠ approval required (T3): read outside workdir? [y/N]
> n
  ✘ tool denied
  → tool: write src/utils/hello.ts (T2)
  ⚠ approval required (T2): write src/utils/hello.ts? [y/N]
> y
  ✓ tool: write (12ms, ok=true)
  ✚ src/utils/hello.ts (+5)
[opencode-acp 0001] phase: testing
[verify] running pnpm test ...
[verify] test 24/24 PASS (3.2s)
[알파] 완료
        files: 1 (+5/-0)
        tests: 24/24 PASS
        elapsed: 12.4s
```

### 검증 체크리스트 (8건 모두 ✓)

| # | 검증 | 측정 |
|:---:|---|---|
| 1 | opencode `acp` server mode spawn + ACP JSON-RPC handshake | `initialize` request/response 성공 |
| 2 | `session/new` + `session/prompt` 정상 RPC | sessionId 반환 |
| 3 | tool 호출 시 `session/update` notification → tool_use_start/end | event 시퀀스 확인 |
| 4 | T2/T3 tool 호출 시 `session/request_permission` → ApprovalBroker → 승인 응답 | y → 진행, n → tool 거부 |
| 5 | Ctrl+C → ACP `session/cancel` → 500ms 내 session_end(cancelled) | C12 contract |
| 6 | pause/resume spike 결과 documented (Phase 3 정식 또는 abandoned) | spike memo |
| 7 | env scrub mode (--secure-env) 작동 | sensitive var blacklist |
| 8 | E2E (실 opencode acp + 실 LLM) "hello() 함수 추가" 시나리오 | 사용자 직접 |

### OUT-of-scope (Phase 3)

| 항목 | 이연 |
|---|---|
| Sub-session 카드 UI (CLI text dashboard) | Phase 3 |
| 다중 session 병렬 | Phase 3 |
| Voice interrupt ("중지중지") | Phase 4 |
| Claude Agent SDK adapter | Phase 3 (spike 1일) |
| alpha-memory 통합 | Phase 3 |
| naia-shell UI 통합 | Phase 4 |
| Adversarial review | Phase 4 |
| vllm-omni audio | Phase 4 |
| **Logger.withTag()** (Reference P0) | Phase 2 (Day 3에 흡수) |
| **WorkspaceWatcher.diff() CLI 활용** (Architect P1) | Phase 2 (Day 5) |
| **eslint import/no-restricted-paths** (Architect P1) | Phase 2 (Day 4) |

---

## 2. 일별 task spec (5일, 정량 시간 + 여유)

### Day 1 (월) — AcpAdapter 골격 + ACP handshake (5h target, 3h 여유)

| step | 시간 | deliverable |
|---|---|---|
| **1.0** | **30min** | **(P0 obligatory smoke)** `opencode acp` server mode 실측 — JSON-RPC over stdio handshake (`initialize`, `session/new`, `session/prompt`, `session/update`). 결과를 `r4-phase-2-acp-handshake-findings.md`에 기록 |
| 1.1 | 30min | `packages/adapter-opencode-acp/` pkg 신설 + tsconfig project references 추가 |
| 1.2 | 1h | `@agentclientprotocol/sdk@0.20.0` 의존 + AcpClient class (JSON-RPC over child stdio) **+ Paranoid P0-1: stdout EOF / acp process kill → 500ms graceful shutdown unit test** |
| 1.3 | 1h | `OpencodeAcpAdapter implements SubAgentAdapter` (initialize → session/new) **+ Reference P0-3: ToolExecutionContext inject — TaskSpec.env에 `NAIA_SESSION_ID` / `NAIA_WORKDIR` / `NAIA_TIER` 환경 변수 주입 (sub-agent가 read 가능)** |
| 1.4 | 1h | `events()` — `session/update` notification → NaiaStreamChunk (tool_use_start/end) **+ Reference P0-4: 모든 string field에 `redactString()` mandatory wrapper (text_delta/tool input/output)** |
| 1.5 | 1h | unit test (mock JSON-RPC server, contract test C1~C10 + C12 cancel + C13 redact + acp process kill recovery) |
| **합** | **5h** | AcpAdapter PR-ready (ACP handshake + tool event capture + redact + crash recovery) |

### Day 2 (화) — Interrupt + ApprovalGate (4.5h target, 3.5h 여유)

| step | 시간 | deliverable |
|---|---|---|
| 2.1 | 1h | `cli-app/interrupt-manager.ts` — SIGINT/keypress → AbortController + ACP `session/cancel` propagate (cli-app 위치 — Architect P0-2 의존 방향 준수) |
| 2.2 | 30min | C12 contract — cancel() 후 500ms hard kill SIGKILL fallback |
| 2.3 | 1.5h | `cli-app/approval-broker.ts` impl (CLI readline prompt y/N, **default-deny T3, "always allow" 차단** — Paranoid P0-2 / **timeout 30s → auto-deny** — Paranoid M2). interface는 types/approval.ts에 (DI 주입 — Architect P0-2) |
| 2.4 | 1h | ACP `session/request_permission` 처리 → ApprovalBroker.decide() → response (**fresh request per tier**, cached approval 거부) |
| 2.5 | 30min | unit test (mock ACP request_permission + approval + cached bypass 시도 차단) |
| **합** | **4.5h** | Interrupt + Approval gate PR-ready |

### Day 3 (수) — pause/resume spike + Logger.withTag + WorkspaceWatcher.diff() (4.5h target)

| step | 시간 | deliverable |
|---|---|---|
| 3.1 | 1h | **pause/resume spike** — opencode ACP `sessionCapabilities.resume`만 확인됨 (ref agent.ts:568), `pause` RPC 미발견. **decision tree (Paranoid P0-3)**: (a) 양성 → 정식 구현 (Phase 3) (b) 음성 → `UnsupportedError` throw 유지 (Phase 1 contract) (c) 결과 `r4-phase-2-pause-resume-findings.md` 작성 후 결정 commit |
| 3.2 | 1h | `Logger.withTag(sessionId, adapterId)` — observability/logger.ts 확장 (zero-runtime-dep, chained method, **Phase 2 신규 코드만 적용** — Architect P0-3 / Phase 1 코드 untouched) |
| 3.3 | 1h | Phase 2 신규 (AcpAdapter / Phase2Supervisor / interrupt-manager / approval-broker)에만 Logger.withTag 적용 |
| 3.4 | 1h | WorkspaceWatcher.diff() — Phase2Supervisor에서 `--show-diff` flag 시 workspace_change.diff 채움 |
| 3.5 | 30min | unit test (Logger.withTag 분리 + diff 통합) |
| **합** | **4.5h** | Logger 확장 + diff CLI |

### Day 4 (목) — env scrub + eslint setup + silent JSON drop (4h target)

| step | 시간 | deliverable |
|---|---|---|
| 4.1 | 1h | `--secure-env` flag — sensitive var blacklist (ANTHROPIC_API_KEY/AWS_/GITHUB_/etc.) scrub 후 spawn. **Paranoid P0-5: --secure-env + --acp = incompatible. CLI 시작 시 충돌 검출 → error exit 3 OR --no-acp auto-fallback (default 후자) + warning** |
| 4.2 | 1.5h | eslint setup — `import/no-restricted-paths` rule. **Architect P1 fallback: 위반 10+ 발견 시 tsconfig references 강제만 + Phase 3 미루기** |
| 4.3 | 30min | event-parser logger inject (Reference P1-2 silent drop → warn) |
| 4.4 | 30min | unit test |
| 4.5 | 30min | CHANGELOG entry |
| **합** | **4h** | 보안 + DX 보강 |

### Day 5 (금) — Phase2Supervisor + E2E (5h target, 3h 여유)

| step | 시간 | deliverable |
|---|---|---|
| 5.1 | 30min | bin/naia-agent.ts — `--acp` flag 추가 (default opencode-cli, opt-in opencode-acp). --acp + --secure-env 충돌 처리 (Day 4.1) |
| 5.2 | 1.5h | **`Phase2Supervisor` (Architect P0-1 + Paranoid P0-4 — composition pattern)**: 내부에 Phase1Supervisor field로 사용. constructor(opts + approvalBroker + acpAdapter). super extends 사용 X. **session_aggregated emit timing은 Phase 1과 동일 (재구현 X)** — Reference P0-2. user denied tool 시 `session_end(reason: "failed")` emit |
| 5.3 | 1h | cli-renderer 확장 — `tool_use_start.tier` 표시 + approval prompt UI (readline + 30s timeout auto-deny) |
| 5.4 | 1.5h | E2E test (실 opencode acp + 실 LLM + approval gate y/n). **Paranoid P0-11: stdin pipe로 자동 approval 시뮬레이션 가능 — `echo "y\nn\n" | pnpm naia-agent ...` 형식** |
| 5.5 | 30min | CHANGELOG + README + master issue update |
| **합** | **5h** | Phase 2 deliverable + 사용자 검증 대기 |

---

## 3. 시간 buffer 정리 (정직)

| | 작업 시간 | 여유 |
|---|---|---|
| Day 1 | 5h | 3h |
| Day 2 | 4.5h | 3.5h |
| Day 3 | 4.5h | 3.5h |
| Day 4 | 4h | 4h |
| Day 5 | 5h | 3h |
| **합** | **23h** | **17h** |
| **총합** | **40h** | (5일 × 8h) |

**여유 비율**: 17/40 = **42%** (Phase 1과 비슷).

**hidden cost 우려**:
- ACP JSON-RPC 처음 다루기 — handshake 디버그 시간
- `opencode acp` 자체 quirk (실측 안 됨)
- ApprovalBroker readline UX 다듬기

→ confidence **45~55%** (Phase 1 비슷). fallback chain 명시.

---

## 4. fallback paths (Phase 2)

| 시나리오 | fallback |
|---|---|
| `opencode acp` 미작동 | Phase 1 mode (`--no-acp` default fallback) |
| ACP `session/request_permission` 미지원 | adapter 자체 approval (opencode `--dangerously-skip-permissions=false` + interactive prompt) |
| pause/resume spike 음성 결과 | UnsupportedError throw (이미 Phase 1 contract) — Phase 3 alpha-memory 통합 시 재검토 |
| eslint setup 시간 초과 | tsconfig project references만 enforce + Phase 3 |
| **전체 Phase 2 실패** | Phase 1 mode 영구 유지 (충분히 동작), Phase 3로 직진 |

---

## 5. 4 success criterion 매핑 (slice gate)

매트릭스 slice gate 4건 (생략 불가):

| # | gate | Phase 2 매핑 |
|:---:|---|---|
| (a) | 새 실행 가능 명령 | `pnpm naia-agent "..." --acp` (Day 5) |
| (b) | 단위 테스트 1+ | adapter-opencode-acp + interrupt-manager + approval-broker + Logger.withTag (Day 1~4) |
| (c) | 통합 검증 1+ | E2E (Day 5) — 실 opencode acp + LLM + approval y/n |
| (d) | README/CHANGELOG entry | Day 4.5 + Day 5.5 |

---

## 6. 신규 §D 흡수 (cross-review 권고)

| ID | 패턴 | Phase 2 위치 |
|---|---|---|
| **D34** | Adapter health check 표준화 (ShellAdapter / OpencodeRunAdapter / OpencodeAcpAdapter 모두 health()) | Day 1 (AcpAdapter health check 정식) |
| **D35** | event-parser versioning (opencode v1.x → v2.x event schema drift 검출) | Day 4 (event-parser logger inject 시 함께) |
| **D36** | WorkspaceStats `fullDiffAvailable` flag (watcher 없을 때 incomplete telemetry 명시) | Day 3 (WorkspaceWatcher.diff() 활용 시) |
| **D37** | --secure-env blacklist (ANTHROPIC_API_KEY/AWS_/GITHUB_/...) — secure-env + ACP incompatible (--no-acp fallback) | Day 4.1 |
| **D38** | ApprovalBroker CLI UX (default-deny T3, 30s timeout auto-deny, "always allow" 차단, fresh per tier) | Day 2.3 |
| **D39** | opencode ACP pause capability — sessionCapabilities.resume만, pause 미지원 (D24 unsupported matrix 갱신) | Day 3.1 spike |
| **D40** | Tool context inject 표준 (NAIA_SESSION_ID/NAIA_WORKDIR/NAIA_TIER env var to sub-agent) | Day 1.3 |
| **D41** | session_aggregated emit timing 정형화 (Phase 1 supervisor 패턴 — verification 후 emit, 재구현 X) | Day 5.2 |
| **D42** | Phase2Supervisor = composition (Phase1Supervisor를 inner field, extends X) — 다중 상속 회피 | Day 5.2 |

---

## 7. P0 review 통합 — Phase 2 진입 전 cleanup

Phase 1 적대적 review에서 발견된 P0 (paranoid 3건)는 commit b294ffc로 fix 완료.
P1 항목 (env intent docs / silent JSON drop / path traversal docs) 모두 처리 완료.

Phase 2 시작 시점 코드 baseline:
- 335/335 PASS (R3 250 + R4 85)
- 5 신규 race regression test
- vision-statement.md §6b 보안 stance 명시

---

## 8. cross-review (Phase 2 spec 한정, 본 docs 직후)

본 spec lock 전 cross-review 3 parallel:

| reviewer | focus |
|---|---|
| Architect | Day 1 ACP adapter 분리 합리성 / Day 5 Phase2Supervisor extends 패턴 / 5일 분량 |
| Reference-driven | ACP `@agentclientprotocol/sdk` 사용법 / opencode acp server quirk / Mastra approval pattern 비교 |
| Paranoid | ACP RPC race / approval bypass scenarios / pause/resume spike 위험 / eslint setup 시간 추정 |

→ review 후 P0 반영 + Phase 2 lock + Day 1 시작.

---

## 9. R4 lock 후 변경 절차

본 spec 변경 시:
1. 본 파일에 Change log 섹션
2. r4-phase-2-spec.md 또는 후속 spec
3. 매트릭스 §D 새 항목
4. master issue #2 댓글
5. cross-review (3-perspective)
