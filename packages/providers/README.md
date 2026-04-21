# @nextain/agent-providers

LLMClient implementations for major providers.

**ESM-only, Node ≥ 22.** CJS consumers must use dynamic `import()`.

## Currently available

- `AnthropicClient` from `@nextain/agent-providers/anthropic` — wraps `@anthropic-ai/sdk`.

Future: OpenAI, Google, gateway (any-llm), Mock.

## Install

```bash
pnpm add @nextain/agent-providers @anthropic-ai/sdk
```

`@anthropic-ai/sdk` is a peerDependency — you install the version you want.

## Usage

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicClient } from "@nextain/agent-providers/anthropic";

const client = new AnthropicClient(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), {
  defaultModel: "claude-opus-4-7",
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

## Contract

`AnthropicClient implements LLMClient` — see [`@nextain/agent-types`](../types) for the contract definition.

**Provider-specific block variants**: `thinking`, `redacted_thinking` are Anthropic-origin. Other provider adapters (future) will map native content to the nearest known variant or drop at the adapter boundary — they do not add new union arms.

## License

Apache 2.0.
