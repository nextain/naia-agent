/**
 * Smoke test for @nextain/agent-providers/vercel — D44 §1 (Slice 5.x.1).
 *
 * Verifies that VercelClient wraps `LanguageModelV2` produced by
 * `@ai-sdk/anthropic` and satisfies the LLMClient contract end-to-end.
 *
 * Dry-run mode (no key): construct + interface-shape assertions only.
 * Live mode (ANTHROPIC_API_KEY present): real generate + stream round-trip.
 *
 * Run: pnpm smoke:vercel-anthropic
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { VercelClient } from "@nextain/agent-providers/vercel";
import type { StopReason } from "@nextain/agent-types";

const apiKey = process.env["ANTHROPIC_API_KEY"];
const modelId = process.env["ANTHROPIC_MODEL"] ?? "claude-haiku-4-5-20251001";

async function main(): Promise<void> {
  if (!apiKey) {
    console.log("━ dry-run (no ANTHROPIC_API_KEY) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    const anthropic = createAnthropic({ apiKey: "sk-ant-dry-run-noop" });
    const model = anthropic(modelId);
    const client = new VercelClient(model, { defaultMaxTokens: 1024 });

    const hasGenerate = typeof client.generate === "function";
    const hasStream = typeof client.stream === "function";
    console.log(`  VercelClient constructed: ✓`);
    console.log(`  provider:                  ${client.provider}`);
    console.log(`  modelId:                   ${client.modelId}`);
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
  console.log(`  model:    ${modelId}`);
  console.log(`  provider: vercel ai-sdk → @ai-sdk/anthropic`);

  const anthropic = createAnthropic({ apiKey });
  const model = anthropic(modelId);
  const client = new VercelClient(model, { defaultMaxTokens: 1024 });

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
    messages: [
      {
        role: "user",
        content: "Count from 1 to 3, one number per line, nothing else.",
      },
    ],
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

  console.log("\n✓ live smoke test passed (Vercel AI SDK → Anthropic)");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
