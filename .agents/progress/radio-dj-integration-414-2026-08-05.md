# Radio DJ Agent integration #414

## Scope

- Send every Agent-owned BGM play with `mode=radio_dj` and consume Shell-owned bounded recent/favorite context.
- Continue an observed track end as one transition remark, a fresh dynamic selection, and a correlated observed `playing` receipt.
- Recall only tagged, user-authored explicit DJ preferences from naia-memory, with the workspace-local exact index and tombstones remaining authoritative.
- Carry bounded PNG/JPEG/WebP panel screenshots as provider-native multimodal input without retaining the base64 payload as tool text.

## Verification

- Focused Agent contract/integration run: 10 files, 112 tests passed. The run covered the changed Radio controller, Shell panel adapter, preference/memory acceptance, panel screenshot parser, and OpenAI-compatible, Anthropic, and Ollama image mappings.
- `pnpm build`: passed.
- Pre-commit compile-integrity and standard-logging gates: passed.
- Full Agent run: 1,434 passed, 10 skipped, 12 failed. The remaining failures were reproduced outside this change boundary and are environment/baseline failures in unavailable KB compiler dist imports, external-state memory reload, the current CLI credential fixture, and one CLI timeout; no completion claim uses that run as a green gate.

Shell-side paired and long-running evidence is recorded in the `nextain/naia-shell` #414 worktree and issue handoff. The Shell music-surface capture producer is not part of this Agent change; this change only makes a valid panel image actually reach supported multimodal providers.
