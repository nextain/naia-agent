# 스트림 프로토콜 — NaiaStreamChunk (R4 lock 2026-04-26)

> **언어**: [English](../../../docs/stream-protocol.md) · 한국어 (이 파일)

> **상위 문서**: `docs/vision-statement.md` / `docs/architecture-hybrid.md`
> **이전 형태**: `LLMStreamChunk` (R3, `providers/types/llm.ts`) — 텍스트 전용.
> **상태**: 디자인 lock (Week 0).
> **배경**: voice 와 multi-agent 시대 — 텍스트 / 오디오 / 이미지 가 1급 시민이 되어야 하고, sub-agent 감독 이벤트도 **하나의 통합 스트림**을 타고 흘러야 한다.
> **음성 주석**: 음성 출력은 **agent-layer cascade** 트랙 (Slice 3-XR-Voice / P0c-2 — LiveKit + VoxCPM2, 현재 deferred) 으로 생산한다. 이전의 모델 내장 omni 경로 (MiniCPM-o 4.5 / vllm-omni) 는 **폐기**되었다. 메모리 `project_minicpm_o_4_5_deprecated_2026_05_20` 참고.

---

## 1. 통합 스트림이 필요한 이유

기존 `LLMStreamChunk` 는 LLM 응답 스트림만 표현했다. 그러나 실제 호스트 (`naia-shell`, `apps/cli`, 임의 embedder) 는 여러 source 의 이벤트를 한 흐름으로 받아야 한다:

| Source | 종류 | R3 시점 |
|---|---|---|
| LLM 응답 | text / thinking / tool_use 토큰 | LLMStreamChunk |
| Sub-agent 활동 | tool_use_start/end, file_change | (없음) |
| Workspace | 파일 watcher 결과 | (없음) |
| Verification | test / lint 결과 | (없음) |
| 다중 sub-session 통합 | session_update / session_progress | (없음) |
| 음성 | audio_delta (voice cascade 출력, agent-layer — Slice 3-XR-Voice / P0c-2) | (없음) |

→ `NaiaStreamChunk` 는 **모든 layer 를 운반하는 단일 union** (결정 D20).

---

## 2. NaiaStreamChunk union (정식 spec)

참조 구현은 `packages/types/src/stream.ts` 에 있다. 아래 형태가 spec 이고, 소스 파일이 실행 가능한 형태다.

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
      phase: SessionPhase;        // P0-1 fix — 문자열 리터럴 union (consumer 추론 가능)
      progress?: number;          // 0~1
      note?: string;
    }
  | {
      type: "session_end";
      sessionId: string;
      reason: SessionEndReason;
      stats?: SessionStats;
    }
  // P0-11: onSessionEnd hook (Vercel onStepFinish + Mastra) — supervisor 가
  // 사람-읽기 `report` chunk 전에 emit 한다.
  | {
      type: "session_aggregated";   // supervisor 가 session_end 이후 stats aggregate 완료
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
      path: string;                // workdir 상대 경로
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
      stdoutTail?: string;          // 마지막 N 줄, payload 크기 제한
    }

  // ─── 정직 보고 (D19) ──────────────────────────────────────────────
  | {
      type: "report";
      sessionId: string;
      summary: string;              // 예: "3 file 수정, +12/-3 line, test 24/24 PASS"
      stats: ReportStats;
      verifications: readonly VerificationResultRef[];
    }

  // ─── adversarial review (Phase 4+) ────────────────────────────────
  | {
      type: "review_request";
      sessionId: string;
      target: "diff" | "plan" | "session_result";
      reviewerId: string;            // 다른 모델 / agent
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
  | "spawning"        // adapter 가 child process / session 을 spawn
  | "planning"        // sub-agent 가 task 분해
  | "editing"         // 파일 수정 진행 중
  | "executing"       // shell / tool 실행
  | "testing"         // test runner
  | "verifying"       // 후속 verification chain
  | "reviewing"       // adversarial review (Phase 4+)
  | "completed"
  | "failed";

export type SessionEndReason =
  | "completed"       // 정상 종료
  | "cancelled"       // 사용자 cancel (interrupt + cancel())
  | "failed"          // adapter 에러 (exit code != 0 또는 exception)
  | "timeout"         // signal abort 또는 wall-clock timeout
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

## 3. 기존 LLMStreamChunk 와의 관계

| 정책 | 결정 |
|---|---|
| `LLMStreamChunk` 유지 | 예 — provider adapter 내부 형식 (any-llm / Anthropic / Vertex) 으로 그대로 유지. |
| Provider → Core 변환 | adapter 가 `LLMStreamChunk` → `NaiaStreamChunk` 로 변환. |
| Core → Host emit | 공개 경계는 오직 `NaiaStreamChunk` 만 통과. |
| Backward compatibility | `LLMStreamChunk` 를 import 하는 R3 코드는 그대로 동작. core 가 변환. |

→ provider layer 를 손대지 않고도 R4 능력을 추가할 수 있다.

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
| (없음) | `{type:"audio_delta", ...}` ← voice cascade 전용 (Slice 3-XR-Voice / P0c-2) |
| (없음) | `{type:"image_delta", ...}` ← multi-modal provider 전용 |

---

## 5. Sub-agent 변환 규칙 (ACP → core)

opencode ACP `session/update` 이벤트:

```json
{
  "method": "session/update",
  "params": {
    "sessionId": "...",
    "update": { "tool": "bash", "input": {...}, "phase": "executing" }
  }
}
```

는 다음 `NaiaStreamChunk` 가 된다:

```json
{
  "type": "tool_use_start",
  "sessionId": "...",
  "toolUseId": "...",
  "tool": "bash",
  "input": {...}
}
```

다른 매핑:

- ACP `session/file_changed` → `workspace_change` (`sourceSession` 채움).
- ACP `session/done` → `session_end`.
- 사용자 cancel → ACP `session/cancel` → `interrupt` + `session_end(reason:"cancelled")`.

상세 매핑은 `docs/adapter-contract.md` 참고.

---

## 5b. session_aggregated (P0-11, supervisor 책임)

**문제** (Reference P0-2): `session_end` 은 adapter 가 emit 한다. 그러나 supervisor 가 사람-읽기 `report` 를 만들기 전에 stats 를 aggregate 해야 한다 — verification 결과 + tool 사용량 + workspace stats 모두 합산.

**해결**: supervisor 는 `session_end` 수신 후 다음을 수행한다:

1. session 동안 emit 된 모든 chunk 집계 (tool 횟수, 토큰, 파일 변경).
2. 후속 verification 실행 + 결과 수집.
3. `session_aggregated` chunk emit (모든 stats 채워서).
4. `report` chunk emit (사람-읽기 좋은 summary).

이 hook 패턴은 Vercel `onStepFinish` + Mastra session hook 과 같다.

**예시 시퀀스** (단일 sub-session task):

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

## 6. consumer 패턴 (host)

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

→ host 는 모든 chunk variant 를 exhaustive 하게 처리해야 한다. union 에 새 variant 가 추가되면 host 의 typecheck 가 깨진다 — 이는 의도된 동작이며, union 의 가장 중요한 안전망이다.

---

## 7. 성능 / 안정 보장

| 영역 | 보장 |
|---|---|
| Backpressure | async iterable 이므로 consumer 가 느려지면 producer 가 자연스럽게 wait. |
| Binary 크기 | `audio_delta.pcm` chunk 는 ≤ 64 KiB 권고 (16 kHz 기준 4 초 미만). 큰 chunk 는 split. |
| Heap pressure | 큰 `image_delta.data` 는 Phase 4+ 처리. 그 이전 phase 에서는 `image_delta` emit 안 함. |
| Ordering | 같은 `sessionId` 안에서 emit 순서 보장 (sequential `await`). |
| Concurrency | 다른 `sessionId` chunk 는 interleave OK. |
| Cancel safety | producer 는 항상 `signal.aborted` 체크. cancel 시 `interrupt` + `session_end` 보장. |

---

## 8. Test fixture (G15 fixture-only mode 호환)

녹화된 `NaiaStreamChunk` 시퀀스는 `packages/runtime/src/__fixtures__/` 에 있고, `StreamPlayer` (Slice 1b 도입, `NaiaStreamChunk` 용으로 확장) 가 재생한다. CI 에서 API 키가 없을 때 fixture replay 가 기본 검증 모드다.

현재 fixture (레포 현 상태):

- `anthropic-1turn.json` — Anthropic 형태 provider 의 텍스트 단일 turn.
- `qwen-1turn.json` — OpenAI 호환 provider 의 텍스트 단일 turn.
- `memory-context-stream.json` — 메모리 context prefix 가 들어간 turn (recall 회귀 suite 가 사용).

계획된 fixture (아직 녹화 전; 해당 슬라이스와 함께 추적):

- `tool-call-1turn.json` — `tool_use_start` + `workspace_change` + `tool_use_end`.
- `verification-pass.json` — `verification_start` + `verification_result` (pass).
- `interrupt-mid-tool.json` — tool 도중 사용자 interrupt.
- `multi-session.json` — 두 session 병렬 interleave (multi-supervisor 트랙).
- `voice-audio.json` — `audio_delta` 시퀀스 (Slice 3-XR-Voice / P0c-2, deferred).

---

## 9. R4 lock 후 변경 절차

union 에 새 variant 를 추가할 때:

1. 본 문서에 새 variant + 의미 + provider/adapter 변환 규칙 갱신.
2. `packages/types/src/stream.ts` union 갱신.
3. 모든 consumer (`apps/cli`, `naia-shell`, embedder) 의 exhaustive `switch` 확장 — typechecker 가 강제한다.
4. `packages/runtime/src/__fixtures__/` 아래에 해당 fixture 추가 또는 녹화.
5. 머지 전 cross-review (paranoid auditor).

---

## 10. 진행 상태 스냅샷 (2026-05-20)

이 프로토콜은 Slice 3-XR 시리즈를 통해 런타임을 견인해 왔다. 최근 슬라이스 중 이 스트림을 end-to-end 로 실행한 항목:

- **Slice 3-XR-G** — ADK 생태계 전반의 통합 시나리오 + LLM-as-judge (DONE).
- **Slice 3-XR-H** — 기존 시나리오 스트림 위에서 multi-judge ensemble (GLM + Codex + Claude) (DONE).
- **Slice 3-XR-I** — pi 기반 코딩 LIVE 검증 (Group P, DONE).
- **Slice 3-XR-J** — `--skills-dir` + naia-adk 스킬 풀셋, 같은 스트림에서 실행 (DONE).
- **Slice 3-XR-L** — onmam-adk 도메인 스킬 자동 적용 (DONE).
- **Slice 3-XR-M / N / O** — multi-turn REPL, cross-OS sanity, naia-agent ↔ Claude Code parity ledger (모두 DONE).

프로토콜이 명시적으로 수용하지만 아직 열린 / deferred 항목:

- **Slice 3-XR-Voice (Task #28, P0c-2)** — agent-layer voice cascade 통합 (LiveKit + VoxCPM2). `audio_delta` 는 이미 union 에 존재. 녹화된 `voice-audio.json` fixture 와 production producer 는 이 슬라이스로 미뤘다. 이전의 모델 내장 omni 경로 (MiniCPM-o 4.5) 는 폐기.
- **Adversarial review chunk (`review_request` / `review_finding`)** — Phase 4+ 작업.
- **`image_delta` production 경로** — multi-modal provider 가 연결되는 Phase 4+ 이후.
