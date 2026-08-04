import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GatewayRequestBudgetPolicy } from "./naia-pi-versioned-billing.js";

export const NAIA_PI_PROVIDER = "naia";
export const NAIA_PI_MODELS = ["grok-4.3", "deepseek-v4-flash", "deepseek-v4-pro"] as const;
export type NaiaPiModel = (typeof NAIA_PI_MODELS)[number];
export const NAIA_PI_ANALYSIS_ONLY_MODELS: readonly NaiaPiModel[] = ["deepseek-v4-flash", "deepseek-v4-pro"];

export function isNaiaPiModel(model: string | undefined): model is NaiaPiModel {
  return typeof model === "string" && (NAIA_PI_MODELS as readonly string[]).includes(model.toLowerCase());
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
          { id: "grok-4.3", name: "Grok 4.3 (Naia / Azure)", reasoning: false, input: ["text"], contextWindow: 200000, ...(maxTokens ? { maxTokens } : {}) },
          { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (Naia / Azure, no tools)", reasoning: false, input: ["text"], contextWindow: 128000, ...(maxTokens ? { maxTokens } : {}) },
          { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro (Naia / Azure, no tools)", reasoning: false, input: ["text"], contextWindow: 1000000, ...(maxTokens ? { maxTokens } : {}) },
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

/** Build a child-only environment that cannot inherit unrelated provider credentials or global Pi routing. */
export function buildNaiaPiChildEnv(source: NodeJS.ProcessEnv, configDir: string, naiaApiKey: string,
  billing?: { readonly executionId: string; readonly receiptPath: string;
    readonly gatewayBudget: { readonly path: string; readonly policy: GatewayRequestBudgetPolicy } }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) if (source[key] !== undefined) env[key] = source[key];
  env["PI_CODING_AGENT_DIR"] = configDir;
  env["NAIA_API_KEY"] = naiaApiKey;
  if (billing) {
    env["NAIA_PI_EXECUTION_ID"] = billing.executionId;
    env["NAIA_PI_RECEIPT_PATH"] = billing.receiptPath;
    env["NAIA_PI_GATEWAY_BUDGET_PATH"] = billing.gatewayBudget.path;
    env["NAIA_PI_GATEWAY_BUDGET_POLICY"] = JSON.stringify(billing.gatewayBudget.policy);
  }
  return env;
}
