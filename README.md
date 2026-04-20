[English](README.md) | [한국어](READMES/README.ko.md)

# naia-agent

**AI coding agent runtime.** Embeddable library + hosts — loop, tools, compaction, memory, LLM routing.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

> ⚠️ **Early development.** Public interface not yet stable. Expect breaking changes until v0.1.

## What is naia-agent?

`naia-agent` is the runtime engine of the Naia open-source AI platform. It is a **library** that a host (desktop app, CLI, server) embeds to provide an AI coding agent.

It is deliberately *not* a workspace format and *not* a storage system — those belong to companion projects.

```
Naia platform (four repos, one role each)

┌──────────────────────────────┐
│  naia-os                     │  Frontend — Tauri desktop shell, 3D avatar, OS image
└────────────┬─────────────────┘
             │ embeds
┌────────────▼─────────────────┐
│  naia-agent  ← you are here  │  Runtime — loop, tools, compaction, LLM
└──┬───────────────────────┬───┘
   │ reads                 │ reads/writes
┌──▼──────────┐       ┌────▼──────────┐
│  naia-adk   │       │ alpha-memory  │
│  workspace  │       │  storage      │
│  + skills   │       │  + sessions   │
└─────────────┘       └───────────────┘
```

| Repo | Role |
|------|------|
| [naia-os](https://github.com/nextain/naia-os) | Desktop shell, 3D avatar, OS image (Bazzite) |
| **naia-agent** (this) | Runtime engine — loop, tools, compaction, LLM routing |
| [naia-adk](https://github.com/nextain/naia-adk) | Workspace format + skills library |
| [alpha-memory](https://github.com/nextain/alpha-memory) | Long-term memory, session logs |

## Scope

**In scope:**

- Agent loop (read → decide → tool → observe → repeat)
- Tool execution and dispatch
- Context management and compaction
- Session memory (hot buffer)
- Skill loading and execution (consuming naia-adk skills)
- LLM client abstraction — providers plug in via adapter

**Out of scope:**

- Workspace format, directory structure, skill definitions → [naia-adk](https://github.com/nextain/naia-adk)
- Long-term memory, cross-session storage, cross-tool sharing → [alpha-memory](https://github.com/nextain/alpha-memory)
- LLM routing, fallback, auth, credits → external gateway (e.g. [any-llm](https://github.com/nextain/any-llm))
- UI, rendering, OS integration → hosts (e.g. [naia-os](https://github.com/nextain/naia-os))

## Architecture

`naia-agent` is deliberately layered so that runtime concerns (loop, tools) are separate from I/O concerns (network, UI).

```
[L1] Host               naia-shell / CLI / server
                        Process, I/O, DI                          ↑ embeds
─────────────────────────────────────────────────────────────────
[L2] Agent (this)       naia-agent
                        Loop · tools · compaction · memory (hot)  ↓ calls
─────────────────────────────────────────────────────────────────
[L3] LLM Client         LLMClient interface (+ adapters)
                        Concrete: Gateway / Direct / Mock         ↓ HTTP
─────────────────────────────────────────────────────────────────
[L4] Routing Gateway    any-llm or equivalent
                        Provider selection · fallback · auth      ↓
─────────────────────────────────────────────────────────────────
[L5] Providers          Anthropic / OpenAI / Google / local
```

The agent depends only on an injected `LLMClient` interface — it has no knowledge of which provider, which gateway, or which network protocol carries the call. Hosts inject the concrete client at startup.

## Who embeds naia-agent

`naia-agent` is designed to be embedded by multiple hosts:

- **[naia-os](https://github.com/nextain/naia-os)** — Tauri desktop app (flagship reference host)
- **CLI** — peer to `claude-code`, `opencode`, `codex`
- **HTTP server** — for remote / browser / mobile clients
- **Third-party apps** — anyone building an AI coding product

All hosts consume the same `naia-agent` runtime, so behavior is consistent regardless of surface.

## Status

- [x] Repo created
- [x] pnpm workspace scaffold (`packages/core`)
- [x] `LLMClient` interface stub
- [ ] Core loop skeleton
- [ ] Tool execution
- [ ] Compaction
- [ ] Skill loader (reads naia-adk workspace)
- [ ] Memory client (reads/writes alpha-memory)
- [ ] Reference host: embedded in naia-os
- [ ] CLI host
- [ ] v0.1 public interface freeze

## Development

```bash
pnpm install
pnpm build
```

Workspace layout:

```
naia-agent/
├── packages/
│   └── core/        # @naia-agent/core — loop, tools, compaction (WIP)
├── package.json     # pnpm workspace root
└── tsconfig.json    # TypeScript project references
```

See [Issues](https://github.com/nextain/naia-agent/issues) for early design discussion.

## Design Discussion

Why runtime is a separate repo (not in `naia-os` or `naia-adk`):

- **Not in `naia-os`** — `naia-os` is the frontend + OS distribution. Keeping the runtime separate lets other hosts (CLI, server, 3rd party apps) reuse the same engine.
- **Not in `naia-adk`** — `naia-adk` is a *workspace format*, analogous to a git repo or an npm package — static, portable, tool-agnostic. A runtime is fundamentally different (stateful, process-bound). Mixing them would conflate "what the agent works on" with "what runs the agent."
- **Not a fork of `claude-code`/`opencode`** — Those are full CLI products. `naia-agent` is a library designed to be embedded, not a standalone binary.

## License

Apache License 2.0. See [LICENSE](LICENSE).

```
Copyright 2026 Nextain Inc.
```

## Links

- **Naia OS** — [github.com/nextain/naia-os](https://github.com/nextain/naia-os)
- **Naia ADK** — [github.com/nextain/naia-adk](https://github.com/nextain/naia-adk)
- **Alpha Memory** — [github.com/nextain/alpha-memory](https://github.com/nextain/alpha-memory)
- **Nextain** — [nextain.io](https://nextain.io)
