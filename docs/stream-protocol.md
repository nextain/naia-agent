# Stream Protocol — NaiaStreamChunk (R4 lock 2026-04-26)

> **Languages**: English (this file) · [한국어](../.users/docs/ko/stream-protocol.md)

> **Parent docs**: `docs/vision-statement.md` / `docs/architecture-hybrid.md`
> **Previous shape**: `LLMStreamChunk` (R3, `providers/types/llm.ts`) — text-only.
> **Status**: design lock (Week 0).
> **Rationale**: voice-capable + multi-agent era — text / audio / image are first-class citizens, and sub-agent supervision events flow through a single unified stream.
> **Voice note**: voice output is produced by the **agent-layer cascade** track (Slice 3-XR-Voice / P0c-2 — LiveKit + VoxCPM2, currently deferred). The earlier in-model omni path (MiniCPM-o 4.5 / vllm-omni) is **deprecated**; see memory `project_minicpm_o_4_5_deprecated_2026_05_20`.

---

## 1. Why a unified stream

The legacy `LLMStreamChunk` only modelled the LLM-response stream. In practice the host (`naia-shell`, `apps/cli`, any embedder) must receive events from several sources as a single flow:

| Source | Kind | Available in R3 |
|---|---|---|
| LLM response | text / thinking / tool_use tokens | LLMStreamChunk |
| Sub-agent activity | tool_use_start/end, file_change | (none) |
| Workspace | file-watcher results | (none) |
| Verification | test / lint results | (none) |
| Multi-sub-session merge | session_update / session_progress | (none) |
| Voice | audio_delta (voice-cascade output, agent-layer — Slice 3-XR-Voice / P0c-2) | (none) |

`NaiaStreamChunk` is the **single union that carries every layer** (decision D20).

---

## 2. NaiaStreamChunk union (canonical spec)

The reference implementation lives in `packages/types/src/stream.ts`. The shape below is the spec; the source file is the executable form.

```typescript
// packages/types/src/stream.ts

export type NaiaStreamChunk =
  // ─── LLM tokens (text-first) ──────────────────────────────────────
  | { type: "text_delta"; sessionId: string; text: string }
  | { type: "thinking_delta"; sessionId: string; thinking: string }
  | { type: "input_json_delta"; sessionId: string; partialJson: string }

  // ─── multi-modal tokens (voice cascade — Slice 3-XR-Voice / P0c-2 deferred) ────
  | {
      type: "audio_delta";
      sessionId: string;
      pcm: Uint8Array;          // PCM 16-bit raw
      sampleRate: number;        // e.g. 16000, 24000
      channels: 1 | 2;
      format: "pcm_s16le" | "opus" | "wav_chunk";
    }
  | {
      type: "image_delta";
      sessionId: string;
      mediaType: "image/png" | "image/jpeg" | "image/webp";
      data: Uint8Array;          // base64-decoded bytes
      isPartial: boolean;
    }

  // ─── tool lifecycle (LLM or sub-agent) ────────────────────────────
  | {
      type: "tool_use_start";
      sessionId: string;
      toolUseId: string;
      tool: string;              // bash / read / edit / write / ...
      input: unknown;            // JSON-serializable
      tier?: "T0" | "T1" | "T2" | "T3";  // matrix D05
    }
  | {
      type: "tool_use_end";
      sessionId: string;
      toolUseId: string;
      tool: string;
      result: unknown;
      ok: boolean;
      elapsedMs: number;
    }

  // ─── sub-agent supervisor (D24) ───────────────────────────────────
  | {
      type: "session_start";
      sessionId: string;
      adapterId: string;          // opencode / claude-code / shell
      taskSummary: string;
      workdir: string;
    }
  | {
      type: "session_progress";
      sessionId: string;
      phase: SessionPhase;        // P0-1 fix — string literal union (consumer-inferrable)
      progress?: number;          // 0~1
      note?: string;
    }
  | {
      type: "session_end";
      sessionId: string;
      reason: SessionEndReason;
      stats?: SessionStats;
    }
  // P0-11: onSessionEnd hook (Vercel onStepFinish + Mastra) — supervisor emits this
  // before the human-readable `report` chunk.
  | {
      type: "session_aggregated";   // supervisor has aggregated stats after session_end
      sessionId: string;
      stats: SessionStats;
      verifications: readonly VerificationResultRef[];
    }
  | {
      type: "interrupt";
      sessionId: string;
      reason: string;             // "user_voice_stop" / "user_keypress" / "approval_denied"
      mode: "hard_kill" | "soft_pause" | "approval_gate";
    }

  // ─── workspace visibility (D19) ───────────────────────────────────
  | {
      type: "workspace_change";
      path: string;                // workdir-relative
      kind: "add" | "modify" | "delete" | "rename";
      sourceSession?: string;      // sub-session that caused the change (if any)
      diff?: string;               // unified diff (lazy, filled on demand)
      stats?: { additions: number; deletions: number };
    }

  // ─── verification (automatic checks, D19) ─────────────────────────
  | {
      type: "verification_start";
      runner: "test" | "lint" | "build" | "type_check" | "custom";
      command: string;
    }
  | {
      type: "verification_result";
      runner: "test" | "lint" | "build" | "type_check" | "custom";
      pass: boolean;
      stats: VerificationStats;
      durationMs: number;
      stdoutTail?: string;          // last N lines, to keep payload bounded
    }

  // ─── honest reporting (D19) ───────────────────────────────────────
  | {
      type: "report";
      sessionId: string;
      summary: string;              // e.g. "3 files modified, +12/-3 lines, tests 24/24 PASS"
      stats: ReportStats;
      verifications: readonly VerificationResultRef[];
    }

  // ─── adversarial review (Phase 4+) ────────────────────────────────
  | {
      type: "review_request";
      sessionId: string;
      target: "diff" | "plan" | "session_result";
      reviewerId: string;            // a different model / agent
    }
  | {
      type: "review_finding";
      sessionId: string;
      reviewerId: string;
      severity: "info" | "warn" | "error";
      message: string;
      location?: string;
    }

  // ─── terminal chunk ───────────────────────────────────────────────
  | {
      type: "end";
      sessionId: string;
      stopReason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "cancelled" | "error";
      usage?: LLMUsage;
    };

// ─── enums (P0-1 fix) ─────────────────────────────────────────────
export type SessionPhase =
  | "spawning"        // adapter spawning child process / session
  | "planning"        // sub-agent decomposing task
  | "editing"         // file modification in progress
  | "executing"       // shell / tool exec
  | "testing"         // test runner
  | "verifying"       // post-task verification chain
  | "reviewing"       // adversarial review (Phase 4+)
  | "completed"
  | "failed";

export type SessionEndReason =
  | "completed"       // normal end
  | "cancelled"       // user cancel (interrupt + cancel())
  | "failed"          // adapter error (non-zero exit or exception)
  | "timeout"         // signal abort or wall-clock timeout
  | "network"         // ACP/SDK connection lost (after reconnect failed)
  | "paused";         // paused (resume() available)

// ─── helper types ─────────────────────────────────────────────────
export interface VerificationStats {
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  errorsTail?: string;
}

export interface ReportStats {
  filesChanged: number;
  additions: number;
  deletions: number;
  testsPassed: number;
  testsFailed: number;
  durationMs: number;
}

export interface SessionStats extends ReportStats {
  toolsUsed: number;
  llmTurns: number;
  llmTokensUsed: number;
}

export interface VerificationResultRef {
  runner: string;
  pass: boolean;
  durationMs: number;
}
```

---

## 3. Relationship to the existing LLMStreamChunk

| Policy | Decision |
|---|---|
| Keep `LLMStreamChunk` | Yes — it remains the internal shape used inside provider adapters (any-llm / Anthropic / Vertex). |
| Provider → Core conversion | The adapter converts `LLMStreamChunk` → `NaiaStreamChunk`. |
| Core → Host emission | Only `NaiaStreamChunk` crosses the public boundary. |
| Backward compatibility | R3 code that imports `LLMStreamChunk` keeps working; core does the conversion. |

The provider layer therefore does not need to change to gain R4 capability.

---

## 4. Conversion rules (provider → core)

| LLMStreamChunk | NaiaStreamChunk |
|---|---|
| `{type:"start", id, model}` | `{type:"session_start", sessionId:id, adapterId:"llm", taskSummary:model}` |
| `{type:"content_block_delta", delta:{type:"text_delta",text}}` | `{type:"text_delta", sessionId, text}` |
| `{type:"content_block_delta", delta:{type:"thinking_delta",thinking}}` | `{type:"thinking_delta", sessionId, thinking}` |
| `{type:"content_block_delta", delta:{type:"input_json_delta",partialJson}}` | `{type:"input_json_delta", sessionId, partialJson}` |
| `{type:"content_block_start", block:{type:"tool_use",id,name,input}}` | `{type:"tool_use_start", sessionId, toolUseId:id, tool:name, input}` |
| `{type:"end", stopReason, usage}` | `{type:"end", sessionId, stopReason, usage}` |
| (none) | `{type:"audio_delta", ...}` ← voice cascade only (Slice 3-XR-Voice / P0c-2) |
| (none) | `{type:"image_delta", ...}` ← multi-modal provider only |

---

## 5. Sub-agent conversion rules (ACP → core)

The opencode ACP `session/update` event:

```json
{
  "method": "session/update",
  "params": {
    "sessionId": "...",
    "update": { "tool": "bash", "input": {...}, "phase": "executing" }
  }
}
```

becomes the following `NaiaStreamChunk`:

```json
{
  "type": "tool_use_start",
  "sessionId": "...",
  "toolUseId": "...",
  "tool": "bash",
  "input": {...}
}
```

Other mappings:

- ACP `session/file_changed` → `workspace_change` (with `sourceSession` set).
- ACP `session/done` → `session_end`.
- User cancel → ACP `session/cancel` → `interrupt` + `session_end(reason:"cancelled")`.

Full mapping table: `docs/adapter-contract.md`.

---

## 5b. session_aggregated (P0-11, supervisor responsibility)

**Problem** (Reference P0-2): `session_end` is emitted by the adapter, but the supervisor still needs to aggregate stats before producing the human-facing `report` — verification results, tool usage, and workspace stats must all be folded in.

**Solution**: after receiving `session_end`, the supervisor performs the following:

1. Aggregate every chunk emitted during the session (tool count, tokens, file changes).
2. Run the follow-up verification chain and collect results.
3. Emit `session_aggregated` with the fully populated stats.
4. Emit `report` — a human-readable summary chunk.

This hook pattern follows Vercel's `onStepFinish` and Mastra's session hooks.

**Example sequence** (single sub-session task):

```
session_start
  ├── session_progress (planning)
  ├── tool_use_start (read api.ts)
  ├── tool_use_end (ok)
  ├── session_progress (editing)
  ├── workspace_change (api.ts modify)
  ├── session_progress (testing)
session_end (reason: completed)
verification_start (test)
verification_result (test pass 24/24)
session_aggregated (stats aggregated)
report (human-readable summary)
end
```

---

## 6. Consumer pattern (host)

```typescript
// naia-shell or apps/cli
for await (const chunk of agent.stream({ message: "..." })) {
  switch (chunk.type) {
    case "text_delta": appendAlphaText(chunk.text); break;
    case "audio_delta": speakerWrite(chunk.pcm, chunk.sampleRate); break;
    case "image_delta": showImage(chunk.data, chunk.mediaType); break;
    case "session_start": addSessionCard(chunk); break;
    case "tool_use_start": updateSessionCard(chunk.sessionId, chunk); break;
    case "workspace_change": refreshDiffPanel(chunk); break;
    case "verification_result": showVerifyBadge(chunk); break;
    case "report": showHonestReport(chunk); break;
    case "interrupt": dimSession(chunk.sessionId, chunk.reason); break;
    case "session_end": closeSessionCard(chunk); break;
    case "session_aggregated": updateSessionCardStats(chunk); break;
    case "end": break;
    default: ((_: never) => {})(chunk);  // exhaustiveness guard
  }
}
```

The host is expected to handle every chunk variant exhaustively. Adding a new variant to the union therefore breaks the host's typecheck — that is intentional, and is the union's primary safety net.

---

## 7. Performance / stability guarantees

| Area | Guarantee |
|---|---|
| Backpressure | The stream is an async iterable, so a slow consumer naturally throttles the producer. |
| Binary size | `audio_delta.pcm` chunks should stay ≤ 64 KiB (under 4 s at 16 kHz). Larger chunks must be split. |
| Heap pressure | Large `image_delta.data` payloads are a Phase 4+ concern. The earlier phases do not emit `image_delta`. |
| Ordering | Within a single `sessionId`, emit order is preserved (sequential `await`). |
| Concurrency | Chunks belonging to different `sessionId`s may interleave freely. |
| Cancel safety | The producer must always check `signal.aborted`; on cancel it must emit `interrupt` followed by `session_end`. |

---

## 8. Test fixtures (G15 fixture-only mode compatibility)

Recorded `NaiaStreamChunk` sequences live in `packages/runtime/src/__fixtures__/` and are replayed by the `StreamPlayer` (introduced in Slice 1b, extended for `NaiaStreamChunk`). Fixture replay is the default verification mode in CI when no API key is available.

Today's fixtures (current state of the repository):

- `anthropic-1turn.json` — text-only single turn from an Anthropic-shape provider.
- `qwen-1turn.json` — text-only single turn from an OpenAI-compatible provider.
- `memory-context-stream.json` — memory-context-prefixed turn (used by the recall regression suites).

Planned fixtures (not yet recorded; tracked alongside the corresponding slice work):

- `tool-call-1turn.json` — `tool_use_start` + `workspace_change` + `tool_use_end`.
- `verification-pass.json` — `verification_start` + `verification_result` (pass).
- `interrupt-mid-tool.json` — user interrupt mid-tool.
- `multi-session.json` — two sessions interleaved (multi-supervisor track).
- `voice-audio.json` — `audio_delta` sequence (Slice 3-XR-Voice / P0c-2, deferred).

---

## 9. Change procedure after the R4 lock

To add a new variant to the union:

1. Update this document with the new variant, its semantics, and any provider/adapter conversion rules.
2. Update the union in `packages/types/src/stream.ts`.
3. Extend the exhaustive `switch` in every consumer (`apps/cli`, `naia-shell`, embedders) — the typechecker will enforce this.
4. Add or record the corresponding fixture under `packages/runtime/src/__fixtures__/`.
5. Cross-review (paranoid auditor) before merging.

---

## 10. Status snapshot (2026-05-20)

This protocol has been carrying the runtime through the Slice 3-XR series. Recent slices that exercise it end-to-end:

- **Slice 3-XR-G** — integration scenarios + LLM-as-judge across the ADK ecosystem (DONE).
- **Slice 3-XR-H** — multi-judge ensemble (GLM + Codex + Claude) over the existing scenario stream (DONE).
- **Slice 3-XR-I** — pi-based coding LIVE verification (Group P, DONE).
- **Slice 3-XR-J** — `--skills-dir` + the naia-adk skills full set, exercised over the same stream (DONE).
- **Slice 3-XR-L** — onmam-adk domain skills auto-applied (DONE).
- **Slice 3-XR-M / N / O** — multi-turn REPL, cross-OS sanity, and the naia-agent ↔ Claude Code parity ledger (all DONE).

Open / deferred items that the protocol explicitly accommodates:

- **Slice 3-XR-Voice (Task #28, P0c-2)** — agent-layer voice cascade integration (LiveKit + VoxCPM2). `audio_delta` exists in the union today; the recorded `voice-audio.json` fixture and the production producer are deferred to this slice. The earlier in-model omni route (MiniCPM-o 4.5) is deprecated.
- **Adversarial review chunks (`review_request` / `review_finding`)** — Phase 4+ work.
- **`image_delta` production path** — Phase 4+ once a multi-modal provider is wired in.
