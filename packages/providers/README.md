# @nextain/agent-providers

LLMClient implementations for major providers.

**ESM-only, Node ≥ 22.** CJS consumers must use dynamic `import()`.

## Recommended: VercelClient (D44)

Single adapter wraps any [Vercel AI SDK](https://github.com/vercel/ai)
`LanguageModelV2` instance — unlocks 50+ providers (Anthropic / OpenAI /
Google / Vertex / OpenAI-compat for vLLM/LM Studio / zhipu / community CLI
providers / etc.) through one path. The host picks the provider and injects
the model; naia-agent's runtime only knows the `LLMClient` contract.

```bash
pnpm add @nextain/agent-providers ai @ai-sdk/anthropic
```

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

`ai` and `@ai-sdk/<provider>` are optional peerDependencies — you install
only the providers you actually use.

### Other providers via Vercel SDK

| Provider | Package |
|---|---|
| OpenAI | `@ai-sdk/openai` |
| Google | `@ai-sdk/google` |
| Vertex AI (Anthropic on GCP) | `@ai-sdk/anthropic` Vertex mode or `@ai-sdk/google-vertex` |
| OpenAI-compat (vLLM / LM Studio / Ollama / OpenRouter) | `@ai-sdk/openai-compatible` |
| Z.ai coding plan / GLM | `zhipu-ai-provider` (community) |
| Claude Pro/Max subscription | `ai-sdk-provider-claude-code` (community) |
| Gemini Code Assist subscription | `ai-sdk-provider-gemini-cli` (community) |
| ChatGPT Plus subscription | `ai-sdk-provider-codex-cli` (community) |
| RunPod (vLLM/SGLang) | `@runpod/ai-sdk-provider` |

## Lab Proxy clients (Vercel-independent — naiaKey 보호)

Two clients route through the Naia Lab Gateway with `naiaKey` auth, kept
outside the Vercel adapter because they enforce HTTPS/WSS-only naiaKey
transport and embed gateway-specific routing rules:

- `LabProxyClient` — HTTPS, OpenAI-compat shape (`/chat/completions`).
- `LabProxyLiveClient` — WSS, vllm-omni `/v1/realtime` audio_delta path.

```typescript
import { LabProxyClient } from "@nextain/agent-providers/lab-proxy";

const client = new LabProxyClient({
  naiaKey: process.env.NAIA_LAB_KEY!,
  gatewayUrl: "https://gateway.naia.example",
  defaultModel: "claude-opus-4-7",
});
```

## Deprecated (removed in Slice 5.x.5)

The following self-built providers are kept for transitional compatibility
and **emit `@deprecated` JSDoc warnings**:

- `AnthropicClient` (`/anthropic`) — superseded by `VercelClient + @ai-sdk/anthropic`
- `createAnthropicVertexClient` (`/anthropic-vertex`) — Vertex via `@ai-sdk/anthropic` or `@ai-sdk/google-vertex`
- `OpenAICompatClient` (`/openai-compat`) — superseded by `@ai-sdk/openai-compatible`
- `GeminiClient` (`/gemini`) — superseded by `@ai-sdk/google` or community `ai-sdk-provider-gemini-cli`
- `ClaudeCliClient` (`/claude-cli`) — superseded by community `ai-sdk-provider-claude-code`

See `.agents/progress/vercel-ai-sdk-adoption-2026-04-29.md` for the
migration plan and rationale.

## Contract

All clients implement `LLMClient` — see
[`@nextain/agent-types`](../types) for the contract definition.

**Provider-specific block variants**: `thinking`, `redacted_thinking` are
Anthropic-origin. Vercel SDK `LanguageModelV2` reasoning content maps to
`thinking` blocks (no `signature` field — V2 doesn't expose Anthropic's
thought signature). Other provider adapters map native content to the
nearest known variant or drop at the adapter boundary — they do not add
new union arms.

## License

Apache 2.0.
