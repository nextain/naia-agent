/**
 * Provider Registry — canonical catalogue of LLM providers and models.
 *
 * Migrated from naia-os `shell/src/lib/llm/registry.ts` (Slice 4-P1, #59).
 * This is the single source of truth for provider metadata used by:
 *   - naia-agent CLI (login model selection, `providers` subcommand)
 *   - naia-os Host (settings UI reads via import)
 *
 * Provider wiring (VercelClient / LabProxyClient construction) lives in the
 * host or bin entry point — this module is pure data + optional fetch helpers.
 */

import type { ProviderMeta, ModelMeta } from "@nextain/agent-types";

// ─── Voice presets ──────────────────────────────────────────────────────────

const GEMINI_LIVE_VOICES = [
  { id: "Kore", label: "Kore (여성, 부드러움)" },
  { id: "Puck", label: "Puck (남성, 익살)" },
  { id: "Charon", label: "Charon (남성)" },
  { id: "Aoede", label: "Aoede (여성)" },
  { id: "Fenrir", label: "Fenrir (남성)" },
  { id: "Leda", label: "Leda (여성)" },
  { id: "Orus", label: "Orus (남성)" },
  { id: "Zephyr", label: "Zephyr (중성)" },
];

// ─── Provider definitions ───────────────────────────────────────────────────

const PROVIDERS: ProviderMeta[] = [
  {
    id: "nextain",
    name: "Naia",
    description: "Naia Cloud — no API key needed.",
    requiresApiKey: false,
    requiresNaiaKey: true,
    defaultModel: "gemini-2.5-flash",
    models: [
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", capabilities: ["llm"], pricing: [1.815, 10.89] },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview", capabilities: ["llm"], pricing: [2.2, 13.2] },
      { id: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite Preview", capabilities: ["llm"], pricing: [0.275, 1.65] },
      { id: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview", capabilities: ["llm"], pricing: [0.55, 3.3] },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", capabilities: ["llm"], pricing: [1.375, 11.0] },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", capabilities: ["llm"], pricing: [0.33, 2.75] },
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", capabilities: ["llm"], pricing: [0.11, 0.44] },
      {
        id: "gemini-2.5-flash-live",
        label: "Gemini 2.5 Flash Live (실시간)",
        capabilities: ["llm", "omni"],
        voiceSelectable: true,
        voices: [...GEMINI_LIVE_VOICES],
        transcriptProvided: true,
      },
      {
        id: "naia-24g-live",
        label: "Naia Live 1.0",
        capabilities: ["llm", "omni"],
        voiceSelectable: true,
        voices: [{ id: "alloy", label: "Naia Korean (여성)" }],
        transcriptProvided: true,
        pricing: [0.39, 0],
      },
    ],
  },
  {
    id: "claude-code-cli",
    name: "Claude Code",
    description: "Claude Code CLI — uses local Claude installation.",
    requiresApiKey: false,
    defaultModel: "claude-sonnet-4-6",
    models: [
      { id: "claude-opus-4-6", label: "Claude Opus 4.6", capabilities: ["llm"] },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", capabilities: ["llm"] },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", capabilities: ["llm"] },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    description: "Google Gemini API — requires Google API key.",
    requiresApiKey: true,
    defaultModel: "gemini-2.5-flash",
    models: [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", capabilities: ["llm"], pricing: [1.25, 10.0] },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", capabilities: ["llm"], pricing: [0.3, 2.5] },
      {
        id: "gemini-2.5-flash-live",
        label: "Gemini 2.5 Flash Live (실시간)",
        capabilities: ["llm", "omni"],
        voiceSelectable: true,
        voices: [...GEMINI_LIVE_VOICES],
        transcriptProvided: true,
      },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "OpenAI GPT models — requires OpenAI API key.",
    requiresApiKey: true,
    defaultModel: "gpt-4o",
    models: [
      { id: "gpt-4o", label: "GPT-4o", capabilities: ["llm"], pricing: [2.5, 10.0] },
      {
        id: "gemini-2.5-flash-live",
        label: "Gemini 2.5 Flash Live (실시간)",
        capabilities: ["llm", "omni"],
        voiceSelectable: true,
        voices: [...GEMINI_LIVE_VOICES],
        transcriptProvided: true,
      },
      {
        id: "naia-24g-live",
        label: "Naia Live 1.0",
        capabilities: ["llm", "omni"],
        voiceSelectable: true,
        voices: [{ id: "alloy", label: "Naia Korean (여성)" }],
        transcriptProvided: true,
      },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude models — requires Anthropic API key.",
    requiresApiKey: true,
    defaultModel: "claude-sonnet-4-6",
    models: [
      { id: "claude-opus-4-6", label: "Claude Opus 4.6", capabilities: ["llm"], pricing: [15.0, 75.0] },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", capabilities: ["llm"], pricing: [3.0, 15.0] },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", capabilities: ["llm"], pricing: [0.8, 4.0] },
    ],
  },
  {
    id: "xai",
    name: "xAI",
    description: "Grok models — requires xAI API key.",
    requiresApiKey: true,
    defaultModel: "grok-3-mini",
    models: [
      { id: "grok-3-mini", label: "Grok 3 Mini", capabilities: ["llm"], pricing: [0.3, 0.5] },
    ],
  },
  {
    id: "zai",
    name: "Z.AI",
    description: "GLM models via Z.AI — requires Z.AI API key.",
    requiresApiKey: true,
    defaultModel: "glm-5.1",
    models: [
      { id: "glm-5.1", label: "GLM 5.1", capabilities: ["llm"] },
      { id: "glm-5-turbo", label: "GLM 5 Turbo", capabilities: ["llm"] },
      { id: "glm-4.7", label: "GLM 4.7", capabilities: ["llm"] },
      { id: "glm-4.5-air", label: "GLM 4.5 Air", capabilities: ["llm"] },
    ],
  },
  {
    id: "ollama",
    name: "Ollama",
    description: "Local Ollama models — no API key.",
    requiresApiKey: false,
    isLocal: true,
    defaultModel: "",
    models: [],
    async fetchModels(host) {
      try {
        const resp = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) return null;
        const data = await resp.json() as { models?: { name: string; size?: number; details?: { quantization_level?: string; parameter_size?: string } }[] };
        return (data.models ?? []).map((m) => {
          const sizeGB = m.size ? `${(m.size / 1e9).toFixed(1)}GB` : "";
          const quant = m.details?.quantization_level ?? "";
          const params = m.details?.parameter_size ?? "";
          const extra = [params, sizeGB, quant].filter(Boolean).join(", ");
          return { id: m.name, label: extra ? `${m.name} (${extra})` : m.name, capabilities: ["llm"] as const };
        });
      } catch { return null; }
    },
  },
  {
    id: "vllm",
    name: "vLLM",
    description: "Local vLLM server — OpenAI-compatible, no API key.",
    requiresApiKey: false,
    isLocal: true,
    defaultModel: "",
    models: [],
    async fetchModels(host) {
      try {
        const resp = await fetch(`${host}/v1/models`, { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) return null;
        const data = await resp.json() as { data?: { id: string }[] };
        return (data.data ?? []).map((m) => {
          const mid = m.id.toLowerCase();
          const isAsr = mid.includes("asr") || mid.includes("whisper");
          const isOmni = mid.includes("minicpm-o") || mid.includes("minicpmo");
          return {
            id: m.id,
            label: isOmni ? `${m.id} (실시간)` : m.id,
            capabilities: (isAsr ? ["asr"] : isOmni ? ["llm", "omni"] : ["llm"]) as ("llm" | "omni" | "asr")[],
          };
        });
      } catch { return null; }
    },
  },
];

// ─── Lookup helpers ─────────────────────────────────────────────────────────

const PROVIDER_MAP = new Map(PROVIDERS.map((p) => [p.id, p]));

export function listProviders(): ProviderMeta[] {
  return [...PROVIDERS];
}

export function getProvider(id: string): ProviderMeta | undefined {
  return PROVIDER_MAP.get(id);
}

export function getProviderModels(providerId: string): ModelMeta[] {
  return PROVIDER_MAP.get(providerId)?.models ?? [];
}

export function getDefaultModel(providerId: string): string {
  return PROVIDER_MAP.get(providerId)?.defaultModel ?? "";
}

// ─── Gateway pricing fetch ──────────────────────────────────────────────────

export const DEFAULT_GATEWAY_HTTP_URL =
  "https://naia-gateway-181404717065.asia-northeast3.run.app";

interface GatewayPricingEntry {
  model_key: string;
  input_price_per_million: number;
  output_price_per_million: number;
  cached_price_per_million: number | null;
}

/**
 * Fetch live pricing from the Naia gateway and return updated Naia model list.
 * Returns null if gateway is unreachable (caller should keep static pricing).
 */
export async function fetchNaiaPricing(
  gatewayHttpUrl = DEFAULT_GATEWAY_HTTP_URL,
): Promise<ModelMeta[] | null> {
  try {
    const resp = await fetch(`${gatewayHttpUrl}/v1/pricing`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const entries: GatewayPricingEntry[] = await resp.json();

    const provider = PROVIDER_MAP.get("nextain");
    if (!provider) return null;

    const pricingMap = new Map<string, [number, number]>();
    for (const entry of entries) {
      if (!entry.model_key.startsWith("vertexai:")) continue;
      const modelId = entry.model_key.replace("vertexai:", "");
      pricingMap.set(modelId, [entry.input_price_per_million, entry.output_price_per_million]);
    }

    return provider.models.map((m) => {
      const live = pricingMap.get(m.id);
      return live ? { ...m, pricing: live } : { ...m };
    });
  } catch {
    return null;
  }
}

/**
 * Fetch available models from a gateway's OpenAI-compat /v1/models endpoint.
 * Useful for discovering what models the gateway currently serves.
 */
export async function fetchGatewayModels(
  gatewayHttpUrl = DEFAULT_GATEWAY_HTTP_URL,
): Promise<string[] | null> {
  try {
    const resp = await fetch(`${gatewayHttpUrl}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { data?: { id: string }[] };
    return (data.data ?? []).map((m) => m.id);
  } catch {
    return null;
  }
}

/**
 * Migrate a saved model that's no longer registered.
 * Returns { migrate: false } if valid, { migrate: true, to } if deprecated.
 */
export function shouldMigrateNextainModel(
  providerId: string,
  modelId: string,
): { migrate: false } | { migrate: true; to: string } {
  if (providerId !== "nextain") return { migrate: false };
  const provider = PROVIDER_MAP.get(providerId);
  if (!provider) return { migrate: false };
  if (provider.models.some((m) => m.id === modelId)) return { migrate: false };
  return { migrate: true, to: provider.defaultModel };
}
