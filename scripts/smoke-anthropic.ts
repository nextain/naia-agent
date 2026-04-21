/**
 * Smoke test for @nextain/agent-providers/anthropic.
 *
 * MVM #3b (integration stand-in for shell integration): verify that
 * `AnthropicClient` can be constructed, implements `LLMClient`, and — when
 * `ANTHROPIC_API_KEY` is set — makes an actual request/stream to the API.
 *
 * CI runs the dry-run path (no API key). Developers can set the key locally
 * to exercise the live path.
 *
 * Run: pnpm smoke:anthropic
 */

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicClient } from "@nextain/agent-providers/anthropic";
import type { StopReason } from "@nextain/agent-types";

const apiKey = process.env["ANTHROPIC_API_KEY"];
const model = process.env["ANTHROPIC_MODEL"] ?? "claude-haiku-4-5-20251001";

async function main(): Promise<void> {
  if (!apiKey) {
    console.log("━ dry-run (no ANTHROPIC_API_KEY) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    // Use a properly-prefixed placeholder so that future SDK versions with
    // format validation won't break the dry-run path.
    const sdk = new Anthropic({ apiKey: "sk-ant-dry-run-noop" });
    const client = new AnthropicClient(sdk, { defaultModel: model });

    const hasGenerate = typeof client.generate === "function";
    const hasStream = typeof client.stream === "function";
    console.log(`  AnthropicClient constructed: ✓`);
    console.log(`  implements LLMClient.generate: ${hasGenerate ? "✓" : "✗"}`);
    console.log(`  implements LLMClient.stream:   ${hasStream ? "✓" : "✗"}`);

    if (!hasGenerate || !hasStream) {
      console.error("FAIL: client does not satisfy LLMClient shape");
      process.exit(1);
    }
    console.log("\n✓ dry-run passed");
    return;
  }

  console.log("━ live call (ANTHROPIC_API_KEY present) ━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  model: ${model}`);
  const sdk = new Anthropic({ apiKey });
  const client = new AnthropicClient(sdk, { defaultModel: model });

  console.log("\n[generate]");
  const response = await client.generate({
    messages: [{ role: "user", content: "Reply with exactly the word 'pong'." }],
    maxTokens: 20,
  });
  console.log(`  stopReason: ${response.stopReason}`);
  console.log(`  content:    ${JSON.stringify(response.content)}`);
  console.log(`  usage:      ${JSON.stringify(response.usage)}`);

  console.log("\n[stream]");
  process.stdout.write("  text: ");
  let streamedText = "";
  let finalStopReason: StopReason | undefined;
  let finalUsage: unknown;
  for await (const chunk of client.stream({
    messages: [{ role: "user", content: "Count from 1 to 3, one number per line, nothing else." }],
    maxTokens: 50,
  })) {
    if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
      process.stdout.write(chunk.delta.text);
      streamedText += chunk.delta.text;
    }
    if (chunk.type === "end") {
      finalStopReason = chunk.stopReason;
      finalUsage = chunk.usage;
    }
  }
  console.log(`\n  stopReason: ${finalStopReason}`);
  console.log(`  usage:      ${JSON.stringify(finalUsage)}`);

  if (!streamedText) {
    console.error("FAIL: stream produced no text");
    process.exit(1);
  }

  console.log("\n✓ live smoke test passed");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
