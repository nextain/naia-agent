# Adapter Contract — SubAgentAdapter / Verifier / WorkspaceWatcher (R4 lock 2026-04-26)

> **언어**: [English](../../../docs/adapter-contract.md) · 한국어 (이 파일)
>
> **상위**: [`vision-statement.md`](vision-statement.md) / [`architecture-hybrid.md`](architecture-hybrid.md)
> **관련**: [`stream-protocol.md`](stream-protocol.md) (NaiaStreamChunk)
> **status**: design lock (Week 0)

---

## 1. 동기

R4 Hybrid 결정 (D18) — opencode / claude-code / 미래 ACP-compliant agent 를 sub-agent 로 wrap. 새 sub-agent 추가 = adapter pkg 1개. core/cli 수정 0건.

이를 위해 **3개 표준 contract**:
1. `SubAgentAdapter` — sub-agent 를 spawn / 통제 / event 수신
2. `Verifier` — task 후 자동 검증 (test/lint/build)
3. `WorkspaceWatcher` — workspace 변경 실시간 capture

---

## 2. SubAgentAdapter

### Interface

```typescript
// packages/types/src/sub-agent.ts

export type Capability =
  | "text_chat"          // 일반 대화
  | "code_edit"          // 파일 수정
  | "shell_exec"         // bash 등 명령 실행
  | "git_ops"            // git 작업
  | "test_run"           // 테스트 실행
  | "browse_web"         // web fetch/search
  | "image_input"        // 이미지 입력
  | "audio_input"        // 음성 입력
  | "audio_output";      // voice output — naia-os + naia-omni 영역, naia-agent는 text turn only

export interface TaskSpec {
  readonly prompt: string;                   // 사용자 명령
  readonly workdir: string;                  // sub-agent working directory
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly extraSystemPrompt?: string;       // alpha-memory recall 결과 등 inject
}

export interface SpawnContext {
  readonly signal: AbortSignal;
  readonly logger?: Logger;
  readonly approvalBroker?: ApprovalBroker;  // T2/T3 tool 승인
  readonly toolContext: ToolExecutionContext; // P0-4 (D25) — tool 호출 시 inject
}

/**
 * P0-4 fix (Reference + Architect):
 * opencode Tool context schema (matrix D25). adapter 는 spawn 후 sub-agent 에게
 * 이 context 를 모든 tool 호출에 inject. opencode/Vercel AI SDK 패턴.
 */
export interface ToolExecutionContext {
  readonly sessionId: string;          // naia-agent 내부 sub-agent session ID
  readonly workingDir: string;         // adapter cwd, sub-agent escape 금지 기준
  readonly tier?: "T0" | "T1" | "T2" | "T3";  // matrix D05
  /**
   * Async approval RPC. supervisor 에 question 전달 → 사용자 승인 대기 → answer.
   * T2/T3 tool 호출 시 adapter 가 이 callback 을 호출하여 사전 승인 획득.
   * undefined 일 때 = sub-agent 자체 approval (opencode 자체 logic) 사용.
   */
  readonly ask?: (question: string, meta?: { tool?: string; tier?: string }) => Promise<boolean>;
  readonly env?: Readonly<Record<string, string>>;
}

export interface SubAgentSession {
  readonly id: string;
  readonly adapterId: string;
  readonly startedAt: number;                // epoch ms

  /**
   * Live stream of NaiaStreamChunk events from this sub-agent.
   * Adapter MUST emit:
   *   - session_start (first)
   *   - tool_use_start / tool_use_end pairs (all tool calls)
   *   - workspace_change (if file modified, sourceSession=this.id)
   *   - text_delta (if applicable)
   *   - session_end (last, exactly once)
   * On cancel: interrupt followed by session_end(reason:"cancelled").
   */
  events(): AsyncIterable<NaiaStreamChunk>;

  /**
   * Hard cancel — terminate sub-agent immediately.
   * Resolves when session_end emitted or timeout (default 5s).
   */
  cancel(reason?: string): Promise<void>;

  /**
   * Soft pause — sub-agent finishes current tool then halts.
   * Resume via resume(). If unsupported, throws UnsupportedError.
   */
  pause(): Promise<void>;
  resume(): Promise<void>;

  /**
   * Inject system message mid-session (e.g., user feedback).
   * If unsupported, throws UnsupportedError.
   */
  inject(message: string): Promise<void>;

  status(): SubAgentStatus;
}

export type SubAgentStatus =
  | { phase: "starting" }
  | { phase: "running"; currentTool?: string }
  | { phase: "paused" }
  | { phase: "ended"; reason: "completed" | "cancelled" | "failed"; durationMs: number };

export interface SubAgentAdapter {
  readonly id: string;                       // "opencode-acp" | "opencode-cli" | "shell"
  readonly name: string;
  readonly version: string;
  readonly capabilities: readonly Capability[];

  spawn(task: TaskSpec, ctx: SpawnContext): Promise<SubAgentSession>;

  /**
   * Optional health check before spawn (e.g., binary exists, API key valid).
   * Returns null if healthy, error message otherwise.
   */
  health?(): Promise<string | null>;
}
```

### Contract test (모든 adapter 통과 필수)

`packages/adapters/__tests__/contract.ts` (공유):

| # | 검증 |
|---|---|
| C1 | `spawn` 후 `events()` 첫 chunk 반드시 `session_start` |
| C2 | `events()` 마지막 chunk 반드시 `session_end` (exactly once) |
| C3 | `cancel()` 호출 후 5초 내 `session_end(reason:"cancelled")` |
| C4 | `signal.abort()` 시 `cancel()` 과 동일 동작 |
| C5 | tool 호출 시 `tool_use_start` → `tool_use_end` 짝 emit (start 만 emit 하고 end 없으면 contract 위반) |
| C6 | file 수정 시 `workspace_change` emit (sourceSession=session.id) |
| C7 | `pause`/`resume` unsupported 시 `UnsupportedError` throw (silent ignore 금지) |
| C8 | `health()` 정의 시 spawn 전 호출 가능 |
| C9 | `id`/`name`/`version`/`capabilities` 모두 non-empty |
| C10 | 같은 adapter 로 2 session 동시 spawn 시 isolated (event leak 없음) |
| C11 | **(P0-7)** spawn 시 workdir 외부 file 접근 시 emit drop + warning (matrix D09 강제) |
| C12 | **(P0-7, Paranoid)** `cancel()` 호출 후 500ms 내 `session_end(reason:"cancelled")` emit. 미 emit 시 supervisor 가 SIGKILL. |
| C13 | **(P0-6)** 모든 emit chunk 에서 secret pattern (sk-ant-/sk-/gw-/AIzaSy/Bearer) redact 검증 |
| C14 | **(P0-5)** unsupported method (`pause`/`inject` 등) 호출 시 `UnsupportedError` throw |
| C15 | session_end.reason 은 `SessionEndReason` enum 값만 (string literal union 강제) |

`tests/adapter-contract.spec.ts` 가 fake adapter / 진짜 adapter 모두 통과하는지 검증.

### 구현체 매핑

| Adapter id | 구현 | 통제 방식 | 비고 (검증 2026-05-20) |
|---|---|---|---|
| **`opencode-acp`** | 인트리 JSON-RPC 클라이언트 (`AcpClient`) — opencode Agent Client Protocol 을 stdio 로 처리 | ACP `session/new` / `session/update` / `session/cancel` | 패키지 `@nextain/agent-adapter-opencode-acp` (workspace). 외부 `@agentclientprotocol/sdk` 의존 없음 — 프로토콜 클라이언트는 사내 구현. |
| **`opencode-cli`** | `opencode run --format json` 을 자식 프로세스로 wrap | stdout JSON line stream + SIGTERM | 패키지 `@nextain/agent-adapter-opencode-cli` (workspace). ACP 경로 성숙 전까지의 Phase 1 fallback. |
| **`pi-cli`** | `pi -p "<prompt>" --mode json --no-session` 자식 프로세스 wrap — NDJSON 이벤트 스트림을 `NaiaStreamChunk` 로 변환 | stdout NDJSON stream + SIGTERM/SIGKILL (500ms hard kill) | 패키지 `@nextain/agent-adapter-pi` (workspace). `@earendil-works/pi-coding-agent ^0.74.1` 바이너리 사용. single-shot (no-session) 모드 전용. |
| **`shell`** | 임의 외부 CLI 를 `child_process.spawn` | stdin/stdout passthrough + SIGTERM/SIGKILL | 패키지 `@nextain/agent-adapter-shell` (workspace). Node.js 빌트인만 사용. |
| **`voice-cascade`** *(naia-os/naia-omni 영역)* | Voice 오케스트레이션은 naia-os + naia-omni 담당. naia-agent는 text turn만. | n/a | naia-agent adapter 범위 외. |
| **`mcp-bridge`** *(이연)* | MCP server spawn | stdio MCP | — |

**Claude Code 경로 (adapter 아님).** Claude Code 코딩 에이전트 연동은 전용 `claude-code` `SubAgentAdapter` 가 아니라 provider 레이어의 `ai-sdk-provider-claude-code` (workspace dep `^3.4.4`, 트랜지티브로 `@anthropic-ai/claude-agent-sdk@0.2.122` 플랫폼 네이티브 바이너리) 를 통해 라우팅. `packages/providers/src/vercel-client.ts` 및 Slice 3-XR-O (parity 작업, 2026-05-20 완료) 참고.

### Unsupported methods matrix (P0-5 fix, Architect)

각 adapter 가 지원/미지원 method:

| method | opencode-acp | opencode-cli | pi-cli | shell | voice-cascade (이연) |
|---|:---:|:---:|:---:|:---:|:---:|
| `spawn` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `events()` | ✓ | ✓ (stdout JSON) | ✓ (stdout NDJSON) | ✓ (stdout/stderr) | ✓ (audio_delta) |
| `cancel()` | ✓ (ACP `session/cancel`) | ✓ (SIGTERM/SIGKILL) | ✓ (SIGTERM → 500ms → SIGKILL) | ✓ (SIGTERM/SIGKILL) | ✓ (fetch abort) |
| `pause()` | △ (Phase 2 spike — ACP spec 확인) | ✗ | ✗ | ✗ | ✗ |
| `resume()` | △ | ✗ | ✗ | ✗ | ✗ |
| `inject(message)` | ✗ (mid-session prompt 불가) | ✗ | ✗ (single-shot only) | ✗ (stdin closed after spawn) | ✗ |
| `health()` | ✓ (ACP `initialize`) | ✓ (binary which) | ✓ (binary which) | ✓ (binary which) | ✓ (HTTP HEAD) |
| `status()` | ✓ | ✓ | ✓ | ✓ | ✓ |

**규칙**: unsupported method 호출 시 `UnsupportedError` throw (silent ignore 금지). supervisor 는 spawn 전 `adapter.capabilities` 로 사전 확인.

`△` = Phase 진입 시 spike 로 확정. 잠정 미지원으로 가정.

---

## 3. opencode ACP 매핑 상세

| ACP message | NaiaStreamChunk | 비고 |
|---|---|---|
| `initialize` (request) | (internal) | adapter ctor 시 한 번 |
| `session/new` (request) | (internal) — 응답으로 sessionId 획득 | spawn 첫 단계 |
| `session/prompt` (request) | (sub-agent 에 prompt 전달) | task.prompt |
| `session/update` notification | `tool_use_start` 또는 `tool_use_end` 또는 `workspace_change` | update.kind 분기 |
| `session/request_permission` (request from agent) | `tool_use_start` (tier 채움) → host approval → response | T2/T3 gate |
| `session/cancel` (request) | (internal) | cancel() 호출 시 |
| `session/done` notification | `session_end(reason: completed)` | 정상 종료 |
| stderr / 비정상 종료 | `session_end(reason: failed)` | adapter 책임 |

---

## 4. Claude Agent SDK 매핑 상세

provider 레이어가 `ai-sdk-provider-claude-code` 를 통해 사용 (SubAgentAdapter 아님). 대칭성을 위해 여기 둠 — 나중에 `claude-code` 어댑터가 추가되면 따라야 할 이벤트 매핑.

| SDK call | NaiaStreamChunk |
|---|---|
| `new Session({ workdir })` | (internal) |
| session iter (`for await ... of session`) | event 분기 |
| `event.type === "tool_use_started"` | `tool_use_start` |
| `event.type === "tool_use_completed"` | `tool_use_end` |
| `event.type === "file_edited"` | `workspace_change` |
| `event.type === "thinking"` | `thinking_delta` |
| `event.type === "text"` | `text_delta` |
| `session.cancel()` | `interrupt` + `session_end(cancelled)` |
| iter 종료 | `session_end(completed)` |

(SDK API 정확한 형식은 필요 시 spike 로 재확인. 현재 spec 은 잠정.)

---

## 5. Verifier

### Interface

```typescript
// packages/types/src/verification.ts

export interface VerifierContext {
  readonly signal: AbortSignal;
  readonly logger?: Logger;
  readonly env?: Readonly<Record<string, string>>;
}

export interface VerificationResult {
  readonly runner: string;
  readonly pass: boolean;
  readonly stats: VerificationStats;
  readonly durationMs: number;
  readonly stdoutTail?: string;
  readonly errorTail?: string;
}

export interface Verifier {
  readonly id: "test" | "lint" | "build" | "type_check" | string;
  readonly defaultCommand: string;        // e.g. "pnpm test", "pnpm lint"

  /**
   * Run verifier in workdir. Returns result; never throws on failure
   * (failure is `pass: false`). Throws only on infrastructure error.
   */
  run(workdir: string, ctx: VerifierContext): Promise<VerificationResult>;
}
```

### 표준 구현체 (Phase 1)

| Verifier | command | parse |
|---|---|---|
| **TestVerifier** | `pnpm test` | vitest output → passed/failed/total |
| **LintVerifier** | `pnpm lint` | eslint/oxlint exit code + stdout count |
| **BuildVerifier** | `pnpm build` | tsc --build exit code |
| **TypeCheckVerifier** | `pnpm typecheck` | tsc --noEmit exit code |

각 verifier 는 독립 — 병렬 실행 가능 (orchestrator).

---

## 6. WorkspaceWatcher

### Interface

```typescript
// packages/types/src/workspace.ts

export interface WorkspaceChange {
  readonly path: string;                   // workdir-relative
  readonly kind: "add" | "modify" | "delete";
  readonly timestamp: number;              // epoch ms
  readonly sourceSession?: string;         // 가능하면 추적, 없으면 undefined
}

export interface WorkspaceWatcher {
  /**
   * Watch workdir for changes. Yields WorkspaceChange events.
   * Debounced internally (default 100ms).
   * Stops on signal.aborted.
   */
  watch(workdir: string, signal: AbortSignal): AsyncIterable<WorkspaceChange>;

  /**
   * Compute git-style diff for path. Lazy — caller invokes when needed.
   * Returns null if not in git repo or path unchanged.
   */
  diff(workdir: string, path: string): Promise<string | null>;

  /**
   * Aggregate stats (additions/deletions) for path or whole workdir.
   */
  stats(workdir: string, path?: string): Promise<{ additions: number; deletions: number }>;
}
```

### 표준 구현 (Phase 1)

`packages/workspace/src/`:
- `chokidar-watcher.ts` — chokidar 기반 watch + 100ms debounce + .gitignore 적용
- `git-diff.ts` — `git diff --numstat` + `git diff -- <path>`

---

## 7. 성능 + 안정성 contract

| 항목 | 보장 |
|---|---|
| spawn latency | ≤ 5초 (opencode / Claude Code 시작 시간) |
| cancel responsiveness | hard kill ≤ 5초 / soft pause ≤ 30초 (현재 tool 에 따라) |
| event order | 같은 session 안에서 strictly ordered |
| event delivery | best-effort (network 끊김 시 timeout + session_end emit) |
| memory | event chunk size ≤ 64 KiB 권고 (audio/image 큰 건 split) |
| concurrent sessions | 최소 4 (Phase 1), Phase 3 에서 N 검증 |
| watcher debounce | 100ms (config 가능) |
| verification timeout | runner 별 default 5분 (config 가능) |

---

## 8. 보안 contract

| 항목 | 강제 |
|---|---|
| **workdir 격리** | TaskSpec.workdir 외부로 sub-agent escape 금지. adapter 는 `cwd` 옵션으로 강제. Phase 2+ 에서 추가 보강 (chroot/seccomp 검토 — Paranoid M1) |
| **env 최소화** | TaskSpec.env 에 명시된 것만 자식에 전달. process.env 무차별 전달 금지 |
| **secret redact (P0-6)** | **모든 SubAgentEvent → NaiaStreamChunk 변환 시점에 redact 함수 mandatory wrapper** — `adapters/*/event-converter.ts` 에서 `observability/redact.ts` 의 `redactSecrets()` 호출 후 emit. (sk-ant- / sk- / gw- / AIzaSy / Bearer 5 패턴, Slice 2.7) |
| **redact target fields** | `text_delta.text` / `tool_use_start.input` / `tool_use_end.result` / `verification_result.stdoutTail` / `report.summary` 모두. binary (audio/image) 제외 |
| **redact contract test** | C13 — "ACP `session/update` with `Authorization: Bearer sk-xxx` in tool input → emitted chunk redacted" |
| **approval gate** | T2/T3 tool 시작 시 `tool_use_start.tier` 채워서 host 에 알림. host approval 전 실행 금지. SpawnContext.toolContext.ask 사용 |
| **DANGEROUS regex** | bash tool 호출 시 input.command 사전 검사 (matrix D02 재사용, opencode 자체 보안 위 추가 layer) — Phase 2+ |
| **path traversal** | workspace_change.path 가 workdir 외부 가리킬 시 emit drop + warning log (matrix D09) |
| **trust assumption** | adapter 구현체 (opencode / claude-code) 가 자체 보안을 가짐을 신뢰. naia-agent layer 는 추가 격리 + audit trail 제공 (Paranoid P2-4) |

---

## 9. R4 lock 후 변경 절차

새 adapter 추가:
1. `packages/adapters/<id>/` 신설
2. contract test 모두 통과 (`pnpm test --filter @nextain/adapter-<id>`)
3. 매트릭스 §D 항목 (D## 신규)
4. cross-review (architect + paranoid)
5. README/CHANGELOG

interface 자체 변경:
1. 본 파일 update + Change log
2. `packages/types/src/{sub-agent,verification,workspace}.ts` 갱신
3. 모든 기존 adapter 갱신 (breaking change 가능)
4. fixture 갱신
5. cross-review (3-perspective)
