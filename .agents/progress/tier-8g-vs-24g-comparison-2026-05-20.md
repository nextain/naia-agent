# 8G vs 24G tier — comparison report (2026-05-20)

Practical comparison of the two single-GPU `naia-agent` tiers measured
during the Task #3 connection work. Objective focus: what each tier
*actually delivers* on the same scenario harness, not vendor benchmarks.

## TL;DR

| Aspect | 8G (gemma3n:e4b) | 24G (gemma4:31b) |
|---|---|---|
| Role | "이정도 되는구나" communication | Daily driver chat + light coding |
| Disk footprint | 7.5 GB | 19.9 GB (~Q4) |
| VRAM (loaded) | ~10 GB | ~24 GB (near full) |
| Marker discipline | Malformed `<recal…>` frequent | Clean (with thinking) |
| Native tool-calling | **No** | Untested (likely no, Gemma family) |
| Thinking mode | None | **Active by default** (reasoning channel) |
| Korean output | Direct | Requires larger `max_tokens` budget |
| Memory recall (CLI) | Mechanism: SQLite ✅ / Model recall flaky | Mechanism: SQLite ✅ / Model recall not yet measured |
| Scenarios passing | 22/22 active (S13 + S20 honest skips) | (not yet — see "next") |

The two tiers expose the **same wire contract** to naia-agent (OpenAI-
compatible at `http://127.0.0.1:11434/v1`). Switching is a single
`naia-agent login --main` away. Memory / `--no-tools` / `show` /
gateway routing are identical.

## Concrete observations (measured this session)

### 8G — gemma3n:e4b

- **Marker malformation, frequent.** Live runs in this session produced
  `<recal_l>query</recal_l>`, `<recalall>name: Luke, favorite beverage:
  warm barley tea</recalall>`, `<recal_루크, 보리차</recal>`,
  `<recal<사용자가…</recal>`. The strict parser at `agent.ts:266`
  correctly refuses to act on these, but they leaked into output until
  `stripRecallResidue` was added. The `<rcal_>` variant (dropped `e`)
  still escapes the line-leading lenient strip — documented model
  limit, not a strip defect.
- **No native tool-calling**: bare `pnpm naia-agent "hi"` fails with
  "registry.ollama.ai/library/gemma3n:e4b does not support tools". The
  `--no-tools` hint now surfaces this clearly.
- **Korean directly**: e4b produces Korean output without a thinking
  buffer — `안녕하세요! 😊` arrives on the first chunk.
- **Variability under recall pressure**: when persistent memory is
  active and the question paraphrases the stored fact, e4b sometimes
  reaches the answer (≈1/3 in our session live retries) and sometimes
  exhausts the recall-hop / tool-hop budget producing `[agent stopped
  — reached max tool-hop budget]`. That's why S8 was rewritten to
  assert SQLite mechanism, not model output.

### 24G — gemma4:31b

- **Thinking mode active by default.** Probed via raw HTTP to
  `/v1/chat/completions`:
  - `max_tokens=200` → `content: ""`, `finish_reason: length`
    (entire budget consumed by reasoning).
  - `max_tokens=2048` → `content: "안녕하세요!"` + separate
    `reasoning: "*   Language: Korean (한국어). *   Request: One
    sentence greeting (한 문장 인사)…"` (133 completion tokens).
  - `system: "Answer directly. Do not write any internal reasoning."`
    + `max_tokens=120` → `content: "안녕하세요!"`, clean. The system
    prompt *can* suppress reasoning but the model still emits it
    sometimes; the safe default for chat use is to raise
    `max_tokens` for the response budget so reasoning has room to
    finish.
- **VRAM tight at 24 GB.** GPU0 = 23952 MiB when loaded (Q4 default,
  near full). Practical implication: a single concurrent embedding
  model (bge-m3 ~1.5 GB) shares VRAM only if ollama swaps the
  reasoning context tightly — not measured under load.
- **Pull size**: 19.9 GB on disk (Q4-class). Approximately 5–10 min
  pull on a typical broadband connection (single-shot, host shared
  `~/.ollama` mount).
- **Scenarios not yet run** against 31b in this session. Honest gap.
  The 24-scenario harness (22 active + 2 honest defers) is model-agnostic
  but the LLM-live scenarios used e4b throughout. A follow-on round can
  re-run S6/S7/S8 with `--main "openai-compat|…|gemma4:31b"` to gather
  31b numbers — gated on the thinking-suppression unblock above (S20
  placeholder).

## What this means for the user

### Pick **8G** when

- The machine has only one small GPU (~8 GB) or is a laptop.
- "Communication / persona / show-and-tell" is enough.
- Marker discipline isn't critical (chat-only, no `<recall>`-driven
  flows); or `stripRecallResidue` is acceptable as best-effort.
- The user explicitly accepts the small-model limit (the project
  philosophy).

### Pick **24G** when

- A single RTX 3090 / 4090 / L4 / A4500 is available.
- Daily-driver chat or light coding is expected.
- Better marker discipline (Gemma 4 reasoning emits clean tokens
  *within* the budget) matters.
- The user is willing to give the bin a larger `max_tokens` to let
  thinking finish.

### Both share

- The same `naia-agent` CLI surface (`login`, `show`, `--memory`,
  `--no-tools`, `--no-default-system`, gateway routing via
  `--service`).
- The same memory model (`LiteMemoryProvider` + `<recall>` agent
  loop).
- The same security posture (no plaintext key on disk; OS keychain or
  env var only).
- The same upstream tier above (`48G` — production / RAG / live
  MiniCPM-o per `naia-model-infra/tiers/48g/`).

## Caveats for 31B usage

- **Default chat clients must allocate `max_tokens` for reasoning**.
  `VercelClient` / OpenAI-compat defaults vary; if responses look
  empty in a `--no-tools` chat, increase the per-turn budget or add a
  "Answer directly" system rider. naia-agent's `MEMORY_PERSONA`
  already says "Reply in the user's language; be concise" — that
  helps but doesn't suppress reasoning entirely.
- **No empirical SDLC measurement yet**. The user's daily-driver eval
  ranks 31B above 26B-A4B and Qwen 3.6 27B; SDLC artifact production
  (real code/specs) is not exercised by the 24-scenario harness and is
  documented Deferred. Plan: gate on `--service <strong-backend>` once
  a claude-code / strong-gateway path is configured.

## Next steps (Deferred / honest)

- Re-run the LLM-live scenarios (S6/S7/S8) against 31B to populate
  the 24G column with concrete numbers (currently "not yet measured").
- Investigate suppressing Gemma 4 thinking via ollama parameter or
  Modelfile customization (cleaner default chat experience).
- RBAC / Claude Code routing scenarios (current G3 covers routing
  wiring via `NAIA_AGENT_DRYRUN`; full subscription-backend flow
  requires Claude Code CLI auth).
- SDLC artifact production scenarios — pending a strong-model backend
  configuration (claude-code, or 48G `Qwen3-Coder` via gateway).

## Sources / measurements

- 8G live runs: every session interactive run in this thread
  (S6/S7/S8/S8-neg ✓ on e4b).
- 24G probes: `curl http://127.0.0.1:11434/v1/chat/completions` with
  `model: "gemma4:31b"` at `max_tokens` values 40/200/2048; GPU
  occupancy via `nvidia-smi`.
- Disk usage: `curl http://127.0.0.1:11434/api/tags` size field.
