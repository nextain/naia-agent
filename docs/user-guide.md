# naia-agent — User Guide

> **Languages**: English (this file) · [한국어](../.users/docs/ko/user-guide.md)

A short guide to using `naia-agent` from the command line. Two
perspectives, both covered:

- **You, on the CLI** — a regular user typing `naia-agent …`.
- **naia-os shell (or any host)** — invoking `naia-agent` programmatically
  through an any-llm gateway URL.

The CLI ships no credentials. Your model is your subscription / API key
/ local server (Ollama, vLLM, …). Settings live in **naia-adk**, not in
this repository.

---

## Quick start (3 commands)

```bash
# 1) point naia-agent at your naia-adk + pick your model
pnpm naia-agent login --adk ~/path/to/naia-adk \
  --main "openai-compat|http://127.0.0.1:11434/v1|gemma3n:e4b"

# 2) see what you configured (no secret values are ever printed)
pnpm naia-agent show

# 3) talk to it (local models without native tool-calling: add --no-tools)
pnpm naia-agent --no-tools "한국어로 한 문장만 인사해줘"
```

After step (1), `naia-adk/naia-settings/llm.json` holds the configuration
(provider, baseUrl, model — never a key). The naia-adk path is
remembered in `~/.naia-agent/config.json` so you do **not** need
`NAIA_ADK_PATH` afterwards.

---

## Common tasks

### Inspect what's set up

```bash
pnpm naia-agent show
```

One screen: each role (`main` / `sub` / `embedded`), where the
`llm.json` lives, which provider would actually run, where memory is
stored, and the name of any keychain/env reference. **Secret values are
never printed** — only the *name* of the env var or keychain entry.

### Add or swap a model

Re-run `login`. Roles you don't pass are kept. Example:

```bash
# swap the embedding model only — main/sub untouched
pnpm naia-agent login --adk ~/path/to/naia-adk \
  --embedded "ollama-embed|http://127.0.0.1:11434/v1|bge-m3|1024"
```

### Use a real key

Keys are stored in your OS keychain (libsecret on Linux), never in
plaintext. The `llm.json` carries only the *name* of the keychain entry.

```bash
pnpm naia-agent login --adk ~/path/to/naia-adk \
  --main "anthropic|https://api.anthropic.com|claude-haiku-4-5|ANTHROPIC_API_KEY" \
  --key ANTHROPIC_API_KEY=sk-ant-…
```

If your OS keychain is unavailable, `login` will *refuse* to persist the
key (no plaintext fallback) and tell you to `export` it in your shell
instead.

### Chat with persistent memory

Add `--memory`. Facts you tell it in one process are recalled in the
next (cross-session SQLite).

```bash
pnpm naia-agent --no-tools --memory \
  "내 이름은 루크고, 가장 좋아하는 음료는 보리차야."

# Later, a new process:
pnpm naia-agent --no-tools --memory \
  "내가 제일 좋아하는 음료가 뭐였지?"
```

Memory lives in `~/.naia-agent/memory/cli.sqlite` by default. Set
`NAIA_AGENT_MEMORY_DB` per workspace to isolate.

### REPL mode

`pnpm naia-agent` with no prompt drops you into a REPL (`naia> `). Type
`exit` (or Ctrl-D) to leave. The REPL stays alive across single failed
turns — a model-server outage prints a hint and the prompt comes back.

Pipe-fed REPL (Slice 3-XR-M) — use `--repl` to force REPL mode even when
stdin is piped. Useful for shell pipelines feeding multiple prompts:

```bash
printf "hi\nstill there?\nexit\n" | pnpm naia-agent --no-tools --repl
```

### Use ADK skills (naia-adk, onmam-adk, …)

The `--skills-dir <path>` flag (Slice 3-XR-J) loads an external ADK's
top-level `skills/` directory and merges them with bash + file-ops via
`CompositeToolExecutor`. First-registered wins on name collisions —
sub order is a trust boundary.

```bash
# naia-adk system skills (19) — time, weather, channel-management, etc.
pnpm naia-agent --enable-file-ops --skills-dir projects/naia-adk/skills \
  --system "You can use time, weather, channel-management, etc." \
  "What time is it in Seoul?"

# onmam-adk domain skills (10 + wp-archive)
pnpm naia-agent --enable-file-ops --skills-dir projects/onmam-adk/skills \
  "summarize the wp-archive skill"
```

Tool invocations land on stderr as `[tool] <name>({args})` — greppable.

### Run the evaluation harness yourself

```bash
# Full integration suite (53+ scenarios across Groups A/B/C/D/E/F/G/H/I/M/N/O/P/K)
pnpm --filter @nextain/agent-cli-app exec vitest run \
  src/__tests__/integration-scenarios.test.ts

# A single group
pnpm --filter @nextain/agent-cli-app exec vitest run -t "Group P"   # pi-coding LIVE
pnpm --filter @nextain/agent-cli-app exec vitest run -t "Group D"   # naia-adk skills
pnpm --filter @nextain/agent-cli-app exec vitest run -t "Group G"   # onmam-adk

# 3-judge ensemble (GLM + Claude CLI + Codex CLI) — consumes credits!
NAIA_JUDGE_ENSEMBLE=1 \
  pnpm --filter @nextain/agent-cli-app exec vitest run -t "A1|A4|F2"
```

Results land in `.agents/progress/integration-scenarios-results-2026-05-20.json`
(per-scenario verdict, judge breakdown, observed tail) and the prose
summary in `integration-scenarios-report-2026-05-20.md`. See the
project's main README "Running benchmarks + scenarios yourself" section
for the complete list (tier comparison, cross-OS sanity, recall bench).

---

## naia-os shell / gateway perspective

A host (e.g. naia-os shell) routes through the any-llm gateway. To
naia-agent, the gateway is just an openai-compatible endpoint:

```bash
pnpm naia-agent login --adk ~/path/to/naia-adk \
  --main "openai-compat|https://your-gateway.example/v1|your-model|GATEWAY_API_KEY"
```

`show` will display the gateway URL and the `apiKeyRef=GATEWAY_API_KEY`
*name*; the key value lives in the OS keychain or your shell env.

---

## Troubleshooting

**"no LLM provider configured" / exit 3**
Run `naia-agent login --adk …` (above), or set an env var like
`ANTHROPIC_API_KEY` for a hosted provider.

**"turn failed — … unreachable"**
The model server isn't running, or the URL is wrong. Start it, or
re-`login` with a different baseUrl.

**"does not support tools"**
Your model has no native tool-calling (e.g. local gemma3n). Add
`--no-tools`. naia-agent will print this hint automatically.

**`<recal…>` text leaking into an answer**
Small models occasionally emit malformed recall markers. The agent
sanitizes the answer; rare letter-drop variants may slip through and
are an inherent small-model limitation, not a code defect.

---

## Privacy & secrets

- `naia-adk/naia-settings/llm.json` is **git-tracked**; it holds
  provider/url/model only. The reader actively *rejects* a file
  containing a raw secret.
- Keys go to the OS keychain (libsecret, device-key encrypted) or your
  shell env. naia-agent never writes keys to disk.
- `show` prints reference *names* only; values are never displayed.

---

## Where things live

| File | Owner | Purpose |
|---|---|---|
| `<naia-adk>/naia-settings/llm.json` | naia-adk | Canonical LLM config (3 roles) |
| `~/.naia-agent/config.json` | naia-agent | Persisted `naiaAdkPath` |
| `~/.naia-agent/memory/cli.sqlite` | naia-agent | `--memory` store |
| OS keychain (libsecret) | OS | Encrypted key values |

---

## When in doubt

```bash
pnpm naia-agent              # usage + subcommands
pnpm naia-agent show         # current configuration
pnpm naia-agent login        # usage for login
```

---

## ADK ecosystem (advanced)

`naia-agent` is the **runtime skeleton**; it consumes skills from ADK
packages. Integration is verified per Slice 3-XR-G/J/L:

| ADK | Integration | Scenarios |
|---|---|---|
| `naia-adk` | `FileSkillLoader` + `SkillToolExecutor` via `--skills-dir` | Group D (LIVE 24G, 19/19 system skills) |
| `naia-business-adk` | `--service <manifest>` `backend:"langgraph"\|"rag-retriever"` | Group E (reserve stub graceful; live = deferred to Slice 3-XR-K) |
| `naia-os` | `--system "<persona text>"` persona injection | Group F (LIVE 24G ✅) |
| `onmam-adk` | Same import path as `naia-adk` (domain skills) | Groups D/G (mechanism reuse) |

Full results: `.agents/progress/integration-scenarios-report-2026-05-20.md`.

## Persona injection (`--system`)

The interface naia-os uses when injecting a persona. Also available
directly from the CLI:

```bash
pnpm naia-agent --no-tools --no-default-system \
  --system "You are a soft-spoken Korean voice assistant. Be brief." \
  "Say hello in one short sentence."
```

- Persona composes with `--memory` (verified by F2). Persona tone is
  preserved across cross-process recall.
- Personas up to ~4 KB validated (F4).
- For thinking-mode models (e.g. Gemma 4), append
  `Answer directly. Do not write any internal reasoning.` to the
  persona — the response stays clean.

## Planned / not yet shipped (deferred)

These appear in the project roadmap but are NOT covered by the current
scenario tests:

- **RBAC tier policy / approval broker UX** — runtime supports tiers
  (T0–T3) and `ApprovalBroker`, but no end-to-end CLI scenario yet.
- **Claude Code subscription routing** — bin accepts `--service
  <manifest>` with `backend:"claude-code"` (no API key, uses the
  Claude Code CLI's OAuth). DRYRUN routing dispatch is covered by
  scenario G3 (`NAIA_AGENT_DRYRUN=1`); a live-subscription E2E test
  is deferred (would consume Claude Code credits).
- **SDLC artifact production** (real coding / specs / docs) — needs a
  strong coding model; the 8G/24G local profiles can chat but cannot
  reliably deliver SDLC-grade artifacts. Plan: enable when a strong
  backend (claude-code subscription / gateway-hosted Anthropic /
  Codex) is configured for `main`.

