import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureGatewayPricing } from "./gateway-pricing.js";

export const NAIA_PI_PROVIDER = "naia";
export const NAIA_PI_MODELS = [
  "grok-4.3",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "solar-pro4",
  "solar-mini",
  "motif-3",
  // Naver CLOVA canonical ids are uppercase (the gateway forwards them verbatim).
  "HCX-007",
  "HCX-DASH-002",
] as const;
export type NaiaPiModel = (typeof NAIA_PI_MODELS)[number];

export interface ModelCustomerCostRate {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

// USD per 1M tokens. Operational estimates use the 2026-08-04 Azure Korea Central
// rate-card snapshot plus the gateway's documented 1.10 customer multiplier. These
// estimates can enforce a local ceiling but never replace versioned gateway receipts.
export const AZURE_CUSTOMER_COST = {
  grok43: { input: 1.375, output: 2.75, cacheRead: 1.375, cacheWrite: 1.375 },
  deepseekV4Flash: { input: 0.209, output: 0.561, cacheRead: 0.0308, cacheWrite: 0.209 },
} as const;

// Upstage Solar (direct provider). Final customer rates = source x 1.10.
export const UPSTAGE_CUSTOMER_COST = {
  solarPro4: { input: 0.33, output: 1.32, cacheRead: 0.066, cacheWrite: 0.33 },
  solarMini: { input: 0.165, output: 0.165, cacheRead: 0.165, cacheWrite: 0.165 },
} as const;

// Naver CLOVA (direct provider, billed in KRW). These are ESTIMATES only — the
// gateway recomputes the USD price weekly from USD/KRW (naia-anyllm#66), so the
// authoritative cost is always the versioned gateway receipt, never this table.
// Snapshot @ ~1,417 KRW/USD, 2026-08-14. No cache discount (endpoint returns none).
export const CLOVA_CUSTOMER_COST = {
  hcx007: { input: 0.97, output: 3.88, cacheRead: 0.97, cacheWrite: 0.97 },
  hcxDash002: { input: 0.388, output: 1.552, cacheRead: 0.388, cacheWrite: 0.388 },
} as const;

// Motif 3 (MorphFactory CBT). Customer prices are the gateway's source rates × 1.30.
export const MOTIF_CUSTOMER_COST = {
  input: 0.26,
  output: 1.04,
  cacheRead: 0.052,
  cacheWrite: 0.26,
} as const;

export const NAIA_MODEL_METADATA: Readonly<Record<NaiaPiModel, {
  readonly name: string;
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly defaultMaxTokens?: number;
  readonly cost?: ModelCustomerCostRate;
}>> = {
  "grok-4.3": {
    name: "Grok 4.3 (Naia / Azure)",
    reasoning: false,
    contextWindow: 200000,
    cost: AZURE_CUSTOMER_COST.grok43,
  },
  "deepseek-v4-flash": {
    name: "DeepSeek V4 Flash (Naia / Azure, analysis)",
    reasoning: false,
    contextWindow: 128000,
    cost: AZURE_CUSTOMER_COST.deepseekV4Flash,
  },
  "deepseek-v4-pro": {
    name: "DeepSeek V4 Pro (Naia / Azure, analysis)",
    reasoning: false,
    contextWindow: 1000000,
  },
  "solar-pro4": {
    name: "Solar Pro 4 (Naia / Upstage, 국내)",
    reasoning: false,
    contextWindow: 128000,
    cost: UPSTAGE_CUSTOMER_COST.solarPro4,
  },
  "solar-mini": {
    name: "Solar Mini (Naia / Upstage, 국내)",
    reasoning: false,
    contextWindow: 32000,
    cost: UPSTAGE_CUSTOMER_COST.solarMini,
  },
  "motif-3": {
    name: "Motif 3 (Naia / Motif, 국내 CBT)",
    reasoning: true,
    contextWindow: 262144,
    defaultMaxTokens: 8192,
    cost: MOTIF_CUSTOMER_COST,
  },
  "HCX-007": {
    name: "HyperCLOVA X HCX-007 (Naia / CLOVA, 국내)",
    reasoning: false,
    contextWindow: 128000,
    cost: CLOVA_CUSTOMER_COST.hcx007,
  },
  "HCX-DASH-002": {
    name: "HyperCLOVA X DASH (Naia / CLOVA, 국내)",
    reasoning: false,
    contextWindow: 32000,
    cost: CLOVA_CUSTOMER_COST.hcxDash002,
  },
};

export function normalizeNaiaGatewayModel(model: string | undefined): NaiaPiModel | undefined {
  if (typeof model !== "string") return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === "dash-002") return "HCX-DASH-002";
  return NAIA_PI_MODELS.find((m) => m.toLowerCase() === lower);
}

export function isNaiaPiModel(model: string | undefined): model is NaiaPiModel {
  return normalizeNaiaGatewayModel(model) !== undefined;
}

export function estimateNaiaModelCostUsd(
  model: string | undefined,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): number | undefined {
  const canonical = normalizeNaiaGatewayModel(model);
  if (!canonical) return undefined;
  const cost = NAIA_MODEL_METADATA[canonical].cost;
  if (!cost) return undefined;
  return (
    Math.max(0, uncachedInputTokens) * cost.input +
    Math.max(0, cachedInputTokens) * cost.cacheRead +
    Math.max(0, outputTokens) * cost.output
  ) / 1_000_000;
}

export function normalizeNaiaGatewayBaseUrl(raw: string | undefined): string {
  const base = (raw?.trim() || "https://api.nextain.io").replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

/** Custom-provider configuration. Contains environment references only, never a Naia key. */
export function buildNaiaPiModelsConfig(baseUrl?: string, maxTokens?: number): Record<string, unknown> {
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) throw new Error("Pi maxTokens must be positive");
  return {
    providers: {
      [NAIA_PI_PROVIDER]: {
        baseUrl: normalizeNaiaGatewayBaseUrl(baseUrl),
        api: "openai-completions",
        apiKey: "$NAIA_API_KEY",
        authHeader: false,
        headers: { "X-AnyLLM-Key": "Bearer $NAIA_API_KEY" },
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [
          { id: "grok-4.3", name: "Grok 4.3 (Naia / Azure)", reasoning: false, input: ["text"],
            cost: AZURE_CUSTOMER_COST.grok43, contextWindow: 200000, ...(maxTokens ? { maxTokens } : {}) },
          { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (Naia / Azure, analysis)", reasoning: false,
            input: ["text"], cost: AZURE_CUSTOMER_COST.deepseekV4Flash,
            contextWindow: 128000, ...(maxTokens ? { maxTokens } : {}) },
          { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro (Naia / Azure, analysis)", reasoning: false, input: ["text"], contextWindow: 1000000, ...(maxTokens ? { maxTokens } : {}) },
          { id: "solar-pro4", name: "Solar Pro 4 (Naia / Upstage, 국내)", reasoning: false, input: ["text"],
            cost: UPSTAGE_CUSTOMER_COST.solarPro4, contextWindow: 128000, ...(maxTokens ? { maxTokens } : {}) },
          { id: "solar-mini", name: "Solar Mini (Naia / Upstage, 국내)", reasoning: false, input: ["text"],
            cost: UPSTAGE_CUSTOMER_COST.solarMini, contextWindow: 32000, ...(maxTokens ? { maxTokens } : {}) },
          { id: "motif-3", name: "Motif 3 (Naia / Motif, 국내 CBT)", reasoning: true, input: ["text"],
            cost: MOTIF_CUSTOMER_COST, contextWindow: 262144, maxTokens: maxTokens ?? 8192 },
          { id: "HCX-007", name: "HyperCLOVA X HCX-007 (Naia / CLOVA, 국내)", reasoning: false, input: ["text"],
            cost: CLOVA_CUSTOMER_COST.hcx007, contextWindow: 128000, ...(maxTokens ? { maxTokens } : {}) },
          { id: "HCX-DASH-002", name: "HyperCLOVA X DASH (Naia / CLOVA, 국내)", reasoning: false, input: ["text"],
            cost: CLOVA_CUSTOMER_COST.hcxDash002, contextWindow: 32000, ...(maxTokens ? { maxTokens } : {}) },
        ],
      },
    },
  };
}

/**
 * Codex 0.163.0 model_catalog_json entry builder.
 * Enforces the 4 mandatory fields (Doc L131):
 * - use_responses_lite: false
 * - tool_mode: "direct"
 * - experimental_supported_tools: []
 * - supports_search_tool: false
 * And for noTools: true (Doc L138):
 * - shell_type: "disabled"
 * - apply_patch_tool_type: null
 * - input_modalities: ["text"]
 *
 * Why apply_patch_tool_type is always `null` (including tool-enabled catalog entries):
 * codex-cli 0.163.0 deserializes `apply_patch_tool_type` into Rust `Option<ApplyPatchToolType>`
 * (`#[serde(rename_all = "snake_case")] enum ApplyPatchToolType { Freeform }`), which only
 * accepts `"freeform"` or `null` (rejecting `"function"` with an unknown-variant error).
 * Naia gateway / OpenAI-compatible chat-completions bridges reject Codex's non-standard
 * `"freeform"` custom grammar tool schema unless native patch tools are disabled (`null`).
 */
export function buildCodexModelCatalogEntry(opts: {
  readonly slug: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly contextWindow: number;
  readonly noTools?: boolean;
}): Record<string, unknown> {
  const noTools = opts.noTools === true;
  return {
    slug: opts.slug,
    display_name: opts.displayName ?? opts.slug,
    description: opts.description ?? `${opts.displayName ?? opts.slug} via Naia Codex bridge`,
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: noTools ? "disabled" : "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    availability_nux: null,
    upgrade: null,
    base_instructions: "You are a helpful coding assistant.",
    model_messages: null,
    supports_reasoning_summaries: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: "text",
    truncation_policy: { mode: "bytes", limit: 10000 },
    supports_parallel_tool_calls: !noTools,
    supports_image_detail_original: false,
    context_window: opts.contextWindow,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text"],
    supports_search_tool: false,
    use_responses_lite: false,
    tool_mode: "direct",
  };
}

export function buildNaiaCodexModelCatalog(opts?: {
  readonly noTools?: boolean;
}): { readonly models: Record<string, unknown>[] } {
  const noTools = opts?.noTools === true;
  const models: Record<string, unknown>[] = NAIA_PI_MODELS.map((slug) => {
    const meta = NAIA_MODEL_METADATA[slug];
    return buildCodexModelCatalogEntry({
      slug,
      displayName: meta.name,
      contextWindow: meta.contextWindow,
      noTools,
    });
  });
  models.push(
    buildCodexModelCatalogEntry({
      slug: "DASH-002",
      displayName: NAIA_MODEL_METADATA["HCX-DASH-002"].name,
      contextWindow: NAIA_MODEL_METADATA["HCX-DASH-002"].contextWindow,
      noTools,
    }),
  );
  return { models };
}

export function writeCodexModelCatalogFile(
  dir: string,
  catalog: { readonly models: Record<string, unknown>[] },
  filename = "codex-model-catalog.json",
): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, filename);
  const temp = join(dir, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(catalog, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
  return target;
}

/**
 * 8 mandatory feature disable flags when noTools: true (Doc L138).
 * Combined with bridge stripping of tools/tool_choice/parallel_tool_calls/additional_tools.
 */
export const CODEX_NO_TOOLS_CONFIG_FLAGS = [
  "-c", "features.shell_tool=false",
  "-c", "features.unified_exec=false",
  "-c", "features.multi_agent=false",
  "-c", "features.multi_agent_v2=false",
  "-c", "features.goals=false",
  "-c", "features.view_image=false",
  "-c", 'web_search="disabled"',
  "-c", "mcp_servers={}",
] as const;

export function ensureNaiaPiConfig(opts: { dir?: string; baseUrl?: string; maxTokens?: number; noTools?: boolean } = {}): string {
  // Refresh the live pricing overlay so usage displays never fall back to a stale/absent static price.
  void ensureGatewayPricing(opts.baseUrl);
  const dir = opts.dir ?? join(homedir(), ".naia-agent", "pi");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, "models.json");
  const temp = join(dir, `.models.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(buildNaiaPiModelsConfig(opts.baseUrl, opts.maxTokens), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
  writeCodexModelCatalogFile(
    dir,
    buildNaiaCodexModelCatalog({ noTools: opts.noTools }),
    opts.noTools ? "codex-model-catalog-notools.json" : "codex-model-catalog.json",
  );
  return dir;
}

const CHILD_ENV_ALLOWLIST = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec",
  "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "ProgramData",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
] as const;

/** Build a provider-isolated environment without inheriting unrelated credentials. */
export function buildIsolatedPiChildEnv(source: NodeJS.ProcessEnv, configDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) if (source[key] !== undefined) env[key] = source[key];
  if (configDir) env["PI_CODING_AGENT_DIR"] = configDir;
  return env;
}
