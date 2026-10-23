**English** | [한국어](README.ko.md)

# naia-agent

**In one line**: a background worker that takes the work you hand it, assigns it to several AIs (coding AIs and
chat models), supervises them, and gets it done for you. When it finishes, it reports an **honest result** such as
"changed a few files; tests passed/failed".

For example, when the naia-shell desktop app sends "fix this bug", naia-agent launches (spawns) a suitable coding AI
program, gives it the task, watches the workspace for changes, then runs test/lint/build and answers with
**unvarnished numbers**.

> It is the **headless (no-screen) processing engine** that naia-shell launches behind the scenes, and also a
> first-class CLI that users can run directly from a terminal. If you hit an unfamiliar term → [Glossary](docs/glossary.md) (Korean).

<details>
<summary>Technical summary (for developers)</summary>

The "brain" runtime and sub-agent orchestrator of the naia ecosystem. When the shell (naia-shell) sends a message, the
agent assembles the conversation, calls the LLM provider, runs tools, and streams the response. Beyond that, it
**spawns and supervises external coding agents** (pi · opencode · claude-code, etc.) **as sub-agents**, observes
workspace changes, and verifies them (test/lint/build) to produce an **honest numeric report**. It is an orchestrator
client (internal codename "Hermes") that connects external and local LLMs from the terminal, and an agent that works
together with the naia-shell workspace and naia-adk. Its core is a clean rebuild on a hexagonal architecture.
</details>

---

## What is naia-agent?

naia-agent is a **headless (GUI-less) processing runtime responsible for LLM conversations and tool execution**.
A host (such as the naia-shell desktop shell) can use it over gRPC, or a user can manage accounts, settings, models,
diagnostics, and sessions from the `naia-agent` CLI and run Pi coding tasks directly.

The flow of one conversation turn:

```
user input ─(gRPC)→ naia-agent
                       │  1. recall   — (optional) recall relevant context from long-term memory
                       │  2. assemble — assemble the conversation within the token budget (compaction)
                       │  3. provider — call the LLM, stream text and tool calls
                       │  4. tool-loop— run tools → pass results back to the LLM
                       │  5. save     — (optional) save this turn to long-term memory
                       └─(gRPC stream)→ the shell displays it
```

The host **does not need to know "which provider it is or which tools exist."** It just sends messages, and the
agent handles them according to the settings it loaded at startup (naia-settings from naia-adk).

---

## What it does (capabilities · status)

> The table below is a **status tracker for maintainers**. If you are new, you can skim only the "✅" rows (things that already work) and move on.
> The status symbols (✅ · 🔌 awaiting wiring · 🔜 dormant, etc.) are explained below the table.

| Capability | Description | Status |
|------|------|:----:|
| **Chat pipeline** | Provider call → wire stream (text · thinking · usage). Multiple providers: ollama, OpenAI-compatible, gateway, etc. | ✅ |
| **Tool execution loop** | `toolUse → execute → thread results → final response`. Multi-round | ✅ |
| **agent-local skills** | github · obsidian · memo · weather (openmeteo) · MCP bridge · composite · approval gate (tier ask) · notify (slack/discord/google_chat) · adk-skills (SKILL.md) — wired into the entry point | ✅ |
| **cron (scheduling) skill** | schedule/list/cancel adapter and contract tests exist. **Not wired into the entry point (dormant)** — **owned by the agent** (the agent injects the scheduler itself); to be wired once a shell notify path for triggers is added. Ownership settled = agent (details: `.agents/progress/naia-agent-skill-role-reassignment-2026-06-29.md` GAP-1) | 🔜 dormant |
| **Provider source · credentials** | Provider and key resolution based on naia-settings/keychain, live reload (switch models without restarting the app), keys kept in the OS keychain (never stored in plain text) | ✅ |
| **Diagnostics RPC** | Reports rich provider/connection/status health over gRPC | ✅ |
| **Browser skill** | cmd whitelist + injected CLI (navigate/click/fill) adapter and contract tests exist. **Not wired into the entry point (dormant)** — **host-dependent**: CLI host = simple spawn that opens an external browser (`xdg-open`/`start`) / desktop (naia-shell) = owned by the shell sidecar. Ownership settled (details: `naia-agent-skill-role-reassignment-2026-06-29.md` GAP-2) | 🔜 dormant |
| **BGM · proactive speech** | The general youtube BGM skill adapter is still dormant as a standalone entry point. However, the opt-in `personal_radio_dj` profile actually plays through a narrow shell BGM port, and `exhibition_intro` starts the introduction of a designated KB first. `docs/requirements.md` separates the contract-test scope from the real Tauri verification scope. | ✅ profile slice / 🔜 general skill |
| **Conversation token-budget guard** | Assembles long conversations within the provider's context budget (newest first · oldest **dropped** · tool rounds kept atomic · systemPrompt preserved). ⚠️ Information-preserving compaction (summarization) is naia-memory's responsibility — delegation from the agent is planned (agent#3) | ✅ (guard) |
| **Long-term memory · RAG integration** | `@nextain/naia-memory` recall/save wired — default-on at the entry point (disable with `NAIA_AGENT_MEMORY=off`), FR-MEM-1–11 contract tests pass (`docs/requirements.md`). Maturity of the real backend (remote/qdrant/embedding quality) is naia-memory's responsibility | ✅ |
| **Sub-agent orchestration** | Spawns external coding agents (pi · opencode-cli + roster; claude-code/codex/gemini declared) through `SubAgentPort` → forwards the event stream + interrupts (SIGTERM → grace period → SIGKILL). A supervisor oversees a single task. **Runnable as a standalone CLI (`naia-agent run`)** — wiring into the naia-shell gRPC host comes later (②) | ✅ CLI |
| **Honest reporting (workspace+verify)** | `WorkspacePort` (git change summary) + `VerifierPort` (test/lint/build runner, never-throws) → verifies after session_end and produces a numeric report of filesChanged/verification results + exit code (0/2/3). Run from the standalone CLI (↑) | ✅ CLI |
| **Reference hosts** | **Standalone CLI host** (✅ `bin/naia-agent-run.mjs`, S2 supervisor mode) · integration with naia-shell's agent spawn/stdio entry (✅) · naia-shell gRPC orchestration wiring (②, after naia-shell workspace work) · messenger bot | 🔜 partly planned |

> ✅ = implemented on main + contract tests pass + **wired into the entry point (`scripts/builds/agent-stdio-entry.mjs`)** (the host actually calls it).
> ✅ CLI = **runnable now from the standalone CLI (`naia-agent run`)** (see "Quick start › Standalone CLI" below). Core + composition + contract tests + e2e done. naia-shell gRPC host wiring (②) comes after naia-shell workspace work.
> 🔜 dormant = adapter and contract tests exist but not wired into the entry point (by design the environment is owned by the shell sidecar, or the external store is not injected).
> 🔜 partly planned = designed, some code exists, integration in progress.
> For precise tracking see `docs/progress/` (V-model registry) and `docs/requirements.md`.

---

## Place in the ecosystem

naia-agent is the **processing layer** of the Naia Visual Agent stack, where five repos interlock: naia-shell, naia-agent, naia-memory, naia-kb-compiler, and naia-adk. The surface users meet is naia-shell; behind it, naia-agent handles provider calls, tool execution, and supervision of sub-agents.

```
┌───────────────┐   gRPC    ┌───────────────┐  recall/save  ┌────────────────┐
│  naia-shell   │ ────────▶ │  naia-agent   │ ────────────▶ │  naia-memory   │
│ (visual shell)│ ◀──────── │  (this repo)  │ ◀──────────── │(cognitive mem.)│
│UI/voice/avatar│  stream   │     brain     │               │long-term/recall│
└───────────────┘           └───┬───────┬───┘               └────────────────┘
                                │       │ search/ask  ┌──────────────────┐
          loads settings/skills │       └────────────▶│ naia-kb-compiler │
                                ▼                     │ (KB compilation) │
                        ┌───────────────┐             └──────────────────┘
                        │   naia-adk    │
                        │  (workspace)  │  provider/model/skill settings SoT
                        └───────────────┘
```

| Repo | Responsibility (boundary) |
|------|------------|
| **naia-shell** | The shell users see. It spawns the agent and exchanges conversation with it over gRPC. Renders UI, voice, and avatar. |
| **naia-os** | The distribution/ISO layer based on Bazzite/titanoboa that packages the naia-shell stack. |
| **naia-agent** (this repo) | **The brain.** Provider calls · tool execution · conversation assembly (recall→assemble→provider→tool-loop→save). |
| **naia-memory** | **Long-term memory** (who — push). The agent integrates via recall/save. Injected automatically every turn. |
| **naia-kb-compiler** | **Knowledge** (what — pull). Compiles source material offline and deterministically (`kb.json`) + search/Q&A. The agent injects it through the `KnowledgeBackend` port and exposes it as the `skill_knowledge_search`/`ask` tools. |
| **naia-adk** | The workspace where provider, model, and **skill settings** live. The agent loads it at startup (`naia-settings/`). |

> Memory (push · WHO) and knowledge (pull · WHAT) have **separate storage and injection paths** (they are not mixed).
> Details = `docs/user-scenarios.md` UC-KNOWLEDGE.

**Coupling = interfaces, not runtime dependencies.** The repos interlock only through published contracts (gRPC proto,
settings format) and do not embed each other's code. The agent's host does not have to be naia-shell (any host that speaks the same gRPC contract will do).

---

## Architecture at a glance

A classic **hexagonal (ports & adapters)** structure — the core logic (domain) knows nothing about the outside world
(files, network, gRPC) and connects only through **ports** (boundary interfaces) and their **adapters** (implementations).
So you can swap the transport and the core logic stays the same. (If the terms are unfamiliar → [Glossary](docs/glossary.md) (Korean))

```
input   ports/uc1.ts (AgentIngressPort)      ← the gRPC server receives here
   │
process app/chat-turn-handler.ts             ← recall→assemble→provider→tool-loop→save
   │
output  AgentEgressPort                       ← emits text/thinking/toolUse/usage/finish

layers: domain/ (pure contracts) · app/ (processing) · ports/ (boundaries) · adapters/ (gRPC·provider·skill·memory) · composition/ (wiring)
```

- **Transport-orthogonal**: `adapters/grpc/` (production) and `adapters/stdio.ts` (in-process for tests) implement
  the same Ingress/Egress ports → swap the transport without changing domain code.
- Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (Korean). For the overall ecosystem philosophy (two axes, cognitive layers), see
  the architecture docs on the [naia-shell (repo: naia-os)](https://github.com/nextain/naia-os) side.

---

## Quick start

To use an installed CLI right away:

```powershell
naia-agent auth status
naia-agent config set workspace D:\alpha-adk
naia-agent config set coding.agent pi
naia-agent config set coding.model grok-4.3
naia-agent config set coding.tools true
naia-agent doctor
naia-agent run "task instructions" --workdir D:\path\to\repo --json
```

For account, model, session, and verification procedures, follow the [naia-agent CLI manual](docs/naia-agent-cli-manual.md) (Korean).

> **Prerequisite: clone `naia-memory` and `naia-kb-compiler` alongside it in the layout below.**
> **Why?** naia-agent's `package.json` pulls **two** neighboring repos directly from local folders
> (local paths, not published packages):
>
> ```jsonc
> "@naia/kb-compiler":    "file:../../naia-kb-compiler",
> "@nextain/naia-memory": "file:../../naia-memory",
> ```
>
> This reflects the maintainer's folder layout (with the agent under `dev/`), so if you set it up **once** in the shape
> below, `pnpm install` will succeed. **If either one is missing, `pnpm install` itself fails** —
> at runtime chat still works without kb-compiler (only the knowledge tools are dropped, via dynamic import + isolation),
> but **dependency resolution always happens, regardless of runtime flags.**
>
> ```bash
> mkdir naia-stack && cd naia-stack
> git clone https://github.com/nextain/naia-memory.git
> git clone https://github.com/nextain/naia-kb-compiler.git
> git clone https://github.com/nextain/naia-agent.git dev/naia-agent
> # Resulting layout:
> #   naia-stack/
> #   ├── naia-memory/          ← where file:../../naia-memory points
> #   ├── naia-kb-compiler/     ← where file:../../naia-kb-compiler points
> #   └── dev/naia-agent/       ← run pnpm install here
> cd dev/naia-agent
> ```
>
> **In a different layout (e.g. side by side under `projects/` in an ADK workspace)**, `file:../../` no longer
> lines up. In that case, expose the two repos at the expected location with a **junction/symlink** (Windows example):
>
> ```powershell
> # From <ws>/projects/naia-agent, file:../../ points to <ws>/
> cmd /c mklink /J "<ws>\naia-memory"      "<ws>\projects\naia-memory"
> cmd /c mklink /J "<ws>\naia-kb-compiler" "<ws>\projects\naia-kb-compiler"
> ```
>
> Build order: `naia-kb-compiler` → `naia-memory` → `naia-agent` (the first two must produce `dist/` first).

```bash
pnpm install        # install dependencies (requires cloning in the layout above)
pnpm build          # tsc build
pnpm test           # unit, contract, and integration tests (vitest)
```

The normal path is for a **host to spawn** the agent rather than running it standalone. To launch it directly:

```bash
pnpm start                  # = node scripts/builds/agent-stdio-entry.mjs
                            # prints `GRPC_LISTENING <addr>` to stdout → the host connects
```

> The entry point is `scripts/builds/agent-stdio-entry.mjs`, which loads `dist/main/composition/index.js` (a build
> artifact; requires `pnpm build`). In other words, you must run `pnpm build` first before launching it directly.

Once started, the agent loads the naia-adk settings through the host's `SetWorkspace(adkPath)` to configure the
provider/model, and handles conversation through `Chat(server-stream)`.

### Standalone CLI — running orchestration (without naia-shell)

For persistently managing multiple coding issues with the built-in Pi, use `naia-agent loop --help`.
This path does not install, call, or fall back to OpenCode, and it reserves call counts, USD, and input/output tokens
in SQLite before each call, so unresolved paid calls are not repeated after a restart. Discord ingress and
naia-shell display are in scope for later adapters.

```bash
cp examples/pi-continuous-loop.config.example.json /private/path/loop.json
# After editing absolute paths and limits:
naia-agent loop serve --config /private/path/loop.json
# Or one-shot commands:
naia-agent loop start --config /private/path/loop.json \
  --request examples/pi-continuous-loop.request.example.json
naia-agent loop list --config /private/path/loop.json
naia-agent loop budget --config /private/path/loop.json
```

To minimize use of the Codex subscription, use `examples/codex-luna-azure-team.config.example.json`.
This profile pins only the single moderator slot to `gpt-5.6-luna` and sends the remaining model sessions to the Naia
Gateway (Azure).

`serve` keeps the process running and connects NDJSON requests on stdin (`{ "id": "...", "command": "list" }`) to
the same session manager. `start`, `answer`, and `cancel` schedule work and wake the background pump,
so you can run and query multiple issues concurrently from one control session.

All registered Naia models, including DeepSeek V4 Flash/Pro, can use Pi tools and can be assigned to
the explorer/tester/reviewer roles as well as the writing implementer role. `--no-tools` applies only when the user
explicitly asks for a run without tools. The estimated-USD limits in the examples are operational caps based on a fixed Azure rate card and
the gateway markup; without versioned Gateway receipts they are not claims of measured cost.

The cost-comparison contract is fixed in `benchmark/orchestration/pi-cost-comparison.json`. Before any real calls,
create the pins and the derived contract using an external HMAC key and the exact price-version IDs confirmed with the Naia gateway.

```bash
NAIA_BENCHMARK_JOURNAL_KEY='<external key, 32+ bytes>' \
node benchmark/prepare-pi-cost-pins.mjs \
  --git /usr/bin/git \
  --price-version deepseek-v4-flash=<gateway-price-version-id> \
  --price-version grok-4.3=<gateway-price-version-id> \
  --output-pins /private/pi-cost-pins.json \
  --output-contract /private/pi-cost-contract.json
```

The prepare command makes no paid calls and generates a derived contract that binds the SHA-256 of the entire pins file as `pinsDigest`.
The derived contract may differ from the canonical one only in `pinsDigest`. From then on, use these two files for the same run and analysis.

```bash
NAIA_PI_COST_CONFIRM=1 NAIA_API_KEY='<key>' NAIA_BENCHMARK_JOURNAL_KEY='<same-key>' \
node benchmark/run-pi-cost-comparison-live.mjs \
  --contract /private/pi-cost-contract.json --pins /private/pi-cost-pins.json \
  --confirm-paid-comparison --output /private/pi-cost-result.json
NAIA_BENCHMARK_JOURNAL_KEY='<same-key>' node benchmark/analyze-pi-cost-comparison.mjs \
  --contract /private/pi-cost-contract.json --pins /private/pi-cost-pins.json \
  --evidence /private/pi-cost-result.json
```
A savings verdict is allowed only if the run passes all of: the same task, the same per-role attempt structure, checkpoint resume, and determinism checks, and every real tool-loop call has an actual customer billing receipt bound to a gateway request
ID and price version.
Running without evidence returns `unavailable` with zero paid calls, and Pi estimates or log differences over a time window
are not treated as proof of cost efficiency. Beyond the submitted rows, the evidence also includes each run's hash-chained receipt journal and the full request set and settlement totals of the shared SQLite
gateway ledger, so omissions are detected. All evidence is verified with an external HMAC key and a key ID fixed in advance,
and if any of the key, the price versions, or the credentials is missing, the run stops before any paid call. This verification prevents after-the-fact tampering
with a fixed internal comparison, but the current gateway responses themselves carry no server signature, so it is not overstated as third-party audit proof.

After `pnpm build`, give it work directly from the terminal (S2 supervisor mode). It spawns an external coding agent (or a shell)
as a sub-agent → (optional) watches the workspace + (optional) verifies → **honest numeric report**.

```bash
pnpm build
# Run a shell command as the sub-agent (works right away, no external tools needed):
node bin/naia-agent-run.mjs run "echo hello" --agent shell
#  = pnpm supervise run "echo hello" --agent shell   (same thing)

# Including verification after completion (exit 2 if verification fails):
node bin/naia-agent-run.mjs run "pnpm -v" --agent shell --check build="pnpm build" --check test="pnpm test"

# With an external coding agent (when installed): --agent pi | opencode
node bin/naia-agent-run.mjs run "fix this bug" --agent pi --watch

node bin/naia-agent-run.mjs --help     # all options (--workdir/--model/--watch/--poll/--check/--json)
```

**Exit codes**: `0` session succeeded + verification passed · `2` verification failed · `3` session failed/aborted · `64` argument error (`--help` returns `0`).
A sub-agent that is not installed (e.g. `--agent claude-code`) honestly ends as unsupported (session failure = 3).
The `naia-agent` command is also exposed through `bin` in `package.json` (`naia-agent run ...` after `pnpm link`/install).

**Output channels**: `stdout` is **for machine output only** — a single line of report JSON, only with `--json` (always valid JSON, pipe-safe).
The sub-agent's raw output (stdout and stderr merged into a transcript), progress events, and the human-readable report all go to `stderr`.
So `... --json 2>/dev/null | jq` does not break. The change counts from `--watch` are **deltas** relative to when the task started (baseline)
(files that were already dirty before the task are excluded) and are sampled at each poll interval (changes from fast tasks may be missed → `--check` recommended).

> For the full desktop experience together with naia-shell, see the [naia-os](https://github.com/nextain/naia-os) README.

---

## Development process (for contributors)

This repo is managed **contract-first + V-model** — scenarios, requirements, and tests come before a single line of code.

| Gate | Deliverable |
|--------|--------|
| P01 User scenarios | `docs/user-scenarios.md` UC |
| P02 Test scenarios | Test Coverage Map mapping |
| P03 Requirements | `docs/requirements.md` FR/NFR |
| P04 Integration tests | `src/test/*.contract.test.ts` |
| P05 Done | Requirement status → Done |

Traceability registry (requirements → UC → tests → features → tests, zero orphans):
`docs/progress/01.requirements ~ 05.features-tests`.

The entry point and rules for every AI tool are in **[`AGENTS.md`](AGENTS.md)** (Korean) — if you are new, read it after this README.
For a quick first-contribution guide, see [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md) (Korean; includes a 15-minute fast path).

---

## Project structure

```
naia-agent/
├── AGENTS.md / CLAUDE.md / GEMINI.md / OPENCODE.md / CODEX.md   # AI entry points (charter) — AGENTS.md is the SoT, the rest are auto mirrors
├── .agents/        # AI context (rules · status · hooks) — edited by humans
│   └── context/    #   agents-rules.json (rules SoT) · process-status.json (progress) · module-manifest.json (per-file contract anchors)
├── .users/         # human-readable Markdown mirror of .agents/
├── src/
│   ├── main/       # main source — domain / app / ports / adapters / composition
│   └── test/       # contract, integration, and unit tests
├── scripts/        # enforce-root-structure.sh (structure enforcement) · sync-harness-mirrors.sh (mirror sync), etc.
└── docs/           # ARCHITECTURE · requirements · user-scenarios · progress (V-model registry)
```

Structure rule: a new root file/folder must first be registered in `agents-rules.json` (F12/F13).
If it is not registered, `scripts/enforce-root-structure.sh --fix` **deletes** it.

---

## License

- **Source code**: Apache License 2.0 — [`LICENSE`](LICENSE).
- **AI context** (`.agents/` · `.users/` · `AGENTS.md`): CC-BY-SA 4.0 — [`CONTEXT-LICENSE`](CONTEXT-LICENSE).

**Why a dual license?** The source code is Apache 2.0, so you are free to modify it and use it commercially, but the AI context files (project philosophy, contribution structure, principles for collaborating with AI agents) are CC-BY-SA 4.0. When you fork, you must **share changes to the context under the same license (ShareAlike)** and credit the original author (Nextain) — this protects the upstream ecosystem (open-source contribution structure + AI collaboration principles) so that it propagates to every fork. Details = [`CONTEXT-LICENSE`](CONTEXT-LICENSE).

For the contribution guide, code of conduct, and security policy, see [`.github/`](.github/).

## Links

- **naia-shell (repo: naia-os)** (visual shell codebase + distribution vision) — [github.com/nextain/naia-os](https://github.com/nextain/naia-os)
- **naia-memory** (long-term memory) — [github.com/nextain/naia-memory](https://github.com/nextain/naia-memory)
- **naia-adk** (workspace) — [github.com/nextain/naia-adk](https://github.com/nextain/naia-adk)
- **Nextain** — [nextain.io](https://nextain.io)
