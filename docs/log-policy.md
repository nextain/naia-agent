# Log Policy — naia-agent

> **Languages**: English (this file) · [한국어](../.users/docs/ko/log-policy.md)
> **Created**: 2026-04-25 (Slice 2.7)
> **Scope**: naia-agent CLI + embedded host + multi-tool harness compatibility
> **Status**: stable — additive only

This document is the canonical logging standard. Tool-agnostic (opencode / Codex / Gemini / naia itself — all the same).

---

## 1. Levels (`LogLevel`)

| Level | Use | Examples |
|---|---|---|
| **debug** | Development / debugging (not recommended in production) | LLM request body, internal state dumps |
| **info** | Core state transitions | `session.started`, `turn.ended`, `tool.started/ended`, `compaction` |
| **warn** | Abnormal but non-fatal (normal flow but noteworthy) | `DANGEROUS BLOCKED`, fixture fallback, SDK schema drift |
| **error** | Operation failure (recoverable) | tool execution error, API timeout, parse error |
| **fatal** | About to exit (unrecoverable) | catastrophic failure, OOM, unrecoverable session state |

### 1.1 Default level

- **bin/naia-agent.ts**: `warn` (minimize user noise)
- **examples/**: `info` (developer demo)
- **production host**: explicit (default `info`)
- **CI smoke**: `error` (only PASS/FAIL visible)

---

## 2. Output destination

### 2.1 Default

- **stderr**: all logs (stdout is reserved for the user's answer + tool result)
- Reason: piping (`pnpm naia-agent ... | grep`) lets only the answer pass through.

### 2.2 Options

- **`--log-file <path>`**: also write to a file (in addition to stderr)
- **`LOG_FILE` env**: same
- **`LOG_DEST=file-only`**: stderr off, file only
- **`LOG_DEST=both`**: stderr + file (default when `--log-file` is set)

### 2.3 Recommended file location

Inside the user's `.naia-agent/logs/` directory, or the project root `.naia-agent/logs/`. Both are `.gitignore`'d.

Filename convention: `naia-agent-YYYYMMDD.jsonl`.

---

## 3. Rotation

- **Daily**: filename embeds `YYYYMMDD`, new file each day
- **Size cap**: 10 MB per file (rotated to `.1`, `.2` on overflow)
- **Retention**: 30 days (default)
- Implementation: out of scope for this slice (opt-in script later)

---

## 4. Format (JSON-lines)

```json
{"ts":"2026-04-25T14:30:00.123Z","level":"info","msg":"tool.started","sessionId":"sess-x","tool":"bash","tags":["agent"]}
```

### 4.1 Required fields

| Field | Type | Meaning |
|---|---|---|
| `ts` | ISO 8601 | Timestamp (UTC) |
| `level` | string | `LogLevel` |
| `msg` | string | Event name or message |

### 4.2 Recommended optional fields

| Field | Meaning |
|---|---|
| `sessionId` | `Agent.session.id` |
| `tags[]` | Tags accumulated by `Logger.tag()` |
| `elapsedMs` | Result of `Logger.time()` |
| `err.{name,message,stack}` | Error object data |
| `tool` | Tool name (when invoking a tool) |
| custom ctx | Free-form (watch for key collisions) |

---

## 5. Sensitive-data masking (mandatory)

### 5.1 Auto-redact patterns

| Pattern | Mask |
|---|---|
| `sk-ant-...` (Anthropic) | `sk-ant-***` |
| `sk-...` (OpenAI / generic) | `sk-***` |
| `gw-...` (gateway keys) | `gw-***` |
| `AIzaSy...` (Google) | `AIzaSy***` |
| `Bearer ` header value | `Bearer ***` |
| `Authorization` header | Keep the name, redact the value |
| 12+ chars hex (excluding UUID / hash patterns) | Only with explicit reviewer approval |

### 5.2 OK to log (NOT redacted)

- User-prompt content (the user's own utterance)
- LLM response content (the answer the user will see)
- Tool name, exit code, file path (within the workspace)
- Session id, request id

### 5.3 Never

- API key value inline
- OAuth token value
- User password / PII
- Environment-variable dump (full `process.env`)

### 5.4 Implementation

`packages/observability/src/redact.ts` — the `redactSecrets(text)` function. `ConsoleLogger` applies it automatically.

---

## 6. Canonical fields per event

### 6.1 Session lifecycle

- `session.started`: `sessionId`, `model`, `provider`, `systemPromptLen`
- `session.active`: `sessionId`
- `session.closed`: `sessionId`, `state`, `turnCount`

### 6.2 Turn

- `turn.started`: `sessionId`, `userTextLen`, `recalled` (memory hits)
- `turn.ended`: `sessionId`, `assistantTextLen`, `toolCallsCount`

### 6.3 LLM

- `llm.request`: `model`, `messageCount`, `toolsCount`
- `llm.response`: `model`, `stopReason`, `usage.{input,output}Tokens`
- `llm.error`: `model`, `err.message`, `retryAttempt`

### 6.4 Tool

- `tool.started`: `tool.name`, `tool.tier`, `tool.inputSize` (size only, not value)
- `tool.ended`: `tool.name`, `result.length`, `success`, `elapsedMs`
- `tool.error.halt`: `consecutiveErrors`, `errorCode`, `severity`, `retryable`

### 6.5 Compaction

- `compaction`: `droppedCount`, `realtime`, `tokensBefore`, `tokensAfter`

### 6.6 Security

- `security.dangerous_blocked`: `pattern.reason`, `commandPrefix` (60 chars max)
- `security.path_escape`: `attempted` (relative), `workspaceRoot` (path only)

---

## 7. CLI flags

| Flag | env | Default |
|---|---|---|
| `--log-level <level>` | `LOG_LEVEL` | bin: `warn` / examples: `info` |
| `--log-file <path>` | `LOG_FILE` | (none — stderr only) |
| `--log-dest <stderr\|file-only\|both>` | `LOG_DEST` | `both` (when `--log-file`) / `stderr` |

### 7.1 Examples

```bash
# Default (stderr, warn)
pnpm naia-agent "hi"

# Debug + file
pnpm naia-agent --log-level debug --log-file logs/today.jsonl "hi"

# CI: errors only on stderr
LOG_LEVEL=error pnpm naia-agent "..."
```

---

## 8. Multi-tool harness compatibility

This policy is tool-agnostic:

- **Claude Code**: stderr is captured into the transcript → user-visible logs follow our policy.
- **opencode / Codex**: same.
- **Gemini CLI**: same.
- **naia itself**: this policy.

Per-tool extra logging (e.g. Claude Code transcript) is the host's responsibility. We only guarantee the stderr standard.

---

## 9. External sinks (deferred)

- **OpenTelemetry / Jaeger / Datadog**: per matrix §B12 (Sentry-style telemetry rejected) — only the `Logger` / `Tracer` / `Meter` contract is in scope. External sinks = host's adapter.
- **stdout JSON streaming**: piping to external tools (`jq` etc.) is fine — but the default is stderr so this has no effect on the standard.

---

## 10. Matrix cross-links

- **A26** `Logger.tag/time` (Slice 2 — opencode impact)
- **A27** Observability unit tests (Slice 2)
- **A31** Log policy normalization + redact (Slice 2.7)
- **B12** Sentry-style telemetry rejected (own contract first)
- **F09** No sole dependence on cleanroom (redact patterns sourced from OWASP)

---

## 11. Change history

- **2026-04-25** (Slice 2.7): initial policy. 5 levels + JSON-lines + redact + CLI flags.
