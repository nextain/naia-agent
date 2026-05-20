# naia-agent — User Guide

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

