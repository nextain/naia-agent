import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GatewayRequestBudgetPolicy } from "./naia-pi-versioned-billing.js";

export const NAIA_PI_PROVIDER = "naia";
export const NAIA_PI_MODELS = [
  "grok-4.3",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "solar-pro4",
  "solar-mini",
  // Naver CLOVA canonical ids are uppercase (the gateway forwards them verbatim).
  "HCX-007",
  "HCX-DASH-002",
] as const;
export type NaiaPiModel = (typeof NAIA_PI_MODELS)[number];
// DeepSeek V4 now accepts tools on the gateway (deployed 2026-08-13,
// naia-shell#427), but the agent keeps them analysis-only until the team-profile
// composition guard + its contract tests are reworked (tracked separately).
// Solar is tool-capable and is intentionally absent here.
export const NAIA_PI_ANALYSIS_ONLY_MODELS: readonly NaiaPiModel[] = ["deepseek-v4-flash", "deepseek-v4-pro"];

// USD per 1M tokens. Operational Pi estimates use the 2026-08-04 Azure Korea Central
// rate-card snapshot plus the gateway's documented 1.10 customer multiplier. These
// estimates can enforce a local ceiling but never replace versioned gateway receipts.
const AZURE_CUSTOMER_COST = {
  grok43: { input: 1.375, output: 2.75, cacheRead: 1.375, cacheWrite: 1.375 },
  deepseekV4Flash: { input: 0.209, output: 0.561, cacheRead: 0.0308, cacheWrite: 0.209 },
} as const;

// Upstage Solar (direct provider). Final customer rates = source x 1.10.
const UPSTAGE_CUSTOMER_COST = {
  solarPro4: { input: 0.33, output: 1.32, cacheRead: 0.066, cacheWrite: 0.33 },
  solarMini: { input: 0.165, output: 0.165, cacheRead: 0.165, cacheWrite: 0.165 },
} as const;

// Naver CLOVA (direct provider, billed in KRW). These are ESTIMATES only — the
// gateway recomputes the USD price weekly from USD/KRW (naia-anyllm#66), so the
// authoritative cost is always the versioned gateway receipt, never this table.
// Snapshot @ ~1,417 KRW/USD, 2026-08-14. No cache discount (endpoint returns none).
const CLOVA_CUSTOMER_COST = {
  hcx007: { input: 0.97, output: 3.88, cacheRead: 0.97, cacheWrite: 0.97 },
  hcxDash002: { input: 0.388, output: 1.552, cacheRead: 0.388, cacheWrite: 0.388 },
} as const;

export function isNaiaPiModel(model: string | undefined): model is NaiaPiModel {
  // Case-insensitive on both sides: most ids are lowercase, but CLOVA ids
  // (HCX-007, HCX-DASH-002) are uppercase.
  return (
    typeof model === "string" &&
    (NAIA_PI_MODELS as readonly string[]).some((m) => m.toLowerCase() === model.toLowerCase())
  );
}

export function isNaiaPiAnalysisOnlyModel(model: string | undefined): model is NaiaPiModel {
  return isNaiaPiModel(model) && NAIA_PI_ANALYSIS_ONLY_MODELS.includes(model.toLowerCase() as NaiaPiModel);
}

export function normalizeNaiaGatewayBaseUrl(raw: string | undefined): string {
  const base = (raw?.trim() || "https://api.nextain.io").replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

/** Pi custom-provider configuration. It contains environment references only, never a Naia key. */
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
          { id: "HCX-007", name: "HyperCLOVA X HCX-007 (Naia / CLOVA, 국내)", reasoning: false, input: ["text"],
            cost: CLOVA_CUSTOMER_COST.hcx007, contextWindow: 128000, ...(maxTokens ? { maxTokens } : {}) },
          { id: "HCX-DASH-002", name: "HyperCLOVA X DASH (Naia / CLOVA, 국내)", reasoning: false, input: ["text"],
            cost: CLOVA_CUSTOMER_COST.hcxDash002, contextWindow: 32000, ...(maxTokens ? { maxTokens } : {}) },
        ],
      },
    },
  };
}

export function ensureNaiaPiConfig(opts: { dir?: string; baseUrl?: string; maxTokens?: number } = {}): string {
  const dir = opts.dir ?? join(homedir(), ".naia-agent", "pi");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, "models.json");
  const temp = join(dir, `.models.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(buildNaiaPiModelsConfig(opts.baseUrl, opts.maxTokens), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
  return dir;
}

const CHILD_ENV_ALLOWLIST = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec",
  "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "ProgramData",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
] as const;

/** Build a provider-isolated Pi environment without inheriting unrelated credentials. */
export function buildIsolatedPiChildEnv(source: NodeJS.ProcessEnv, configDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) if (source[key] !== undefined) env[key] = source[key];
  if (configDir) env["PI_CODING_AGENT_DIR"] = configDir;
  return env;
}

/** Build a child-only environment that cannot inherit unrelated provider credentials or global Pi routing. */
export function buildNaiaPiChildEnv(source: NodeJS.ProcessEnv, configDir: string, naiaApiKey: string,
  billing?: { readonly executionId: string; readonly receiptPath: string;
    readonly gatewayBudget: { readonly path: string; readonly policy: GatewayRequestBudgetPolicy } }): NodeJS.ProcessEnv {
  const env = buildIsolatedPiChildEnv(source, configDir);
  env["NAIA_API_KEY"] = naiaApiKey;
  if (billing) {
    env["NAIA_PI_EXECUTION_ID"] = billing.executionId;
    env["NAIA_PI_RECEIPT_PATH"] = billing.receiptPath;
    env["NAIA_PI_GATEWAY_BUDGET_PATH"] = billing.gatewayBudget.path;
    env["NAIA_PI_GATEWAY_BUDGET_POLICY"] = JSON.stringify(billing.gatewayBudget.policy);
  }
  return env;
}
