import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildIsolatedPiChildEnv } from "./naia-pi-provider.js";

export interface UserOwnedPiModel {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface UserOwnedPiProvider {
  readonly id: string;
  readonly baseUrl: string;
  readonly models: readonly UserOwnedPiModel[];
}

export function isUserOwnedPiBinding(config: UserOwnedPiProvider | undefined,
  binding: { readonly provider: string; readonly model: string }): boolean {
  return config !== undefined && binding.provider === config.id
    && config.models.some((model) => model.id === binding.model);
}

export function buildUserOwnedPiModelsConfig(config: UserOwnedPiProvider): Record<string, unknown> {
  assertUserOwnedPiProvider(config);
  return { providers: { [config.id]: {
    baseUrl: normalizeLoopbackBaseUrl(config.baseUrl),
    api: "openai-completions",
    apiKey: "local-no-auth",
    authHeader: false,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: config.models.map((model) => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      reasoning: false,
      input: ["text"],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  } } };
}

export function ensureUserOwnedPiConfig(config: UserOwnedPiProvider, dir?: string): string {
  const targetDir = dir ?? join(homedir(), ".naia-agent", "pi", "user-owned", config.id);
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const target = join(targetDir, "models.json");
  const temp = join(targetDir, `.models.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(buildUserOwnedPiModelsConfig(config), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
  return targetDir;
}

export function buildUserOwnedPiChildEnv(source: NodeJS.ProcessEnv, configDir: string): NodeJS.ProcessEnv {
  return buildIsolatedPiChildEnv(source, configDir);
}

function assertUserOwnedPiProvider(config: UserOwnedPiProvider): void {
  if (!/^local-[a-z0-9][a-z0-9-]{0,41}$/u.test(config.id)) {
    throw new Error("user-owned Pi provider id must use an unambiguous local- prefix");
  }
  normalizeLoopbackBaseUrl(config.baseUrl);
  if (config.models.length === 0 || new Set(config.models.map((model) => model.id)).size !== config.models.length) {
    throw new Error("user-owned Pi models must be nonempty and unique");
  }
  for (const model of config.models) {
    if (!model.id || model.id !== model.id.trim() || model.id.length > 256 || /[\u0000-\u001f\u007f]/u.test(model.id)
      || (model.name !== undefined && (!model.name.trim() || model.name.length > 256 || /[\u0000-\u001f\u007f]/u.test(model.name)))
      || !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 8_192
      || !Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0 || model.maxTokens > model.contextWindow) {
      throw new Error("user-owned Pi model limits are invalid");
    }
  }
}

function normalizeLoopbackBaseUrl(raw: string): string {
  let value: URL;
  try { value = new URL(raw); } catch { throw new Error("user-owned Pi base URL is invalid"); }
  const loopback = value.hostname === "localhost" || value.hostname === "127.0.0.1" || value.hostname === "[::1]";
  if (!loopback || value.protocol !== "http:" || value.username || value.password || value.search || value.hash) {
    throw new Error("user-owned Pi base URL must be an unauthenticated HTTP loopback endpoint");
  }
  return value.toString().replace(/\/+$/u, "");
}
