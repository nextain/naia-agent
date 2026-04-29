/**
 * Anthropic on Vertex AI provider.
 *
 * @deprecated Slice 5.x.3 (D44). Use `VercelClient` with `@ai-sdk/anthropic`
 *   in Vertex mode, or `@ai-sdk/google-vertex` if you prefer the Google
 *   credential path. Removed in Slice 5.x.5 (transitively — this module
 *   re-exports `AnthropicClient` which is itself deprecated).
 *
 *   ```ts
 *   import { createVertexAnthropic } from "@ai-sdk/anthropic/vertex";
 *   import { VercelClient } from "@nextain/agent-providers/vercel";
 *
 *   const vertex = createVertexAnthropic({
 *     project: process.env.VERTEX_PROJECT_ID!,
 *     location: process.env.VERTEX_REGION!,
 *   });
 *   const client = new VercelClient(vertex("claude-haiku-4-5@20251001"));
 *   ```
 *
 * Slice 1c history (legacy — kept until 5.x.5).
 *
 * Wraps @anthropic-ai/vertex-sdk's AnthropicVertex client into our LLMClient
 * contract. Reuses the same toSdkRequest/fromSdkResponse mappings as
 * AnthropicClient — Vertex SDK is API-compatible with the direct Anthropic SDK
 * for messages.create / messages.stream.
 *
 * Auth: Application Default Credentials (gcloud auth application-default
 * login) OR GOOGLE_APPLICATION_CREDENTIALS service account JSON. The Vertex
 * SDK + google-auth-library handle resolution.
 *
 * Required env (or constructor opts):
 *   - VERTEX_PROJECT_ID  (or GOOGLE_CLOUD_PROJECT)
 *   - VERTEX_REGION      (e.g. us-east5, us-central1)
 *
 * Model id format on Vertex differs from direct Anthropic — model strings
 * like "claude-haiku-4-5@20251001" or "claude-opus-4-5@20251022".
 */

import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { AnthropicClient, type AnthropicClientOptions } from "./anthropic.js";

/**
 * @deprecated Slice 5.x.3 (D44). Removed 5.x.5.
 */
export interface AnthropicVertexClientOptions extends AnthropicClientOptions {
  projectId?: string;
  region?: string;
}

/**
 * Create an LLMClient backed by Anthropic on Vertex AI.
 * Reuses AnthropicClient's request/response mapping by injecting the
 * Vertex SDK as the underlying client.
 *
 * @deprecated Slice 5.x.3 (D44). Use Vercel `@ai-sdk/anthropic` Vertex mode
 *   via `VercelClient`. Removed 5.x.5.
 */
export function createAnthropicVertexClient(
  options: AnthropicVertexClientOptions = {},
): AnthropicClient {
  const projectId =
    options.projectId ??
    process.env["VERTEX_PROJECT_ID"] ??
    process.env["GOOGLE_CLOUD_PROJECT"];
  const region =
    options.region ??
    process.env["VERTEX_REGION"] ??
    process.env["GOOGLE_CLOUD_LOCATION"];

  if (!projectId) {
    throw new Error(
      "AnthropicVertex: VERTEX_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is required",
    );
  }
  if (!region) {
    throw new Error(
      "AnthropicVertex: VERTEX_REGION (or GOOGLE_CLOUD_LOCATION) is required " +
        "(e.g. us-east5, us-central1)",
    );
  }

  const vertex = new AnthropicVertex({ projectId, region });
  // AnthropicVertex shares the messages API surface with @anthropic-ai/sdk's
  // Anthropic class. Cast through unknown to bridge slightly different type
  // hierarchies (vertex-sdk peer dep targets sdk >=0.50; we use 0.39).
  return new AnthropicClient(vertex as unknown as ConstructorParameters<typeof AnthropicClient>[0], options);
}
