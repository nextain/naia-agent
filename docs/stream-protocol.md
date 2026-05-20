# Stream Protocol — NaiaStreamChunk (R4 lock 2026-04-26)

> **상위**: `docs/vision-statement.md` / `docs/architecture-hybrid.md`
> **이전**: `LLMStreamChunk` (R3, providers/types/llm.ts) — text-only
> **status**: design lock (Week 0)
> **rationale**: voice-capable + multi-agent era — text/audio/image are first-class citizens + sub-agent supervision events flow through a unified stream. Voice = agent-layer cascade (Slice 3-XR-Voice / P0c-2, LiveKit + VoxCPM2), NOT in-model omni (deprecated; cf `project_minicpm_o_4_5_deprecated_2026_05_20`).

---

## 1. Why a unified stream

기존 `LLMStreamChunk` = LLM 응답 stream만. 그러나 사용자(naia-shell/CLI)는 **여러 source**의 event를 한 흐름으로 받아야 함:

| Source | 종류 | R3까지 |
|---|---|---|
| LLM 응답 | text/thinking/tool_use 토큰 | LLMStreamChunk |
| sub-agent 활동 | tool_use_start/end, file_change | (없음) |
| workspace | file watcher 결과 | (없음) |
| verification | test/lint 결과 | (없음) |
| 다중 sub-session 통합 | session_update / session_progress | (없음) |
| voice | audio_delta (voice cascade output, agent-layer — Slice 3-XR-Voice / P0c-2) | (none) |

→ `NaiaStreamChunk` = **모든 layer를 통합한 single stream** (D20).

---

## 2. NaiaStreamChunk union (정식 spec)

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

  // ─── tool lifecycle (LLM 또는 sub-agent) ──────────────────────────
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
      phase: SessionPhase;        // P0-1 fix — string literal union (consumer 추론 가능)
      progress?: number;          // 0~1
      note?: string;
    }
  | {
      type: "session_end";
      sessionId: string;
      reason: SessionEndReason;
      stats?: SessionStats;
    }
  // P0-11: onSessionEnd hook (Vercel onStepFinish + Mastra) — supervisor가 report 생성 전 emit
  | {
      type: "session_aggregated";   // session_end 후 supervisor가 stats aggregate 완료
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

  // ─── workspace 가시성 (D19) ───────────────────────────────────────
  | {
      type: "workspace_change";
      path: string;                // workdir-relative
      kind: "add" | "modify" | "delete" | "rename";
      sourceSession?: string;      // 이 변경을 일으킨 sub-session (있을 때)
      diff?: string;               // unified diff (lazy, 요청 시만 채움)
      stats?: { additions: number; deletions: number };
    }

  // ─── verification (자동 검증, D19) ────────────────────────────────
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
      stdoutTail?: string;          // 마지막 N줄, 큰 출력 방지
    }

  // ─── 정직 보고 (D19) ──────────────────────────────────────────────
  | {
      type: "report";
      sessionId: string;
      summary: string;              // "3 file 수정, +12/-3 line, test 24/24 PASS"
      stats: ReportStats;
      verifications: readonly VerificationResultRef[];
    }

  // ─── adversarial review (Phase 4+) ────────────────────────────────
  | {
      type: "review_request";
      sessionId: string;
      target: "diff" | "plan" | "session_result";
      reviewerId: string;            // 다른 모델/agent
    }
  | {
      type: "review_finding";
      sessionId: string;
      reviewerId: string;
      severity: "info" | "warn" | "error";
      message: string;
      location?: string;
    }

  // ─── 종료 ────────────────────────────────────────────────────────
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
  | "completed"       // 정상 종료
  | "cancelled"       // 사용자 cancel (interrupt + cancel())
  | "failed"          // adapter 에러 (exit code != 0 또는 exception)
  | "timeout"         // signal abort or wall-clock timeout
  | "network"         // ACP/SDK connection lost (reconnect 실패 후)
  | "paused";         // 일시 정지 (resume() 가능)

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

## 3. 기존 LLMStreamChunk와 관계

| 정책 | 결정 |
|---|---|
| LLMStreamChunk 유지 | ✓ — provider adapter 내부 형식 (any-llm/anthropic/vertex) |
| Provider → Core 변환 | adapter가 LLMStreamChunk → NaiaStreamChunk 변환 |
| Core → Host emit | NaiaStreamChunk만 사용 |
| Backward compat | LLMStreamChunk를 import하는 R3 코드는 그대로. core가 변환 |

→ provider layer 변경 없이 R4 추가 가능.

---

## 4. 변환 규칙 (provider → core)

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

## 5. Sub-agent 변환 규칙 (ACP → core)

opencode ACP `session/update` event:
```json
{
  "method": "session/update",
  "params": {
    "sessionId": "...",
    "update": { "tool": "bash", "input": {...}, "phase": "executing" }
  }
}
```

→ NaiaStreamChunk:
```json
{
  "type": "tool_use_start",
  "sessionId": "...",
  "toolUseId": "...",
  "tool": "bash",
  "input": {...}
}
```

ACP `session/file_changed` → `workspace_change` (sourceSession 채움)
ACP `session/done` → `session_end`
사용자 cancel → ACP `session/cancel` → `interrupt` + `session_end(reason:"cancelled")`

상세 매핑은 `docs/adapter-contract.md`.

---

## 5b. session_aggregated (P0-11, supervisor 책임)

**문제** (Reference P0-2): `session_end`은 adapter가 emit. 그러나 supervisor가 `report`를 만들기 전에 stats를 aggregate해야 함 (verification 결과 + tool 사용량 + workspace stats 합산).

**해결**: supervisor는 `session_end` 수신 후 다음을 수행:
1. session 동안 emit된 모든 chunk 집계 (tool count, tokens, file changes)
2. 후속 verification 실행 + 결과 수집
3. `session_aggregated` chunk emit (모든 stats 채워서)
4. `report` chunk emit (사람-읽기 좋은 summary)

이 hook 패턴 = Vercel `onStepFinish` + Mastra hook.

**예시 시퀀스** (1 sub-session task):
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
session_aggregated (stats 합산)
report (사람-읽기 summary)
end
```

---

## 6. consumer pattern (host)

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
    default: ((_: never) => {})(chunk);  // exhaustiveness
  }
}
```

→ host가 모든 chunk type 처리 (exhaustive switch). union 추가 시 typecheck 깨짐 (의도된 안전망).

---

## 7. 성능 / 안정 보장

| 영역 | 보장 |
|---|---|
| backpressure | async iterable. consumer slow → producer 자연 wait |
| binary size | `audio_delta.pcm` chunk size 권고 ≤ 64 KiB (16kHz 4초 미만). 큰 chunk는 split |
| heap pressure | `image_delta.data` 큰 image는 Phase 4+ 처리. Phase 1~3은 image emit 안 함 |
| ordering | 같은 sessionId 안에서 emit 순서 보장 (sequential await) |
| concurrency | 다른 sessionId chunk는 interleave OK |
| cancel safety | producer는 항상 `signal.aborted` 체크. cancel 시 `interrupt` + `session_end` 보장 |

---

## 8. test fixture (G15 fixture-only mode 호환)

`packages/runtime/src/__fixtures__/`에 NaiaStreamChunk 시퀀스 JSON:
- `simple-1turn.json` — text only 1 turn
- `tool-call-1turn.json` — tool_use_start + workspace_change + tool_use_end
- `verification-pass.json` — verification_start + verification_result(pass)
- `interrupt-mid-tool.json` — tool 중 사용자 interrupt
- `multi-session.json` — 2 session 병렬 interleave (Phase 3)
- `voice-audio.json` — audio_delta sequence (Slice 3-XR-Voice / P0c-2, deferred)

`StreamPlayer` (Slice 1b 기존)를 NaiaStreamChunk로 확장. fixture replay = CI default.

---

## 9. R4 lock 후 변경 절차

union 추가 시:
1. 본 파일에 새 variant + 해석 + 변환 규칙
2. `packages/types/src/stream.ts` union 갱신
3. consumer (apps/cli, naia-shell) 모두 exhaustive 처리 보강 (typecheck 강제)
4. fixture 새 case 추가
5. cross-review (paranoid auditor)
