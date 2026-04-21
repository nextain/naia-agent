/**
 * Voice I/O contract — shared across naia-agent (TTS) and naia-os shell (STT).
 *
 * Per Phase 0 S6 decision (Option C, 3-layer hybrid):
 *   TTS lives in agent (emits audio_chunk + viseme)
 *   STT lives in shell (emits transcript back to agent)
 *   VoiceEvent is the cross-layer contract both sides speak.
 *
 * See: docs/voice-pipeline-audit.md
 */

import type { Event } from "./event.js";

export type VoiceEvent =
  | VoiceAudioChunkEvent
  | VoiceVisemeEvent
  | VoiceTranscriptEvent;

/** Audio payload from TTS (agent → shell). */
export interface VoiceAudioChunkEvent extends Event {
  name: `voice.audio.${string}`;
  /** Base64-encoded audio bytes. */
  audioBase64: string;
  mediaType: string;
  /** Final chunk for this utterance? */
  final?: boolean;
}

/** Viseme for VRM lip-sync (agent → shell). */
export interface VoiceVisemeEvent extends Event {
  name: `voice.viseme.${string}`;
  /** Viseme id — implementation-defined vocabulary (ARKit / Oculus / custom). */
  visemeId: string;
  /** Weight / intensity 0..1. */
  weight?: number;
}

/** Recognized speech text from STT (shell → agent). */
export interface VoiceTranscriptEvent extends Event {
  name: `voice.transcript.${string}`;
  transcript: string;
  /** Partial (in-progress) vs final (committed) transcript. */
  partial?: boolean;
  /** BCP-47 language tag (e.g. "ko-KR"). Optional if auto-detected. */
  lang?: string;
}
