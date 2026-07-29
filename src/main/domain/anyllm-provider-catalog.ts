/**
 * AnyLLM provider catalog contract.
 *
 * This module is deliberately transport- and secret-free.  Agent adapters own
 * persistence/RPC, while this domain layer owns the immutable alias mapping
 * that a new turn can pin.
 */

export const ANYLLM_PROVIDER_CONTRACT = "naia-anyllm-provider.v1" as const;

export type AnyLlmAlias = "anyllm-openrouter-hy3" | "anyllm-claude";

export interface ClaudeAllowlistEntry {
  readonly clientModel: string;
  readonly gatewayModel: string;
  readonly enabled: true;
}

export interface ClaudeAllowlist {
  readonly revision: string;
  readonly entries: readonly ClaudeAllowlistEntry[];
}

export interface AnyLlmCatalogEntry {
  readonly alias: AnyLlmAlias;
  readonly gatewayModel: string;
  readonly allowlistRevision?: string;
  readonly selectableModels?: readonly string[];
}

export interface NativeProviderCatalogEntry {
  readonly providerId: string;
}

export interface AnyLlmProviderCatalog {
  readonly contractVersion: typeof ANYLLM_PROVIDER_CONTRACT;
  readonly version: number;
  readonly entries: readonly AnyLlmCatalogEntry[];
  readonly nativeProviderIds: readonly string[];
}

export type CatalogResult =
  | { readonly ok: true; readonly catalog: AnyLlmProviderCatalog }
  | { readonly ok: false; readonly reason: "catalog-version" | "provider-id-collision" | "claude-allowlist" };

const HY3_ALIAS: AnyLlmCatalogEntry = {
  alias: "anyllm-openrouter-hy3",
  gatewayModel: "openrouter:tencent/hy3",
};

const CLAUDE_MODEL = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]{8}$/;
const GATEWAY_CLAUDE_MODEL = /^anthropic:(claude-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]{8})$/;
const REVISION = /^(?:[1-9][0-9]{0,18})$/;

export function createAnyLlmProviderCatalog(input: {
  readonly version: number;
  readonly nativeProviders?: readonly NativeProviderCatalogEntry[];
  readonly claudeAllowlist: ClaudeAllowlist;
}): CatalogResult {
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    return { ok: false, reason: "catalog-version" };
  }
  const nativeProviderIds = input.nativeProviders?.map((entry) => entry.providerId) ?? [];
  const allIds = [...nativeProviderIds, HY3_ALIAS.alias, "anyllm-claude"];
  if (allIds.some((id) => !id) || new Set(allIds).size !== allIds.length) {
    return { ok: false, reason: "provider-id-collision" };
  }
  if (!isValidClaudeAllowlist(input.claudeAllowlist)) {
    return { ok: false, reason: "claude-allowlist" };
  }

  const models = input.claudeAllowlist.entries.map((entry) => entry.clientModel);
  return {
    ok: true,
    catalog: {
      contractVersion: ANYLLM_PROVIDER_CONTRACT,
      version: input.version,
      entries: [
        HY3_ALIAS,
        {
          alias: "anyllm-claude",
          gatewayModel: "anthropic:<allowlisted-model>",
          allowlistRevision: input.claudeAllowlist.revision,
          selectableModels: models,
        },
      ],
      nativeProviderIds,
    },
  };
}

export type AliasResolution =
  | { readonly ok: true; readonly alias: AnyLlmAlias; readonly gatewayModel: string; readonly allowlistRevision?: string }
  | { readonly ok: false; readonly reason: "unknown-alias" | "model-not-allowed" };

/** Resolves only the two documented aliases; it deliberately has no alternate route. */
export function resolveAnyLlmAlias(
  catalog: AnyLlmProviderCatalog,
  alias: AnyLlmAlias,
  requestedModel?: string,
): AliasResolution {
  const entry = catalog.entries.find((candidate) => candidate.alias === alias);
  if (!entry) return { ok: false, reason: "unknown-alias" };
  if (alias === "anyllm-openrouter-hy3") {
    return requestedModel === undefined
      ? { ok: true, alias, gatewayModel: HY3_ALIAS.gatewayModel }
      : { ok: false, reason: "model-not-allowed" };
  }
  if (!requestedModel || !entry.selectableModels?.includes(requestedModel)) {
    return { ok: false, reason: "model-not-allowed" };
  }
  return {
    ok: true,
    alias,
    gatewayModel: `anthropic:${requestedModel}`,
    allowlistRevision: entry.allowlistRevision,
  };
}

function isValidClaudeAllowlist(allowlist: ClaudeAllowlist): boolean {
  if (!REVISION.test(allowlist.revision) || allowlist.entries.length === 0) return false;
  let previous = "";
  const seen = new Set<string>();
  for (const entry of allowlist.entries) {
    const match = GATEWAY_CLAUDE_MODEL.exec(entry.gatewayModel);
    if (
      entry.enabled !== true ||
      !CLAUDE_MODEL.test(entry.clientModel) ||
      !match ||
      match[1] !== entry.clientModel ||
      entry.clientModel <= previous ||
      seen.has(entry.clientModel)
    ) return false;
    previous = entry.clientModel;
    seen.add(entry.clientModel);
  }
  return true;
}
