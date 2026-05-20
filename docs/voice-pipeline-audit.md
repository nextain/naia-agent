# Voice Pipeline Audit

> **Languages**: English (this file) · [한국어](../.users/docs/ko/voice-pipeline-audit.md)

> ## ⚠️ DEPRECATED — MiniCPM-o-4.5 / vllm-omni / Option C plan
>
> The entire MiniCPM-o-4.5 + vllm-omni + Option C (3-layer hybrid) plan
> previously captured in this file is **deprecated** as of 2026-05-20.
>
> See memory entry `project_minicpm_o_4_5_deprecated_2026_05_20` for the
> deprecation rationale. The canonical replacement is the LiveKit Agents +
> VoxCPM2 + Whisper-large-v3 cascade described in §1 below.
>
> The MiniCPM-o-4.5 narrative is retained in §3 (Historical archive) for
> traceability only; do **not** plan against it.

This document is the canonical voice pipeline audit for `naia-agent`. It
records the current cascade architecture, the integration boundary into
naia-agent (Task #28, P0c-2), and the historical Option C plan that has
been superseded.

## 1. Current voice cascade (canonical, 2026-05-20)

The new voice path is a 3-stage open cascade orchestrated by the LiveKit
Agents framework:

| Stage | Component | Notes |
|---|---|---|
| STT | Whisper-large-v3 | Speech → text. Replaces the legacy Tauri Rust STT plugin path for cascade-mode usage. |
| LLM | naia-agent runtime | Text → text. The same runtime that powers the CLI / host APIs; reused unchanged. |
| TTS | VoxCPM2 (OpenAI-compatible endpoint) | Text → audio. Exposed via an OpenAI-compatible TTS HTTP surface for vendor neutrality. |

LiveKit Agents owns the realtime room session, audio framing, VAD,
turn-taking, and the STT ↔ LLM ↔ TTS handoff. naia-agent provides the LLM
turn, identical to its non-voice surface.

### Task tracking

- **Task #28 (Slice 3-XR-Voice)** — `P0c-2`: naia-agent integration only.
  Status: **deferred** (will be picked up after Slice 3-XR-M/N/O closes
  or in a dedicated session).
- **P0c-1** — standalone tech demo (LiveKit ↔ ko-serve, mock LLM, zero
  naia-agent dependency). Status: **delivered by another session** as a
  reference artefact. Not in this repository.

Splitting `P0c` into a vendor-side standalone demo (P0c-1) and a
naia-agent-side integration slice (P0c-2) isolates product-viability
risk (the cascade itself) from naia-agent integration risk (the
LLM-wrapper + memory-hook seam).

### naia-agent integration surface (Task #28, P0c-2 scope)

The integration is intentionally small:

1. **`livekit-plugins-naia-voxcpm2`** — plugin exposing the VoxCPM2
   OpenAI-compatible endpoint to LiveKit Agents as a TTS provider.
2. **naia LLM → LiveKit wrapper** — adapts a naia-agent turn (text-in /
   text-out) into the LiveKit Agents LLM interface.
3. **`VoiceSession`** — orchestration object hosting the cascade for a
   single room participant.
4. **Memory hook** — wires naia-agent's `--memory` recall path so voice
   turns participate in long-term recall just like CLI turns. See
   `docs/memory-provider-audit.md`.

The direct-path "final-text bias" risk surfaced in the cross-review is
resolved inside P0c-2; P0c-1 sidesteps it by using a mock LLM. The
exit-gate spec for that resolution (G1 cancel-propagation, G2 no-write-
on-cancel, G3 partial-text path, G4 tool-hop cancel) is locked in
`docs/voice-cascade-contract.md`.

## 2. Source references

- `docs/voice-cascade-contract.md` — four exit gates the P0c-2
  implementation must satisfy before Slice 3-XR-Voice merge (G1–G4) and
  the LiveKit lock-in re-evaluation triggers.
- `.agents/progress/slice-3-xr-h-i-j-l-plan-2026-05-20.md` §4.5 — voice
  track split (P0c-1 standalone vs P0c-2 naia-agent integration), and
  §5 deferred ledger marking `3-XR-Voice (#28) = P0c-2 only`.
- `CHANGELOG.md` Slice 3-XR-M/N/O entry — "Voice 트랙 (#28) 분리 흡수"
  section confirming Task #28 description narrowed to P0c-2.
- Memory entry `project_minicpm_o_4_5_deprecated_2026_05_20` —
  deprecation rationale for the prior MiniCPM-o-4.5 / vllm-omni / Option
  C plan.

## 3. Historical archive — Option C (DEPRECATED)

The sections below describe the previous Option C (3-layer hybrid) plan
that depended on MiniCPM-o-4.5 + vllm-omni. They are kept for
traceability only and **must not be planned against**. The canonical
plan is §1 above.

### 3.1 Original TTS layers (3) — historical

| Layer | Location | Role |
|---|---|---|
| Provider SDKs | `naia-os/agent/src/tts/*.ts` (8 files — edge, elevenlabs, google, nextain, openai + registry + types + gcp-auth) | Direct TTS provider calls |
| Skill entry | `naia-os/agent/src/skills/built-in/tts.ts` | Skill descriptor wiring to provider call |
| Gateway proxy | `naia-os/agent/src/gateway/tts-proxy.ts` | OpenClaw-era bridge between shell and TTS |

### 3.2 Original STT layers — historical

| Layer | Location | Role |
|---|---|---|
| Native STT models | `naia-os/shell/src-tauri/src/stt_models.rs` | Rust-side STT integration |
| Tauri plugin | `naia-os/shell/src-tauri/plugins/tauri-plugin-stt/` | STT provider plugin for shell |
| E2E tests | `naia-os/shell/e2e-tauri/specs/{77,86,88,99}-stt-*.spec.ts` | Full-pipeline tests through shell |
| GCP auth (shared with TTS) | `naia-os/agent/src/tts/gcp-auth.ts` | Google Cloud auth used by both STT (shell) and TTS (agent) |

### 3.3 Original asymmetry rationale — historical

- TTS was agent-side (TS, 8 files under `agent/src/tts/`).
- STT was shell-side (Rust, native plugins).
- Shared infrastructure: Google Cloud auth — used by both layers despite
  living physically in `agent/src/tts/`.

The asymmetry was a historical artefact:

- TTS runs text → audio, easy to implement as Node.js via SDKs.
- STT runs audio → text, needed low-level OS audio capture → Rust plugin
  was natural.
- VRM avatar lip-sync (shell `@pixiv/three-vrm`) consumed **viseme**
  events that TTS emitted → tight shell coupling for TTS output even
  though TTS lived in agent.

### 3.4 Original Option C — historical, DEPRECATED

The Option C (3-layer hybrid) decision recorded here on 2026-04-21
("Phase 0 S6 closed") is **superseded** by the LiveKit Agents cascade in
§1. Do not implement against Option C. The `VoiceEvent` contract in
`@nextain/agent-types`, the `@naia-agent/tts` extraction (formerly Phase
2 X7), and the agent-side/shell-side ownership split are all retired.

## 4. References (current)

- Migration plan: `alpha-adk/.agents/progress/naia-4repo-migration-plan.md`
  — voice section requires refresh to reflect the cascade (separate task).
- Slice plan: `.agents/progress/slice-3-xr-h-i-j-l-plan-2026-05-20.md`
  §4.5 (Voice track split) + §5 (deferred ledger).
- CHANGELOG: Slice 3-XR-M/N/O entry, "Voice 트랙 (#28) 분리 흡수".
- Memory: `project_minicpm_o_4_5_deprecated_2026_05_20`.
