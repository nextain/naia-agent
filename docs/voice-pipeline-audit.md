# Voice Pipeline Audit

> **Languages**: English (this file) · [한국어](../.users/docs/ko/voice-pipeline-audit.md)

## Boundary

Voice pipeline (STT, TTS, audio device I/O, streaming orchestration) is **naia-os + naia-omni territory**.

naia-agent's role in voice: **LLM brain only** — text in, text out. The same runtime used by the CLI.

naia-agent has no dependency on LiveKit, WebRTC, VoxCPM2, Whisper, or any audio hardware. Those are internal to naia-omni and must not be exposed here.

## Integration pattern

```
naia-omni / naia-os
  ├── audio device I/O (mic/speaker)
  ├── STT → text
  └── text → naia-agent (chat_request IPC)
              ↓ LLM response text
  ├── TTS → audio
  └── play audio
```

naia-agent sees only a `chat_request` with text content. It has no awareness of the voice session around it.

## Historical note (DEPRECATED plans)

- **Option C (MiniCPM-o-4.5 / vllm-omni / 3-layer hybrid)** — deprecated 2026-05-20. See memory `project_minicpm_o_4_5_deprecated_2026_05_20`.
- **P0c-2 / Slice 3-XR-Voice "naia-agent integration"** — withdrawn. naia-agent does not integrate LiveKit directly; voice orchestration belongs in naia-os/naia-omni.
