/**
 * NaiaStreamChunk — Phase 1+ unified multi-modal/multi-source stream protocol.
 *
 * Spec: docs/stream-protocol.md (R4 lock 2026-04-26)
 *
 * Replaces text-only LLMStreamChunk for the Hybrid Wrapper supervisor layer.
 * Sub-agent events, workspace changes, verification results, and audio/image
 * deltas all flow through the same async iterable. Consumers should use
 * exhaustive switch with `default: ((_: never) => {})(chunk)` to catch new
 * variants at compile time.
 *
 * D20 (multi-modal stream) + D21 (interrupt) + D24 (supervisor) + D26 (onSessionEnd)
 */
import type { LLMUsage } from "./llm.js";

/** Sub-agent or LLM session lifecycle phase. P0-1 fix (Architect) — string literal union. */
export type SessionPhase =
  | "spawning"
  | "planning"
  | "editing"
  | "executing"
  | "testing"
  | "verifying"
  | "reviewing"
  | "completed"
  | "failed";

/** Sub-agent / LLM session termination reason. */
export type SessionEndReason =
  | "completed"
  | "cancelled"
  | "failed"
  | "timeout"
  | "network"
  | "paused";

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

export type AudioFormat = "pcm_s16le" | "opus" | "wav_chunk";
export type AudioChannels = 1 | 2;

export type NaiaStreamChunk =
  // ─── LLM tokens (text-first) ──────────────────────────────────────
  | { type: "text_delta"; sessionId: string; text: string }
  | { type: "thinking_delta"; sessionId: string; thinking: string }
  | { type: "input_json_delta"; sessionId: string; partialJson: string }

  // ─── multi-modal tokens (omni LLM) ────────────────────────────────
  | {
      type: "audio_delta";
      sessionId: string;
      pcm: Uint8Array;
      sampleRate: number;
      channels: AudioChannels;
      format: AudioFormat;
    }
  | {
      type: "image_delta";
      sessionId: string;
      mediaType: "image/png" | "image/jpeg" | "image/webp";
      data: Uint8Array;
      isPartial: boolean;
    }

  // ─── tool lifecycle ───────────────────────────────────────────────
  | {
      type: "tool_use_start";
      sessionId: string;
      toolUseId: string;
      tool: string;
      input: unknown;
      tier?: "T0" | "T1" | "T2" | "T3";
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
      adapterId: string;
      taskSummary: string;
      workdir: string;
    }
  | {
      type: "session_progress";
      sessionId: string;
      phase: SessionPhase;
      progress?: number;
      note?: string;
    }
  | {
      type: "session_end";
      sessionId: string;
      reason: SessionEndReason;
      stats?: SessionStats;
    }
  | {
      type: "session_aggregated"; // D26 — supervisor가 stats aggregate 후 emit (report 전)
      sessionId: string;
      stats: SessionStats;
      verifications: readonly VerificationResultRef[];
    }
  | {
      type: "interrupt";
      sessionId: string;
      reason: string;
      mode: "hard_kill" | "soft_pause" | "approval_gate";
    }

  // ─── workspace 가시성 (D19) ───────────────────────────────────────
  | {
      type: "workspace_change";
      path: string;
      kind: "add" | "modify" | "delete" | "rename";
      sourceSession?: string;
      diff?: string;
      stats?: { additions: number; deletions: number };
    }

  // ─── verification (D19/D27) ───────────────────────────────────────
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
      stdoutTail?: string;
    }

  // ─── 정직 보고 (D19) ──────────────────────────────────────────────
  | {
      type: "report";
      sessionId: string;
      summary: string;
      stats: ReportStats;
      verifications: readonly VerificationResultRef[];
    }

  // ─── adversarial review (Phase 4+) ────────────────────────────────
  | {
      type: "review_request";
      sessionId: string;
      target: "diff" | "plan" | "session_result";
      reviewerId: string;
    }
  | {
      type: "review_finding";
      sessionId: string;
      reviewerId: string;
      severity: "info" | "warn" | "error";
      message: string;
      location?: string;
    }

  // ─── 종료 ─────────────────────────────────────────────────────────
  | {
      type: "end";
      sessionId: string;
      stopReason:
        | "end_turn"
        | "max_tokens"
        | "stop_sequence"
        | "tool_use"
        | "cancelled"
        | "error";
      usage?: LLMUsage;
    };
