[English](README.md) | [한국어](READMES/README.ko.md)

> User-facing docs mirror: [`.users/docs/`](.users/docs/) (multi-language). Engineering docs (English canonical) live in [`docs/`](docs/). Contributing guide: [CONTRIBUTING.md](CONTRIBUTING.md).

# naia-agent

`naia-agent` is a replaceable runtime engine for AI agents. It owns the parts that make an agent an agent — the conversation loop, memory recall and encoding, token-budget management, and tool dispatch — while the pieces that vary from product to product (which language model, which memory store, which screen the user sees) are all handed in from the outside.

A useful mental model is a game engine. A game engine runs the loop, physics, and asset pipeline; you supply the art, the levels, and the input device. `naia-agent` runs the agent loop; you supply the LLM client, the memory backend, and the host UI. Swap any one of them and the loop keeps working unchanged.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## What it does

Every turn follows the same shape, driven by the `Agent` class in [`packages/core/src/agent.ts`](packages/core/src/agent.ts):

**Recall, then answer, then remember.** When a user message arrives, the agent first asks the injected memory provider for relevant context and folds the top hits into the system prompt. It runs the tool loop to produce an answer, then encodes both the user message and the reply back into memory so the next turn can recall them. The memory store itself is external — the agent only knows the `MemoryProvider` interface, never which database is behind it.

**Tool loop with tiers and approval.** The model can call tools; the agent executes each call, feeds the result back, and lets the model decide what to do next, up to a hop limit. Every tool carries a tier (T0–T3) so a host can require human approval before anything risky runs. If tools keep failing, the agent halts the turn instead of burning the whole hop budget.

**Compaction when the context gets too big.** Before each model call the agent estimates the request size. If it crosses the token budget and the memory provider supports it, the agent asks memory to summarize the older turns and splices that summary back into the history — always cutting on a turn boundary so tool calls never get orphaned. If the budget is still near the limit after compaction, the agent can export a handoff blob so a fresh session can pick up where this one left off.

**`<recall>` re-recall marker.** Small local models often can't emit a native tool call to ask for more memory. So the agent also watches the model's plain text for a `<recall>query</recall>` marker: when it sees one, it runs another recall and lets the model try again (depth-guarded so it can't loop on itself). Any stray marker residue is scrubbed from the final answer.

**Skills from a workspace, and an MCP bridge.** The agent loads skill definitions from a skills directory (`--skills-dir`) — the path you point it at is the skills root itself, holding one `<name>/SKILL.md` per skill, as in `naia-adk/skills/`. It can also bridge external tools spoken over the Model Context Protocol (MCP). One shipped example is a bridge to the external [`codegraph`](https://github.com/colbymchenry/codegraph) binary for code intelligence, enabled with `--enable-codegraph`; if the binary or its index is missing, the agent skips it and continues.

A note on retrieval, since it is easy to overstate: **naia-agent ships no built-in retrieval-augmented generation (RAG) retriever.** What exists is (a) the MCP bridge to the external `codegraph` binary described above, and (b) a `rag-retriever` service backend that is a reserved stub returning `null` today. Treat retrieval as a plug-in point, not a finished feature.

## Why it is built this way

The whole design is Ports and Adapters (hexagonal architecture) applied at the scale of separate repositories, not just separate files. The contracts live in one zero-dependency package, `@nextain/agent-types`. Everything else — the LLM provider, the memory system, the host application — implements a contract and gets injected in. None of the companion repos import `naia-agent`, and the core runtime imports none of them; it speaks only through the contracts. (The one deliberate exception is the bundled command-line host, covered below.) Each side can be replaced as long as it honors the interface.

That boundary is what makes the runtime portable and privacy-respecting. A host can wire in a cloud LLM or a local model on the same machine; it can point memory at an in-process SQLite file that never leaves the device, or at a remote vector store. The engine does not know or care. In the Naia ecosystem this is the point: the model itself is a commodity, and the durable value lives in the agent layer — memory, context, tool policy, and the loop that ties them together.

```
                    defines contracts
 ┌──────────────────────────────────────────────┐
 │   @nextain/agent-types  (published, public)   │
 │   LLMClient · MemoryProvider ·                │
 │   ToolExecutor · SkillLoader · ...            │
 └───────┬──────────────────────┬───────────────┘
         │ implements            │ implements
 ┌───────▼──────┐        ┌───────▼─────────┐
 │ naia-adk     │        │ naia-memory     │   (no runtime
 │ (skill       │        │ (MemoryProvider │    dependency on
 │  format)     │        │  reference)     │    naia-agent)
 └──────────────┘        └─────────────────┘

 ┌──────────────────────────────────────────────┐
 │ Host: naia-os · CLI · server · 3rd-party app  │
 │  constructs the concrete implementations and  │
 │  injects them into the naia-agent runtime     │
 └──────────────────────────────────────────────┘
```

The four repositories divide up cleanly. **naia-os** is the flagship host — a Tauri desktop app that owns the UI, the 3D avatar, API-key storage, and the approval screen; it constructs the implementations and injects them. **naia-agent** (this repo) is the runtime engine and the source of truth for the published contracts. **naia-adk** is a tool-agnostic workspace format (directory layout, context files, skill definitions) that any AI coding tool can read. **naia-memory** is the reference `MemoryProvider` — an episodic/semantic/procedural memory system with importance filtering and time-based decay. Today it is consumed as a workspace-local link (`file:../naia-memory` in `package.json`, imported straight from source); a standalone `@nextain/naia-memory` registry release is planned but not yet cut. Older docs may still call it *alpha-memory*.

One subtlety worth stating plainly: the **core runtime never imports naia-memory** — it only speaks the `MemoryProvider` interface. The **bundled CLI** in [`bin/naia-agent.ts`](bin/naia-agent.ts) is the exception: it imports `@nextain/naia-memory` directly so that `pnpm naia-agent --memory` works out of the box without a host wiring memory in by hand.

## Repository layout

The runtime is a pnpm workspace of sixteen packages. The ones you meet first:

- `packages/types` — `@nextain/agent-types`, the zero-runtime-dependency contracts (LLMClient, MemoryProvider, ToolExecutor, SkillLoader, Session, Event, and friends). Everything else depends on this.
- `packages/core` — `@nextain/agent-core`, the `Agent` class: the loop, recall/encode, compaction, handoff, and the tool-hop machinery. This is the heart of the repo.
- `packages/runtime` — `@nextain/agent-runtime`, the batteries: in-memory and mock implementations, tool executors, the skill loader, the MCP client, the codegraph bridge, and CLI helpers.
- `packages/cli-app` — `@nextain/agent-cli-app`, the REPL (read-eval-print loop) and command wiring behind the `naia-agent` binary.
- `bin/naia-agent.ts` — the host-less command-line entry point that ties `core` + `runtime` + `providers` together and can import `naia-memory` for persistence.

The rest fill in around those: `protocol` (the host↔agent wire format), `providers` (LLM clients — a Vercel-AI-SDK-backed client covering many providers, plus the Naia Lab gateway), `observability` (default Logger/Tracer/Meter), `naia-agent` (an aggregated bundle package), `testing` (fixture-replay harness), `benchmarks`, `verification`, `workspace`, and four sub-agent `adapter-*` packages (pi, shell, and two opencode adapters). The clearest way to see the engine in motion is [`examples/minimal-host.ts`](examples/minimal-host.ts), which runs a full two-turn conversation with a tool call using nothing but in-process mocks — no network, no keys.

## Getting started

```bash
pnpm install
pnpm build
```

To use the CLI directly, save a provider key and start chatting. `login` hands the secret to your operating system keychain (libsecret on Linux, Keychain on macOS, DPAPI on Windows) and records only the key *name*, never the value — nothing secret is written to a plaintext file and nothing secret is printed:

```bash
# save a key (accepts: anthropic | openai | glm | vllm | ollama | claude-code)
pnpm naia-agent login --key anthropic

# single-shot
pnpm naia-agent "Explain what a tool-hop loop is, in two sentences."

# persistent memory across the session (recall + <recall> marker protocol)
pnpm naia-agent --memory "Remember that my project is called Nirvana."

# load skills from an ADK skills directory, with file operations enabled
pnpm naia-agent --enable-file-ops --skills-dir path/to/naia-adk/skills "..."
```

Anthropic on Vertex AI is a separate case: there is no key to store, so it is not a `login` provider. Instead the CLI reads the `VERTEX_PROJECT_ID` and `VERTEX_REGION` environment variables from the host and routes to Vertex automatically.

Useful flags: `--no-tools` (disable tool calling, for models without native function calling), `--enable-codegraph [path]` (bridge the external codegraph binary if present), `--system "..."` (inject a persona), `--service <manifest>` (manifest-driven LLM + memory + persona), and `--repl` (force interactive mode). The full user guide is [docs/user-guide.md](docs/user-guide.md); the LLM configuration standard is [docs/llm-config-standard.md](docs/llm-config-standard.md).

Where to read first, in order: [`packages/core/src/agent.ts`](packages/core/src/agent.ts) for the loop, then [`packages/types/src/memory.ts`](packages/types/src/memory.ts) for the memory contract the loop depends on, then [`bin/naia-agent.ts`](bin/naia-agent.ts) to see a real host wire everything together, and finally [`examples/minimal-host.ts`](examples/minimal-host.ts) to run it end to end. Contribution conventions are in [CONTRIBUTING.md](CONTRIBUTING.md).

Run the tests and smoke examples:

```bash
pnpm test                    # all packages
pnpm smoke:agent             # examples/minimal-host.ts (mock, no network)
pnpm smoke:naia-memory       # examples/naia-memory-host.ts (SQLite persistence)
```

## Contract stability

Phase 1 froze the public contracts (`@nextain/agent-types` and the wire protocol) on 2026-04-21: additive changes only, breaking shape changes require a MAJOR bump and four weeks' notice. Phase 2 — the runtime itself: the core loop, tool-execution runtime, compaction, skill loader, MCP bridge, and CLI host — is implemented and shipping (see [CHANGELOG.md](CHANGELOG.md), Slices 3-XR-* and #68).

## Roadmap

A few surfaces are deliberately stubbed and gated on demand:

- **`langgraph` and `rag-retriever` service backends** are reserved: the manifest enum accepts them and the CLI degrades gracefully, but the live implementations are deferred.
- **Voice pipeline** integration is owned by naia-os / naia-omni. `naia-agent` stays the LLM brain and does not embed audio hardware, streaming protocols, or voice-service internals.
- **opencode ACP adapter** is a Phase 2 item; the Phase 1 path wraps `opencode run --format json`.

## Why a separate repo

`naia-agent` is not part of naia-os because a standalone runtime lets other hosts — a CLI, a server, third-party apps — reuse the same engine. It is not part of naia-adk because that is a static, portable *workspace format*, while a runtime is stateful and process-bound; mixing them would conflate "what the agent works on" with "what runs the agent." And it is not a fork of `claude-code` or `opencode`, which are full CLI products — `naia-agent` is a library designed to be embedded.

## License

Apache License 2.0. See [LICENSE](LICENSE).

```
Copyright 2026 Nextain Inc.
```

## Links

- **Naia OS** — [github.com/nextain/naia-os](https://github.com/nextain/naia-os)
- **Naia ADK** — [github.com/nextain/naia-adk](https://github.com/nextain/naia-adk)
- **Naia Memory** — [github.com/nextain/naia-memory](https://github.com/nextain/naia-memory)
- **Nextain** — [nextain.io](https://nextain.io)
