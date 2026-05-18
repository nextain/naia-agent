# Not logged in? — naia-agent provider auth guide

naia-agent does **not** ship LLM credentials. It runs on **your own**
Claude / OpenAI / Gemini / GLM subscription or API key. If none is
available it falls back to a mock (no real model).

## Quick check — what am I authenticated for?

| Provider (role: main / aux / reviewer) | Auth you need | How to log in |
|---|---|---|
| **Claude** (`claude-code` backend — subscription, no API key) | Claude Code login (Pro/Max/Team/Ent plan) **or** `ANTHROPIC_API_KEY` | run `claude` once and sign in (OAuth), or `export ANTHROPIC_API_KEY=...` |
| **Codex** (subagent / official SDK — ChatGPT subscription) | Codex CLI login (ChatGPT plan) **or** `OPENAI_API_KEY` | log in via the Codex CLI, or set `OPENAI_API_KEY` |
| **Gemini** (via the **naia account / any-llm gateway**, or `gemini-cli` as a subagent) | naia gateway credential (recommended) **or** `gemini-cli` OAuth (Google/Gemini plan) | use the naia gateway (`backend:"openai-compatible"` + gateway baseURL), or `gemini` login |
| **GLM** (coding plan) | `GLM_API_KEY` | `export GLM_API_KEY=...` |
| **Ollama / vLLM** (local, no auth) | none — local endpoint | run the local server (`backend:"openai-compatible"` → `http://localhost:...`) |

## If you are NOT logged in to any agent CLI

- **Recommended:** use the **naia account / any-llm gateway** for *all*
  roles (`backend:"openai-compatible"` + the gateway `baseURL`). One
  credential, no per-CLI login.
- **Or** log in to at least one ecosystem above for the role you need.
- **main-llm** requires a working provider. **aux / reviewer** are
  subagent *calls* — they need the corresponding CLI to be logged in
  (or routed through the naia gateway).
- With **no** provider at all → naia-agent uses a **mock** LLM
  (`"Hello! I'm naia-agent in mock mode"`) so the harness still runs;
  this is **not** a real model — log in or configure the gateway for
  real work.

## What naia-agent should tell you (UX contract — tracked nextain/naia-agent#39)

When a selected provider is not authenticated, naia-agent must emit a
**clear, actionable** message (not a raw stack trace), e.g.:

```
naia-agent: provider=claude-code not authenticated.
  → run `claude` and sign in (Pro/Max plan), or set ANTHROPIC_API_KEY,
    or switch this role to the naia gateway (backend:"openai-compatible").
  See docs/auth-not-logged-in.md.
```

(`anthropic` / `vertex` backends already pre-check and guide;
`claude-code` / `codex` / subagent backends get the same capability-aware
pre-flight + this guidance — implemented under nextain/naia-agent#39 with
adversarial + structural review.)

## Security / policy reminders

- naia-agent never stores or proxies your credentials; auth is between
  **you and the provider** (Anthropic / OpenAI / Google / Zhipu).
- Distributed builds **cannot** offer claude.ai/ChatGPT login as a
  service (provider policy) — each user authenticates with their own
  plan/key. See nextain/naia-agent#38 (ToS / distribution).
- Subscription usage draws from **your** plan's credit (e.g. Claude
  Agent SDK monthly credit, 2026-06-15 policy), per-account, not pooled.
