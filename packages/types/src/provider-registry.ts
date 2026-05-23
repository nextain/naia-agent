/**
 * Provider Registry types — runtime-agnostic metadata for LLM providers.
 *
 * Adapted from naia-os `shell/src/lib/llm/types.ts`, stripped of UI-specific
 * fields (descKey, disabled). These types define the **provider catalogue**
 * that both naia-agent CLI and naia-os host consume.
 *
 * Design note: `ProviderMeta` is intentionally a plain data object. Auth
 * config, VercelClient wiring, and gateway routing live in the providers
 * package — not here. This file is zero-runtime-dep (types only).
 */

export type ModelCapability = "llm" | "omni" | "asr" | "stt" | "tts" | "vlm" | "world";

export interface VoiceMeta {
  id: string;
  label: string;
}

export interface ModelMeta {
  id: string;
  label: string;
  capabilities: ModelCapability[];
  /** Per-1M-token pricing: [input, output]. Undefined = free / unknown. */
  pricing?: [number, number];
  /** Omni: user can select voice. */
  voiceSelectable?: boolean;
  /** Omni: available voices. */
  voices?: VoiceMeta[];
  /** Omni: model provides input transcription. */
  transcriptProvided?: boolean;
}

export interface ProviderMeta {
  /** Unique identifier (e.g. "nextain", "anthropic"). */
  id: string;
  /** Human-readable name (e.g. "Naia Cloud"). */
  name: string;
  /** Brief description. */
  description: string;
  /** Whether this provider requires a user-supplied API key. */
  requiresApiKey: boolean;
  /** Whether this provider requires a Naia gateway key (gw-*) instead. */
  requiresNaiaKey?: boolean;
  /** Whether this provider runs locally (e.g. Ollama, vLLM). */
  isLocal?: boolean;
  /** Default model ID. */
  defaultModel: string;
  /** Statically known models. Empty = dynamic discovery via fetchModels. */
  models: ModelMeta[];
  /** Dynamic model discovery (Ollama / vLLM). Returns null if unreachable. */
  fetchModels?: (host: string) => Promise<ModelMeta[] | null>;
}
