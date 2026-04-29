/**
 * @nextain/agent-providers — LLMClient implementations.
 *
 * Active clients (Slice 5.x.4):
 *   - VercelClient    — wraps any Vercel AI SDK LanguageModelV2 (50+ providers)
 *   - LabProxyClient  — Naia Lab Gateway HTTPS (naiaKey)
 *   - LabProxyLiveClient — Naia Lab Gateway WSS (vllm-omni /v1/realtime)
 *
 * Removed in Slice 5.x.4 (D44 — Vercel AI SDK adoption):
 *   AnthropicClient, createAnthropicVertexClient, OpenAICompatClient,
 *   GeminiClient, ClaudeCliClient.
 *   See docs/migration-vercel.md (or CHANGELOG Slice 5.x.4 entry) for
 *   per-provider replacement instructions through `VercelClient`.
 */

export { LabProxyClient, toGatewayModel, LAB_PROXY_DEFAULT_GATEWAY_URL } from "./lab-proxy.js";
export type { LabProxyClientOptions } from "./lab-proxy.js";
export { LabProxyLiveClient, LAB_PROXY_LIVE_DEFAULT_GATEWAY_WS_URL } from "./lab-proxy-live.js";
export type { LabProxyLiveClientOptions } from "./lab-proxy-live.js";
export { VercelClient } from "./vercel-client.js";
export type { VercelClientOptions } from "./vercel-client.js";
