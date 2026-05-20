[English](README.md) | [한국어](READMES/README.ko.md)

> User-facing docs mirror: [`.users/docs/`](.users/docs/) (multi-language). Engineering docs (English canonical) in [`docs/`](docs/).

# naia-agent

**AI coding agent runtime.** A library that hosts embed to get an AI coding agent — loop, tools, compaction, memory, LLM routing.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

> **v0.1.0 — Phase 1 freeze (2026-04-21).** Public contracts are additive-only from here. Breaking shape changes require MAJOR bump and 4-week advance notice (see [CHANGELOG.md](CHANGELOG.md)).

## Philosophy — Interfaces, not dependencies

`naia-agent` relates to its companion repos through **published interfaces**, not through runtime dependencies.

- **Transparent**: every interface is specified in `@nextain/agent-types`, documented, and versioned — open for anyone to read or implement.
- **Non-binding**: companion repos (`naia-adk`, `alpha-memory`, hosts) do **not** import `naia-agent`. They implement the contracts. `naia-agent` doesn't import them either — it receives concrete implementations via dependency injection.
- **Abstracted**: the runtime knows nothing about which LLM provider, which memory backend, or which skill source is in use. Swap any of them and nothing else changes.

This is Ports & Adapters (hexagonal) architecture applied at the ecosystem scale. Each repo is independently replaceable as long as it honors the contract.

```
                    defines contracts
 ┌──────────────────────────────────────────┐
 │   @nextain/agent-types (published, public)  │
 │   LLMClient · MemoryProvider ·           │
 │   SkillLoader · ToolExecutor · ...       │
 └───────┬─────────────────┬────────────────┘
         │ imports only    │ imports only
         │ types           │ types
 ┌───────▼──────┐    ┌─────▼──────────┐
 │ naia-adk     │    │ alpha-memory   │   implementations
 │ (Skill       │    │ (MemoryProvider│   (no runtime dep
 │  source)     │    │  impl)         │    on naia-agent)
 └──────────────┘    └────────────────┘

 ┌─────────────────────────────────────────────┐
 │ Host (naia-os, CLI, server, 3rd-party app)  │
 │ · constructs concrete implementations       │
 │ · injects them into naia-agent runtime      │
 └─────────────────────────────────────────────┘
```

## Roles in detail

### naia-os — Host (frontend + OS distribution)
- **What it is**: Tauri-based desktop app + Bazzite Linux OS image.
- **What it owns**: UI, 3D VRM avatar, user-facing settings, OS-level integration (file picker, notifications, OAuth stronghold), API-key storage, device identity, approval UI.
- **Relationship to naia-agent**: *Host* — constructs `LLMClient`, `MemoryProvider`, and other concrete implementations, injects them into `naia-agent` at startup.
- **Independence**: naia-agent can run without naia-os (e.g., inside a CLI or server host). naia-os can in theory swap to a different runtime as long as that runtime speaks the same stdio protocol.

### naia-agent — Runtime engine (this repo)
- **What it is**: Agent loop, tool dispatch, context management, compaction, skill execution.
- **What it owns**: the `@nextain/agent-types` contracts and a reference implementation that reads them.
- **Relationship to others**: *consumer of contracts* — calls out through interfaces only. Does not import `naia-adk` or `alpha-memory` runtime code. Does not know about providers, storage backends, or UIs directly.
- **Independence**: naia-agent runs anywhere Node.js runs. Its dependencies are the interfaces it publishes, nothing else.

### naia-adk — Workspace format standard
- **What it is**: a tool-agnostic workspace format (directory layout, context files, skill definitions). Read by any AI coding tool — Claude Code, OpenCode, Codex, naia-agent, future tools.
- **What it owns**: `.agents/`/`.users/` directory conventions, `agents-rules.json` schema, SKILL.md format, fork chain (`naia-adk` → `naia-business-adk` → `{org}-adk` → `{user}-adk`).
- **Relationship to naia-agent**: *format consumed*. naia-agent loads skills by reading the naia-adk format. naia-adk does not depend on naia-agent.
- **Independence**: you can use naia-adk with Claude Code only, OpenCode only, or any mix — no runtime commitment.

### alpha-memory — Memory implementation
- **What it is**: a memory system (episodic, semantic, procedural) with importance filtering, knowledge graph extraction, and time-based decay.
- **What it owns**: its own storage schema, 4-store architecture, pluggable vector backends.
- **Relationship to naia-agent**: *one implementation of `MemoryProvider`*. naia-agent treats it as a black box behind the interface. Another memory system could replace it by implementing the same interface.
- **Independence**: alpha-memory is published as `@nextain/naia-memory` and can be used by anything, not just naia-agent.

## Architecture (runtime layering)

Runtime concerns (loop, tools) are separated from I/O concerns (network, UI) by layer:

```
[L1] Host               naia-os / CLI / server
                        Process, I/O, dependency injection           ↑ embeds
─────────────────────────────────────────────────────────────────────
[L2] Agent (this repo)  naia-agent
                        Loop · tools · compaction · hot memory        ↓ calls
─────────────────────────────────────────────────────────────────────
[L3] LLM Client         LLMClient interface (+ adapters)
                        Concrete: Gateway / Direct / Mock             ↓ HTTP
─────────────────────────────────────────────────────────────────────
[L4] Routing Gateway    any-llm or equivalent
                        Provider selection · fallback · auth          ↓
─────────────────────────────────────────────────────────────────────
[L5] Providers          Anthropic / OpenAI / Google / local models
```

The agent depends only on the injected `LLMClient` interface — it has no knowledge of which provider, which gateway, or which network protocol carries the call.

## Published interfaces (`@nextain/agent-types`)

Every contract lives in a single zero-runtime package. Anyone can implement:

### `LLMClient`
The only way `naia-agent` talks to language models. Implementations wrap providers directly (Anthropic/OpenAI/…), a gateway (any-llm), or a mock (tests). Streams, tool-calls, and prompt caching are all part of the contract.

### `MemoryProvider`
Long-term memory and session logs. `alpha-memory` is the reference implementation. Others can implement the same interface — local JSON, SQLite, remote vector DBs, custom stores.

### `SkillLoader`
Reads skill definitions from a workspace (naia-adk format today, extensible to others). Produces `SkillDescriptor` objects the runtime can dispatch.

### `ToolExecutor`
Runs individual tool calls (file I/O, command exec, network, MCP proxies). Implementations enforce tier policies (T0–T3) and approval flows.

### Domain types
`Session`, `Conversation`, `Message`, `ToolCall`, `ToolResult`, `Event`, `CompactionPolicy`, `TokenBudget`, `TierLevel`, `ApprovalRequest`. Stable across implementations.

All contracts are published open-source. No hidden extension points, no private ABIs.

## Who embeds naia-agent

- **[naia-os](https://github.com/nextain/naia-os)** — Tauri desktop app (flagship reference host)
- **CLI** — peer to `claude-code`, `opencode`, `codex`
- **HTTP server** — for remote / browser / mobile clients
- **Third-party apps** — anyone building an AI coding product

All hosts consume the same `naia-agent` runtime, so behavior is consistent regardless of surface.

## Status — v0.1.0 (Phase 1 freeze)

**Published contracts** (additive-only from here):

- [x] `@nextain/agent-types` 0.1.0 — LLMClient / MemoryProvider / ToolExecutor / ApprovalBroker / HostContext / Event / ErrorEvent / VoiceEvent / Logger / Tracer / Meter / TierLevel / SessionLifecycle
- [x] `@nextain/agent-protocol` 0.1.0 — StdioFrame wire format
- [x] `@naia-adk/skill-spec` 0.1.0 — SkillDescriptor / SkillLoader (in naia-adk repo)
- [x] `@nextain/agent-providers` 0.1.0 — AnthropicClient
- [x] `@nextain/agent-observability` 0.1.0 — ConsoleLogger / NoopTracer / InMemoryMeter
- [x] `@nextain/agent-core` 0.1.0 — contracts re-export (runtime loop WIP)

**Phase 2 (next)**:

- [ ] Core loop skeleton (Strangler Fig X3)
- [ ] Tool execution runtime (X2)
- [ ] Compaction
- [ ] Skill loader (reads naia-adk workspace) (X4)
- [ ] MCP bridge (X4, continuation of #200)
- [ ] stdio protocol flip-day (X5)
- [ ] Reference host: embedded in naia-os (X1 providers already available)
- [ ] CLI host
- [ ] Messengers (X8)

## CLI usage (Slice 3-XR-E/F/G — Task #3)

`naia-agent` ships an opinionated CLI for direct, host-less use. Three commands cover the everyday path:

```bash
# 1) configure (no plaintext key on disk — OS keychain via libsecret)
pnpm naia-agent login --adk <naia-adk-path> \
  --main "openai-compat|http://127.0.0.1:11434/v1|gemma4:31b"

# 2) inspect (never echoes secret values — only the apiKeyRef NAME)
pnpm naia-agent show

# 3) chat
pnpm naia-agent --no-tools "한국어로 한 문장만 인사해줘"
```

Flags that matter:

| Flag | Effect |
|---|---|
| `--no-tools` | Disable tool-calling (for models without native function-calling, e.g. `gemma3n:e4b`). |
| `--enable-file-ops` | Register `read_file` / `write_file` / `edit_file` / `list_files` skills alongside `bash` (Slice 3-XR-I). |
| `--skills-dir <path>` | Load external ADK skills via FileSkillLoader (naia-adk / onmam-adk top-level `skills/`). CompositeToolExecutor merges with bash + file-ops (Slice 3-XR-J). |
| `--system "<text>"` | Inject a persona system rider (used by `naia-os` ChatPanel + naia-os shell integrations). |
| `--no-default-system` | Omit the built-in `DEFAULT_SYSTEM_PROMPT` (helpful for small models, #41 v2). |
| `--memory` | Persistent `LiteMemoryProvider` (SQLite `lite_facts` + `<recall>` marker protocol). |
| `--repl` | Force REPL mode even when stdin is piped (default: piped stdin = single-shot). Useful for shell pipelines feeding multiple prompts (Slice 3-XR-M). |
| `--service <manifest>` | Service-mode (manifest-driven LLM + memory + persona). Supports backends: `openai-compatible` / `anthropic` / `vertex` / `claude-code` (Claude Code subscription, no API key) / `langgraph` (reserved stub) / `rag-retriever` (reserved stub). |

User guide: [docs/user-guide.md](docs/user-guide.md). LLM configuration standard: [docs/llm-config-standard.md](docs/llm-config-standard.md).

## Evaluation & benchmarks

`naia-agent` ships its own black-box scenario harness + 3-judge ensemble — the same harness gates Ralph-loop convergence (`2-consecutive PASS`) before any push.

| Surface | File | Status |
|---|---|---|
| Unit (user-perspective, CLI flag mechanics) | `packages/cli-app/src/__tests__/bin-user-scenarios.test.ts` | **22 active + 2 honest skips** (Slice 3-XR-F) |
| Integration (ADK ecosystem, LLM-as-judge, Groups A-O+P+K) | `packages/cli-app/src/__tests__/integration-scenarios.test.ts` | **53+ active** (Slice 3-XR-G/I/J/L/M/N/O) |
| Pi-based coding LIVE (native tool-calling) | Group P | **6 scenarios** (Slice 3-XR-I) |
| naia-adk full-set live invocation | Group D | **6 scenarios** (Slice 3-XR-J — 3 LIVE + 3 mechanism, 19/19 system skills) |
| onmam-adk domain skills | Group G | **3 active + 1 honest defer** (Slice 3-XR-L — 10 skills incl. wp-archive) |
| multi-turn REPL + Claude Code routing | Group M | **2 scenarios** (Slice 3-XR-M — `--repl` + DRYRUN) |
| cross-OS sanity (Linux side) | Group N | **5 active + 1 honest defer** (Slice 3-XR-N) |
| Claude Code parity ledger | Group O | **7 mechanism + intentional-difference ledger** (Slice 3-XR-O) |
| 3-judge ensemble harness (GLM + Claude CLI + Codex CLI) | `packages/cli-app/src/__tests__/lib/llm-judge.ts` | A1/A4/F2 wired (Slice 3-XR-H, `NAIA_JUDGE_ENSEMBLE=1` opt-in) |
| Tiered conversational recall bench (#41 v2) | `examples/conversational-recall-bench.ts` | judge + harness, per-tier (8G / 24G / 48G) recall scoring |
| Tier comparison report | `.agents/progress/tier-8g-vs-24g-comparison-2026-05-20.md` | 8G `gemma3n:e4b` vs 24G `gemma4:31b` |
| Cross-OS compat sanity report | `.agents/progress/cross-os-compat-results-2026-05-20.json` | 4/5 PASS (Linux side) |

Groups covered (integration):

- **A** 24G live (`gemma4:31b`, thinking-mode suppressed via `Answer directly` + `max_tokens≥300`)
- **B** coding behaviour (prompt-level read/explain, bug-spot, refactor)
- **C** tool-calling / pi loop
- **D** naia-adk skills full-set live (`--skills-dir`)
- **E** business-adk reserve (LangGraph / RAG backend stub graceful)
- **F** naia-os persona injection (`--system`)
- **G** onmam-adk domain (+ wp-archive)
- **H** error handling
- **I** security secret-shape rejection
- **K** model comparison (e4b vs 31b)
- **M** multi-turn REPL + Claude Code subscription routing
- **N** cross-OS sanity
- **O** Claude Code harness parity ledger
- **P** pi-based coding LIVE (write/read/edit/list/bash + composite)

Reports: `.agents/progress/integration-scenarios-{design,report,results}-2026-05-20.{md,json}`. CHANGELOG `[Slice 3-XR-*]` entries.

## Running benchmarks + scenarios yourself

```bash
# Full suite (unit + integration; single-GLM judge for A1/A4/F2)
pnpm test                                                       # all packages
pnpm --filter @nextain/agent-cli-app exec vitest run            # cli-app only

# By scenario group
pnpm --filter @nextain/agent-cli-app exec vitest run -t "Group P"   # pi-coding LIVE
pnpm --filter @nextain/agent-cli-app exec vitest run -t "Group D"   # naia-adk skills
pnpm --filter @nextain/agent-cli-app exec vitest run -t "Group G"   # onmam-adk
pnpm --filter @nextain/agent-cli-app exec vitest run -t "Group M"   # REPL + Claude Code
pnpm --filter @nextain/agent-cli-app exec vitest run -t "Group N"   # cross-OS sanity
pnpm --filter @nextain/agent-cli-app exec vitest run -t "Group O"   # parity ledger

# 3-judge ensemble (GLM HTTP + Claude CLI + Codex CLI) — consumes credits!
#   GLM_API_KEY required + claude/codex CLIs installed.
NAIA_JUDGE_ENSEMBLE=1 \
  pnpm --filter @nextain/agent-cli-app exec vitest run -t "A1|A4|F2"

# Claude Code subscription LIVE (consumes subscription credit)
NAIA_AGENT_CLAUDECODE_LIVE=1 \
  pnpm --filter @nextain/agent-cli-app exec vitest run -t "M2"

# Tiered recall bench (#41 v2 — small-LLM "tiered" recall)
pnpm exec tsx examples/conversational-recall-bench.ts --help
```

Result files (machine-readable + human reports):

- `.agents/progress/integration-scenarios-results-2026-05-20.json` — per-scenario verdict + judge breakdown + observed tail
- `.agents/progress/integration-scenarios-report-2026-05-20.md` — prose summary
- `.agents/progress/integration-scenarios-design-2026-05-20.md` — FINAL v3 design (after 2 GLM cross-review rounds)
- `.agents/progress/cross-review-glm-2026-05-20.json` — GLM-judge design review
- `.agents/progress/tier-8g-vs-24g-comparison-2026-05-20.md` — measured tier comparison
- `.agents/progress/cross-os-compat-{sanity,results}-2026-05-20.{md,json}` — cross-OS sanity (4/5 PASS)
- `.agents/progress/slice-3-xr-h-i-j-l-plan-2026-05-20.md` — slice sequence + Voice P0c-1/P0c-2 split

Honest limitations:

- 3-judge ensemble wired on **only 3 scenarios** (A1/A4/F2 — high-judgment). The other 50+ use single-GLM (cost-bounded).
- LIVE scenarios assume `gemma3n:e4b` (8G) and `gemma4:31b` (24G) reachable at `http://127.0.0.1:11434` via ollama. Without them, those tests honestly skip (recorded in the results JSON).
- `claude` / `codex` CLIs need to be installed for the ensemble path; missing CLIs are recorded as `infra_error` (not real-fail) per `lib/llm-judge.ts`.
- Multi-provider ensemble was a user-correction after the initial Slice 3-XR-G shipped with single-GLM (see `feedback_pi_substrate_not_glm_only_2026_05_20`).

## Development

```bash
pnpm install
pnpm build
```

Workspace layout:

```
naia-agent/
├── packages/
│   ├── types/          # @nextain/agent-types — contracts
│   ├── protocol/       # @nextain/agent-protocol — wire format
│   ├── core/           # @nextain/agent-core — runtime scaffold
│   ├── providers/      # @nextain/agent-providers — AnthropicClient
│   └── observability/  # @nextain/agent-observability — defaults
├── scripts/smoke-anthropic.ts
├── package.json        # pnpm workspace root
└── tsconfig.json       # TypeScript project references
```

See [Issues](https://github.com/nextain/naia-agent/issues) for early design discussion.

## Why a separate repo

- **Not in `naia-os`** — `naia-os` is frontend + OS distribution. A separate runtime lets other hosts (CLI, server, 3rd-party apps) reuse the same engine.
- **Not in `naia-adk`** — `naia-adk` is a *workspace format*, analogous to a git repo or an npm package: static, portable, tool-agnostic. A runtime is the opposite: stateful, process-bound. Mixing them conflates "what the agent works on" with "what runs the agent."
- **Not a fork of `claude-code`/`opencode`** — those are full CLI products. `naia-agent` is a library designed to be embedded, not a standalone binary.

## License

Apache License 2.0. See [LICENSE](LICENSE).

```
Copyright 2026 Nextain Inc.
```

## Links

- **Naia OS** — [github.com/nextain/naia-os](https://github.com/nextain/naia-os)
- **Naia ADK** — [github.com/nextain/naia-adk](https://github.com/nextain/naia-adk)
- **Naia Memory** (legacy: Alpha Memory) — [github.com/nextain/alpha-memory](https://github.com/nextain/alpha-memory)
- **Nextain** — [nextain.io](https://nextain.io)
