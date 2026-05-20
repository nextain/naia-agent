# LLM Config Standard — naia-agent

> **Languages**: English (this file) · [한국어](../.users/docs/ko/llm-config-standard.md)

**Initial draft**: 2026-04-25 (Slice 1c+, R3)
**Last revision**: 2026-05-20 (Slice 3-XR-B / E / F / G shipped — login + libsecret + 3-role canonical + service manifest)
**Scope**: naia-agent CLI (`bin/naia-agent.ts`) + embedded host context
**Status**: stable — additive only (semver MINOR for new providers/keys, MAJOR for breaking)

This document is the canonical standard for LLM provider configuration.
naia-agent and the multi-tool harness (CLAUDE / GEMINI / OPENCODE / CODEX
mirrors) all follow the same standard. No external-tool dependency
(openclaw / Anthropic-external gateway / etc. all irrelevant).

In the prose below, the per-user config directory is written as
`<HOME>/.naia-agent/` to keep this file portable across users and OS
shells. Code blocks reproduce the literal shell form.

---

## 1. Environment variables (canonical, priority order)

### 1.1 Provider resolution priority

The order below mirrors `buildLLMClient()` in `bin/naia-agent.ts`
exactly — first match wins:

```
1) ANTHROPIC_API_KEY (+ optional ANTHROPIC_BASE_URL) → Anthropic direct
2) OPENAI_API_KEY + OPENAI_BASE_URL                  → OpenAI-compat (generic)
3) GLM_API_KEY                                        → zai/Zhipu GLM (shorthand)
4) VERTEX_PROJECT_ID + VERTEX_REGION                  → Anthropic on Vertex AI
5) (none)                                             → ERROR, exit 3 (no mock fallback in CLI)
```

**Rule**: first match wins. When several keys are simultaneously
present, the resolver picks the topmost row.

> Note: the OpenAI branch requires BOTH `OPENAI_API_KEY` *and*
> `OPENAI_BASE_URL` — bare `OPENAI_API_KEY` is intentionally not enough
> (avoids accidental hits against the OpenAI public endpoint). Local
> Ollama / vLLM are reached through this branch with the loopback
> baseURL.

### 1.2 Environment variable table

| Variable | Required? | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | (provider 1) | — | Anthropic auth |
| `ANTHROPIC_BASE_URL` | optional | `https://api.anthropic.com` | Anthropic-compat gateway routing |
| `ANTHROPIC_MODEL` | optional | `claude-haiku-4-5-20251001` | Model ID |
| `OPENAI_API_KEY` | (provider 2) | — | OpenAI-compat auth |
| `OPENAI_BASE_URL` | (provider 2) | — | Endpoint URL |
| `OPENAI_MODEL` | optional | `glm-4.5-flash` (shorthand default) | Model ID |
| `GLM_API_KEY` | (provider 3) | — | zai/Zhipu GLM auth (shorthand) |
| `GLM_BASE_URL` | optional | `https://open.bigmodel.cn/api/paas/v4` | zai endpoint |
| `GLM_MODEL` | optional | `glm-4.5-flash` | Model ID |
| `VERTEX_PROJECT_ID` | (provider 4) | — | GCP project (or `GOOGLE_CLOUD_PROJECT`) |
| `VERTEX_REGION` | (provider 4) | — | Region (or `GOOGLE_CLOUD_LOCATION`) |
| `NAIA_ADK_PATH` | optional | — | Path to the naia-adk workspace (locates `naia-settings/llm.json`) |
| `NAIA_AGENT_ENV` | optional | — | Override path to the `.env` file |
| `NAIA_AGENT_CONFIG` | optional | — | Override path to the JSON config file |
| `NAIA_AGENT_MEMORY_DB` | optional | — | Override `--memory` SQLite path (workspace isolation) |
| `NAIA_SUB_*` / `NAIA_EMBED_*` | optional | — | Exposed from `llm.json` `sub` / `embedded` roles |

---

## 2. The 3-role canonical config (`naia-settings/llm.json`)

The **cross-repo Single Source of Truth** is
`naia-adk/naia-settings/llm.json`. It carries three roles plus
`version: 1`:

```jsonc
{
  "version": 1,
  "main":     { "provider": "openai-compat", "baseUrl": "...", "model": "...", "apiKeyRef": "OPENAI_API_KEY" },
  "sub":      { "provider": "openai-compat", "baseUrl": "...", "model": "..." },
  "embedded": { "provider": "ollama-embed", "baseUrl": "...", "model": "...", "dims": 1024 }
}
```

| Role | Purpose | Consumed by |
|---|---|---|
| `main` | The conversational Agent LLM | `naia-agent` direct mode (drives the running agent) |
| `sub` | Reviewer / auxiliary subagent LLM | subagent calls (two-tier) |
| `embedded` | Embedding model for memory recall | memory host / `--memory` recall |

Supported `provider` values: `openai-compat` | `ollama-embed` |
`anthropic` | `glm` (local Ollama / vLLM use `openai-compat` /
`ollama-embed` and need no auth).

`naia-agent` finds this file via `NAIA_ADK_PATH` (workspace root), maps
`main` onto the provider resolution variables of §1 (`OPENAI_*` /
`ANTHROPIC_*` / `GLM_*` — only keys not already present in
`process.env`), and exposes `sub` / `embedded` as `NAIA_SUB_*` /
`NAIA_EMBED_*`.

### 2.1 Secret policy — no plaintext, ever

`llm.json` is a git-tracked backup unit. It **must never contain a raw
API key**:

- `apiKeyRef` carries an **environment-variable NAME** (Slice A, now)
  or an **OS-keychain entry NAME** (Slice B, device-key encrypted —
  shipped). The actual secret lives in `process.env` or the OS
  keychain — never in this file.
- **Enforced, not just convention**: the `naia-agent` reader actively
  rejects an entire `llm.json` (warn + skip; value never logged) if any
  role carries a plaintext-secret-looking key (`apiKey` / `key` /
  `token` / …) or value (`sk-…` / `AIza…` / 40-hex / …). A raw key here
  is refused, not silently consumed into git.
- Local Ollama / vLLM need no key — simply omit `apiKeyRef`
  (a loopback / private `baseUrl` gets a dummy key automatically;
  remote URLs do **not**).

### 2.2 Legacy JSON config (still supported, role-less)

A flat per-provider `JSON` config (no `main` / `sub` / `embedded`
split) is still accepted for backward compatibility:

```json
{
  "anthropic": {
    "apiKey": "sk-ant-...",
    "baseUrl": "https://api.anthropic.com",
    "model": "claude-haiku-4-5-20251001"
  },
  "openai": {
    "apiKey": "sk-...",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4"
  },
  "glm": {
    "apiKey": "...",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "model": "glm-4.5-flash"
  },
  "vertex": {
    "projectId": "your-gcp-project",
    "region": "us-east5"
  }
}
```

**Auto-conversion**: camelCase / kebab-case keys → SCREAMING_SNAKE_CASE
environment variables.

- `anthropic.apiKey` → `ANTHROPIC_API_KEY`
- `glm.baseUrl` → `GLM_BASE_URL`
- `vertex.projectId` → `VERTEX_PROJECT_ID`

`process.env` always wins — the JSON config only fills variables that
are not yet set. **New deployments should prefer the 3-role
`naia-settings/llm.json`** (§2) over this legacy shape.

---

## 3. File location priority

### 3.1 `.env` search (first match wins)

1. `--env <path>` CLI flag
2. `NAIA_AGENT_ENV` environment variable
3. `.env` in the current working directory
4. `naia-agent.env` in the current working directory (opinionated name)
5. The user's global `.naia-agent/.env`

### 3.2 JSON config search

1. `--config <path>` CLI flag
2. `NAIA_AGENT_CONFIG` environment variable
3. `.naia-agent.json` in the current working directory
4. The user's global `.naia-agent/config.json`

### 3.3 Combined priority

```
process.env (already exported)
   ↓ (does not overwrite — fills missing keys only)
naia-settings/llm.json     ← cross-repo SoT, found via NAIA_ADK_PATH
   ↓
.env files (first match per §3.1)
   ↓
JSON config files (first match per §3.2)
```

`bin/naia-agent` calls `loadEnvAndConfig()` at `main()` entry and
applies the order above. `process.env` (variables already exported in
the shell) always wins.

> Upgrade caveat (from earlier prereleases): once `loadEnvAndConfig()`
> is wired, your `.env` / `naia-agent.env` / user-global
> `.naia-agent/config.json` are actually loaded (earlier they were
> ignored because the loader was not called). Before upgrading, make
> sure you do not have an unrelated `.env` sitting in cwd. Variables
> already exported into `process.env` are unaffected — they always
> win.

### 3.4 `naia-settings/llm.json` (cross-repo canonical, summary)

SoT = `naia-adk/naia-settings/README.md`. 3-role `{ main, sub, embedded }`.
`naia-agent` locates the file through `NAIA_ADK_PATH` and maps `main`
onto the provider-resolution variables of §1 (filling only the keys
not already present in `process.env`); `sub` / `embedded` are exposed
under `NAIA_SUB_*` / `NAIA_EMBED_*`. **No plaintext keys** — only
`apiKeyRef` (the env-var NAME, or, since Slice B, the OS-keychain
entry NAME). Local Ollama / vLLM need no key (the openai-compat
resolver auto-applies a loopback sentinel). No per-model / per-tier
branching.

### 3.5 `--no-tools`

For models without native tool-calling (e.g. local Ollama gemma3n).
The Agent runs with zero tools attached. Model-agnostic flag (no
per-model branch).

### 3.5b `--memory`

Persistent long-term memory on. Wires `@nextain/naia-memory`
`LiteMemoryProvider` + the `naia-settings` `embedded` embedder + the
`<recall>` marker recall protocol (naia-agent#41 v2). With no
`--system`, the agent receives a language-neutral recall-protocol
persona plus a leaner default contract. On embedder / SQLite failure,
memory degrades gracefully to ephemeral (no crash). Default off —
no regression. Model and locale agnostic (small-model marker leak is
a known caveat tracked in #41).

> Single global store (default): the default DB lives at the user's
> global `.naia-agent/memory/cli.sqlite`. *Every* directory / project
> that invokes `--memory` shares it (a fact from project A can be
> recalled in project B — intended personal-assistant behaviour, also
> a confidentiality footgun). For per-workspace isolation, set
> `NAIA_AGENT_MEMORY_DB=<path>`.

### 3.6 `naia-agent login` (persisted config + OS keychain)

```
pnpm naia-agent login --adk <path>
  [--main "provider|baseUrl|model[|apiKeyRef]"]
  [--sub  "provider|baseUrl|model[|apiKeyRef]"]
  [--embedded "provider|baseUrl|model|dims[|apiKeyRef]"]
  [--key REF=VALUE]
```

- Writes structural fields to `<adk>/naia-settings/llm.json` — **never
  a raw key**. `--key REF=VALUE` stores the secret in the **OS
  keychain** (libsecret / Secret Service on Linux, device-key
  encrypted) and `llm.json` references it by name through `apiKeyRef`.
- If the keychain is unavailable, login **refuses** (no plaintext
  fallback) and points at a shell `export`. On non-Linux platforms the
  store degrades to "unavailable" — no plaintext path is opened.
- Persists `naiaAdkPath` to the user-global config file
  `.naia-agent/config.json` (mode 600). **After login**, subsequent
  `naia-agent` invocations load `naia-settings/llm.json` even without
  `NAIA_ADK_PATH` exported (§3.4). To return to env-only mode, remove
  the file or unset `naiaAdkPath` inside it.
- `apiKeyRef` is the **NAME** only — if you accidentally pass a raw
  secret in the `apiKeyRef` slot, login rejects the role at the WRITE
  boundary (Slice 3-XR-G).
- `naia-agent show` prints the current resolved configuration without
  ever printing a secret value (NAMES only).

---

## 4. Security standard

### 4.1 File permissions

- Recommended mode for the user's global `.naia-agent/.env`: **600**
  (owner read/write only).
- Same recommendation for any project-local `.env`.
- `chmod 600` the file after creating it.

### 4.2 `.gitignore` (mandatory in every project)

```
.env
.env.local
naia-agent.env
.naia-agent.json
.naia-agent/
```

### 4.3 No-exposure rule

- Code must never print key **values** to stdout / stderr / log
- Printing the key **NAME** is fine (e.g. `ANTHROPIC_API_KEY loaded`)
- Never inline a key in a commit message, PR description, or error
  message

### 4.4 No solo-dependence on cleanroom (F09)

- When implementing an LLM provider, do not directly copy lines from
  `ref-cc-cleanroom`
- Cross-reference at least one of: OWASP, RFC, or an official SDK doc

---

## 5. Multi-tool harness standardisation

This standard is tool-agnostic:

- **Claude Code** — the `AGENTS.md` mirror points at this standard;
  the user's global `.naia-agent/.env` is auto-loaded
- **opencode / Codex** — both read `AGENTS.md` directly; same standard
  applies
- **Gemini CLI** — `GEMINI.md` mirror or `.gemini/settings.json`
  points at this standard
- **naia first-party tools** (in progress) — read `AGENTS.md`
  directly; same standard applies

Per-tool additional LLM settings live in each tool's own `.{tool}/`
directory, but **`forbidden_actions` always follow this standard**.

---

## 6. Adding a new provider

When adding a new provider (Mistral, Cohere, etc.):

1. **Canonicalise env vars**: `<PROVIDER>_API_KEY` plus
   `<PROVIDER>_BASE_URL` / `_MODEL` as needed.
2. **Try OpenAI-compat first**: if the provider is OpenAI-compatible,
   reuse `OPENAI_API_KEY` + `OPENAI_BASE_URL`. Zero additional code.
3. **Non-OpenAI-compat case**: add `packages/providers/src/<provider>.ts`
   and extend the resolver branch.
4. **Update §1.2 in this doc** plus the cross-package matrix (§D).
5. **Update the example file** (`naia-agent.env.example`).
6. **Cite the matrix ID** in the PR template (`addresses D##`).

---

## 7. Model naming convention

| Provider | Format example |
|---|---|
| Anthropic direct | `claude-haiku-4-5-20251001`, `claude-opus-4-7` |
| Anthropic on Vertex | `claude-haiku-4-5@20251001` (Vertex format — uses `@`) |
| OpenAI / OpenAI-compat | Provider-specific (`gpt-4`, `glm-4.5-flash`, `mixtral-8x7b`, …) |

`<PROVIDER>_MODEL` overrides the default.

---

## 8. `--service <manifest>` (Slice 3-XR-J / R6 / SB-1)

The `--service <path-to-*.service.json>` flag selects an
naia-adk-shape **service manifest** instead of provider env vars. The
manifest is data (workspace-local, not a Part-A contract), and the
loader builds the LLM client through a fixed backend enum:

| `llm.backend` | Status | Source of auth | Notes |
|---|---|---|---|
| `openai-compatible` | **shipped** | `OPENAI_API_KEY` or `NAIA_SERVICE_API_KEY` (host env) | `baseURL` trust gate enforced (loopback / private / operator allowlist) |
| `anthropic` | **shipped** | `ANTHROPIC_API_KEY` (host env) | `ANTHROPIC_BASE_URL` honoured |
| `vertex` | **shipped** | `VERTEX_PROJECT_ID` + `VERTEX_REGION` (host env) | — |
| `claude-code` | **shipped** | Claude subscription (no API key) | In-process via `ai-sdk-provider-claude-code`; subscription-credit policy (see naia-agent#39) |
| `langgraph` | reserve stub | n/a | Schema accepts the value; dispatcher deferred to Slice 3-XR-K |
| `rag-retriever` | reserve stub | n/a | Schema accepts the value; dispatcher deferred to Slice 3-XR-K |

API keys are **never** read from the manifest itself — schema §4
(host env only, per 4-repo plan A.6 "LLM key = shell stronghold").
Unknown backends fail closed with exit 3 and a stable stderr line.

---

## 9. Change policy

- **MINOR (additive)** — new provider, new env var, new JSON key. All
  existing behaviour preserved.
- **MAJOR (breaking)** — renaming an env var, JSON shape change,
  resolution-order change.
- This doc at `2026-04-25` = v0.1 — additive-only rule in force.

Matrix cross-links:

- §A20 (env loader) — Slice 1c, file
  `packages/runtime/src/utils/env-loader.ts`
- §A21 (OpenAI-compat client) — Slice 1c+, file
  `packages/providers/src/openai-compat.ts`
- §B22 (no cleanroom line copy-paste) — cross-references F09

---

## 10. Reference — example files

- `naia-agent.env.example` (repo root) — copy to `naia-agent.env`,
  fill in your own keys
- `.naia-agent.example.json` (repo root) — JSON variant, fill in your
  own keys
- Both are gitignored when filled (`*.example` suffix is the only form
  that ships in git)

---

## Change history

- **2026-04-25** (Slice 1c+) — initial standard. 4 providers +
  `.env` / JSON auto-load + security + multi-tool harness compat.
- **2026-05-20** (Slice 3-XR-B / E / F / G) — `naia-agent login` +
  `naia-agent show` shipped; OS-keychain (libsecret) integration;
  3-role `naia-settings/llm.json` is the canonical cross-repo SoT;
  `--service <manifest>` flag with backend enum
  (`openai-compatible` / `anthropic` / `vertex` / `claude-code` +
  reserved `langgraph` / `rag-retriever`); plaintext-secret refusal
  at the write boundary.
