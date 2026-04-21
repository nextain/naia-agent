# Voice Pipeline Audit — Phase 0 S6

**Status**: decision made — **Option C (3-layer hybrid)**. Ratified by
maintainer on 2026-04-21. See §5 for the resolved action items.

This audit captures the current TTS + STT surface across naia-os so the
Phase 0 S6 decision (voice pipeline ownership: `naia-agent` vs `shell` vs
3-layer-hybrid) can be made on observed data, not intuition.

## 1. Current TTS layers (3)

| Layer | Path | Role |
|---|---|---|
| Provider SDKs | `naia-os/agent/src/tts/*.ts` (8 files — edge, elevenlabs, google, nextain, openai + registry + types + gcp-auth) | Direct TTS provider calls |
| Skill entry | `naia-os/agent/src/skills/built-in/tts.ts` | Skill descriptor wiring to provider call |
| Gateway proxy | `naia-os/agent/src/gateway/tts-proxy.ts` | OpenClaw-era bridge between shell and TTS (now that OpenClaw is gone per #201, role is reduced) |

## 2. Current STT layers

| Layer | Path | Role |
|---|---|---|
| Native STT models | `naia-os/shell/src-tauri/src/stt_models.rs` | Rust-side STT integration (Whisper/Vosk?) |
| Tauri plugin | `naia-os/shell/src-tauri/plugins/tauri-plugin-stt/` | STT provider plugin for shell |
| E2E tests | `naia-os/shell/e2e-tauri/specs/{77,86,88,99}-stt-*.spec.ts` | Full-pipeline tests through shell |
| GCP auth (shared with TTS) | `naia-os/agent/src/tts/gcp-auth.ts` | Google Cloud auth used by both STT (shell) and TTS (agent) |

## 3. Observed asymmetry

- **TTS is agent-side** (TS, 8 files under `agent/src/tts/`)
- **STT is shell-side** (Rust, native plugins)
- **Shared infrastructure**: Google Cloud auth — used by both layers despite living physically in `agent/src/tts/`

The asymmetry is a historical artefact:
- TTS runs text → audio; easy to implement as Node.js via SDKs
- STT runs audio → text; needs low-level OS audio capture → Rust plugin
  natural
- VRM avatar lip-sync (shell `@pixiv/three-vrm`) consumes **viseme** events
  that TTS emits → tight shell coupling for TTS output even though TTS
  lives in agent

## 4. Decision required

Phase 0 S6 asks: where does the voice pipeline live after migration?

### Option A — Full runtime ownership (naia-agent)
- Move TTS → `@naia-agent/tts` package
- Move STT → `@naia-agent/stt` package (would require rewriting Rust plugin to Node equivalent or WASM)
- **Cost**: high for STT (Rust → Node rewrite or IPC bridge)
- **Benefit**: symmetric, single runtime

### Option B — Full shell ownership
- Collapse TTS into shell (`tauri-plugin-tts` sibling to `tauri-plugin-stt`)
- **Cost**: rewrite TS TTS providers → Rust/Tauri plugin
- **Benefit**: native-only, low-latency
- **Loss**: agent cannot emit audio directly (must request host)

### Option C — 3-layer hybrid (current)
- Keep TTS in agent, STT in shell, `VoiceEvent` in `@naia-agent/types` as the shared contract
- Agent emits `audio_chunk` / `viseme`; shell renders
- Shell emits `transcript` back to agent
- **Cost**: zero migration (status quo)
- **Benefit**: pragmatic, matches current code
- **Loss**: no single owner; future features need two PRs

### Recommendation (from audit)

**Option C is the cheapest short-term path** and aligns with the
`VoiceEvent` contract already declared in migration plan A.6. The symmetry
argument for Option A is weak: STT's Rust plugin is nontrivially better
than a Node implementation for OS audio capture. Option B loses agent-side
audio emission capability.

## 5. Maintainer action — RESOLVED (2026-04-21)

Decision: **Option C — 3-layer hybrid**.

- [x] **Picked**: Option C.
  - TTS remains in agent (TS providers), STT remains in shell (Rust plugin).
  - `VoiceEvent` in `@naia-agent/types` is the shared contract across layers.
  - Agent emits `audio_chunk` / `viseme`, shell renders; shell emits `transcript` back to agent.
- [ ] `@naia-agent/types/src/voice.ts` — draft `VoiceEvent` interface (Phase 1 T5 scope).
- [ ] `@naia-agent/tts` package creation — Phase 2 X7. No early scaffold.
- [x] Recorded in migration plan v6 §A.6 (VoiceEvent ownership already present; S6 now marked resolved).

Phase 0 S6 **closed**. Phase 2 X7 (TTS extraction) can now be scheduled.

## References

- Migration plan: `alpha-adk/.agents/progress/naia-4repo-migration-plan.md` v6 §A.5 (VoiceEvent), §A.6 ownership table, §A.10 MVM, Phase 0 S6
- Prior context: `@naia-adk/.agents/context/harness.yaml` and naia-os `.agents/context/architecture.yaml` (TTS/STT design notes)
