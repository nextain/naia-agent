# @nextain/agent-providers

LLMClient implementations for naia-agent.

**ESM-only, Node ≥ 22.** CJS consumers must use dynamic `import()`.

## VercelClient — primary path (D44)

A single adapter wraps any [Vercel AI SDK](https://github.com/vercel/ai)
`LanguageModelV2` or `LanguageModelV3` instance — unlocks 50+ providers
through one path. The host picks the provider and injects the model;
naia-agent's runtime only knows the `LLMClient` contract.

The Vercel ecosystem is mid-migration between V2 and V3 spec; VercelClient
accepts both. Spec V4+ would require an adapter rewrite (surfaced via the
`vercel-providers-compat.integration.test.ts` smoke).

### Installation

For workspace consumers, the most common Vercel providers are already
installed automatically (see root `package.json` `dependencies`):

```
ai
@ai-sdk/anthropic
@ai-sdk/openai-compatible
@ai-sdk/google
zhipu-ai-provider
ai-sdk-provider-claude-code
```

For external library consumers (after `pnpm add @nextain/agent-providers`),
the Vercel SDK is a peer dependency — install whichever providers you need:

```bash
# Direct API key path (always-available providers)
pnpm add ai @ai-sdk/anthropic              # Anthropic
pnpm add ai @ai-sdk/openai                 # OpenAI
pnpm add ai @ai-sdk/google                 # Google Gemini
pnpm add ai @ai-sdk/openai-compatible      # vLLM / vllm-omni / LM Studio / Ollama / OpenRouter / etc.

# CLI subscription paths (no API key, uses your existing subscription)
pnpm add ai ai-sdk-provider-claude-code    # Claude Pro/Max
pnpm add ai ai-sdk-provider-codex-cli      # ChatGPT Plus/Pro
pnpm add ai ai-sdk-provider-gemini-cli     # Gemini Code Assist

# Naia Lab / community
pnpm add ai zhipu-ai-provider              # Z.ai coding plan / Zhipu GLM
pnpm add ai @runpod/ai-sdk-provider        # RunPod (vLLM/SGLang)
```

### Usage

```typescript
import { createAnthropic } from "@ai-sdk/anthropic";
import { VercelClient } from "@nextain/agent-providers/vercel";

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const client = new VercelClient(anthropic("claude-opus-4-7"), {
  defaultMaxTokens: 8192,
});

// Single-shot
const response = await client.generate({
  messages: [{ role: "user", content: "hello" }],
});

// Streaming
for await (const chunk of client.stream({
  messages: [{ role: "user", content: "tell me a story" }],
})) {
  if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
    process.stdout.write(chunk.delta.text);
  }
}
```

### Provider matrix (host-injected model factory)

| Provider | npm package | Auth | Notes |
|---|---|---|---|
| **Anthropic** | `@ai-sdk/anthropic` | `ANTHROPIC_API_KEY` | Direct API |
| **Anthropic on Vertex** | `@ai-sdk/anthropic` (Vertex mode) | gcloud ADC | `createVertexAnthropic({ project, location })` |
| **OpenAI** | `@ai-sdk/openai` | `OPENAI_API_KEY` | Direct API |
| **Google Gemini** | `@ai-sdk/google` | `GEMINI_API_KEY` | Direct API |
| **Google Vertex** | `@ai-sdk/google-vertex` | gcloud ADC | |
| **vLLM / LM Studio / Ollama / OpenRouter / etc.** | `@ai-sdk/openai-compatible` | per-server | `baseURL` override |
| **vllm-omni (text mode)** | `@ai-sdk/openai-compatible` | per-server | `/v1/chat/completions` |
| **Z.ai coding plan / Zhipu GLM** | `zhipu-ai-provider` | `ZAI_API_KEY` | `createZhipu({ baseURL: 'https://api.z.ai/api/paas/v4' })` |
| **Claude Pro/Max** | `ai-sdk-provider-claude-code` | none (uses `claude` CLI subscription) | See cross-platform notes |
| **ChatGPT Plus/Pro** | `ai-sdk-provider-codex-cli` | none (uses Codex CLI) | |
| **Gemini Code Assist** | `ai-sdk-provider-gemini-cli` | none (uses gemini-cli) | |
| **RunPod** | `@runpod/ai-sdk-provider` | `RUNPOD_API_KEY` | Supports vLLM/SGLang `baseURL` override |

### Cross-platform considerations

The Vercel AI SDK packages are pure JavaScript and work on Linux / macOS /
Windows. Special-case considerations:

- **CLI subscription providers** (`ai-sdk-provider-claude-code`,
  `-codex-cli`, `-gemini-cli`): wrap a host CLI binary that must be on
  `PATH`. Linux/macOS: install the CLI normally; Windows: use the
  `.cmd`/`.exe` shim from the official installer.
- **Flatpak / sandboxed environments**: a sandboxed naia-agent process
  may not see host-installed CLI binaries. Workarounds:
  1. Use a direct API key provider instead (`@ai-sdk/anthropic` etc.) —
     no host binary needed.
  2. Wrap the CLI invocation through `flatpak-spawn --host` (advanced).
  3. Route through `LabProxyClient` (Naia Lab Gateway, naiaKey) — no
     local CLI dependency.
- **Windows path quirks**: the SDK uses platform-aware path handling; no
  manual translation needed in user code. If you hit a quirk, file an
  issue against the specific community provider.

## Lab Proxy clients (Naia Lab Gateway, Vercel-independent)

Two clients route through the Naia Lab Gateway with `naiaKey` auth, kept
outside the Vercel adapter because they enforce HTTPS/WSS-only naiaKey
transport and embed gateway-specific routing rules:

- **`LabProxyClient`** — HTTPS, OpenAI-compat shape (`/chat/completions`).
- **`LabProxyLiveClient`** — WSS, vllm-omni `/v1/realtime` audio_delta path.

```typescript
import { LabProxyClient } from "@nextain/agent-providers/lab-proxy";

const client = new LabProxyClient({
  naiaKey: process.env.NAIA_LAB_KEY!,
  gatewayUrl: "https://gateway.naia.example",
  defaultModel: "claude-opus-4-7",
});
```

## Removed in Slice 5.x.4 (D44)

Five self-built clients were removed in favor of the Vercel-backed path:

| Removed | Replacement |
|---|---|
| `AnthropicClient` (`/anthropic`) | `VercelClient + @ai-sdk/anthropic` |
| `createAnthropicVertexClient` (`/anthropic-vertex`) | `VercelClient + @ai-sdk/anthropic` Vertex mode or `@ai-sdk/google-vertex` |
| `OpenAICompatClient` (`/openai-compat`) | `VercelClient + @ai-sdk/openai-compatible` |
| `GeminiClient` (`/gemini`) | `VercelClient + @ai-sdk/google` (or community `ai-sdk-provider-gemini-cli`) |
| `ClaudeCliClient` (`/claude-cli`) | `VercelClient + ai-sdk-provider-claude-code` |

See the project's `.agents/progress/vercel-ai-sdk-adoption-2026-04-29.md`
for the full migration rationale.

## Contract

All clients implement `LLMClient` — see [`@nextain/agent-types`](../types).

**Provider-specific block variants**: `thinking` / `redacted_thinking` are
Anthropic-origin. Vercel SDK reasoning content (V2 and V3) maps to
`thinking` blocks. Other providers map their native content to the
nearest known LLMContentBlock variant or drop at the adapter boundary —
no new union arms are added.

**Spec versions**: VercelClient accepts V2 (e.g. `@ai-sdk/anthropic@2.x`)
and V3 (`@ai-sdk/google@3.x`, `@ai-sdk/openai-compatible@2.x`,
`ai-sdk-provider-claude-code@3.x`, `zhipu-ai-provider@0.3.x`). V4+ is
not yet supported and surfaces as an explicit error.

## License

Apache 2.0.
