# Not logged in? — naia-agent provider auth guide

> **Languages**: English (this file) · [한국어](../.users/docs/ko/auth-not-logged-in.md)

naia-agent does **not** ship LLM credentials. It runs on **your own**
Claude / OpenAI / Gemini / GLM subscription or API key. If none is
available the CLI exits cleanly with an actionable hint — no silent
mock fallback in the active CLI path.

## Quick check — what am I authenticated for?

| Provider (role: main / sub / embedded) | Auth you need | How to log in |
|---|---|---|
| **Claude** (`claude-code` backend — subscription, no API key) | Claude Code login (Pro/Max/Team/Ent plan) **or** `ANTHROPIC_API_KEY` | run `claude` once and sign in (OAuth), or `export ANTHROPIC_API_KEY=...` |
| **Codex** (subagent / official SDK — ChatGPT subscription) | Codex CLI login (ChatGPT plan) **or** `OPENAI_API_KEY` | log in via the Codex CLI, or set `OPENAI_API_KEY` |
| **Gemini** (via the **naia account / any-llm gateway**, or `gemini-cli` as a subagent) | naia gateway credential (recommended) **or** `gemini-cli` OAuth (Google/Gemini plan) | use the naia gateway (`backend:"openai-compatible"` + gateway baseURL), or `gemini` login |
| **GLM** (coding plan) | `GLM_API_KEY` | `export GLM_API_KEY=...` |
| **Ollama / vLLM** (local, no auth) | none — local endpoint | run the local server (`backend:"openai-compatible"` → `http://localhost:...`) |

## Claude Code subscription (no API key) — `backend:"claude-code"`

For users on a Claude Pro/Max/Team/Ent plan who do **not** want to mint
an API key, naia-agent ships a dedicated `claude-code` backend that
routes through the Claude Agent SDK (`ai-sdk-provider-claude-code`).
This consumes subscription credit per call (monthly cap, per-account,
2026-06-15 policy), not API-key dollars.

```bash
pnpm naia-agent --service ./my-app.service.json
```

with a manifest like:

```jsonc
{
  "schemaVersion": "0.1.0",
  "name": "my-app",
  "llm": { "backend": "claude-code", "model": "claude-haiku-4-5-20251001" }
}
```

How to verify it routes correctly without consuming credit:

```bash
NAIA_AGENT_DRYRUN=1 pnpm naia-agent --service ./my-app.service.json
```

The dry-run gate asserts the dispatcher arm (Slice 3-XR-G `G3`
DRYRUN scenario; Slice 3-XR-M `M2` finalized the routing surface)
and exits before any LLM call. To actually exercise a one-turn live
call (credit consumed), opt in with `NAIA_AGENT_CLAUDECODE_LIVE=1`
(Slice 3-XR-M `M2`). Default is OFF.

Authentication is handled by the Claude Code CLI itself (`claude`
login / OAuth) — naia-agent never sees or proxies the token.

## If you are NOT logged in to any agent CLI

- **Recommended:** use the **naia account / any-llm gateway** for *all*
  roles (`backend:"openai-compatible"` + the gateway `baseURL`). One
  credential, no per-CLI login.
- **Or** log in to at least one ecosystem above for the role you need.
- **main** requires a working provider. **sub / embedded** are
  subagent / embedding calls — they need the corresponding CLI to be
  logged in (or routed through the naia gateway).
- With **no** provider at all → `naia-agent` exits 3 with an
  actionable message (no silent mock fallback in the CLI active path).

The `bin` advertises both quick paths in the error:

```
naia-agent: no provider configured.
  → run `pnpm naia-agent login --adk <path> --main "provider|baseUrl|model[|apiKeyRef]"`,
  → or set ANTHROPIC_API_KEY / OPENAI_API_KEY+OPENAI_BASE_URL / GLM_API_KEY,
  → or point NAIA_ADK_PATH at a naia-adk workspace with naia-settings/llm.json.
  See docs/llm-config-standard.md + docs/user-guide.md.
```

## What naia-agent should tell you (UX contract — tracked nextain/naia-agent#39)

When a selected provider is not authenticated, naia-agent emits a
**clear, actionable** message (not a raw stack trace), e.g.:

```
naia-agent: provider=claude-code not authenticated.
  → run `claude` and sign in (Pro/Max plan), or set ANTHROPIC_API_KEY,
  → or switch this role to the naia gateway (backend:"openai-compatible").
  See docs/auth-not-logged-in.md.
```

(`anthropic` / `vertex` backends already pre-check and guide;
`claude-code` / `codex` / subagent backends get the same
capability-aware pre-flight + this guidance — implemented under
nextain/naia-agent#39 with adversarial + structural review.)

## Security / policy reminders

- naia-agent never stores or proxies your credentials; auth is between
  **you and the provider** (Anthropic / OpenAI / Google / Zhipu).
- Distributed builds **cannot** offer claude.ai/ChatGPT login as a
  service (provider policy) — each user authenticates with their own
  plan/key. See nextain/naia-agent#38 (ToS / distribution).
- Subscription usage draws from **your** plan's credit (e.g. Claude
  Agent SDK monthly credit, 2026-06-15 policy), per-account, not
  pooled.
- API keys are stored device-key-encrypted in the OS keychain
  (libsecret / Secret Service) via `pnpm naia-agent login --key
  REF=VALUE`. `llm.json` never contains a plaintext key — only the
  `apiKeyRef` NAME (env-var or keychain entry).
