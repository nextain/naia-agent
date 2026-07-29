import { describe, expect, it } from "vitest";
import {
  createAnyLlmProviderCatalog,
  resolveAnyLlmAlias,
} from "../main/domain/anyllm-provider-catalog.js";
import { makeAnyLlmProviderSelectionStore } from "../main/adapters/anyllm-provider-selection-store.js";

const catalogResult = createAnyLlmProviderCatalog({
  version: 1,
  nativeProviders: [{ providerId: "native-codex" }],
  claudeAllowlist: {
    revision: "7",
    entries: [
      {
        clientModel: "claude-sonnet-4-6-20260217",
        gatewayModel: "anthropic:claude-sonnet-4-6-20260217",
        enabled: true,
      },
    ],
  },
});

if (!catalogResult.ok) throw new Error("test catalog must be valid");
const catalog = catalogResult.catalog;
const actor = { tenantId: "tenant-a", userId: "user-a", permissions: ["anyllm:select"] } as const;
const userScope = { scopeType: "user", tenantId: "tenant-a", userId: "user-a" } as const;

describe("REQ-018 Agent-owned AnyLLM provider catalog", () => {
  it("publishes only immutable HY3 and the exact versioned Claude allowlist", () => {
    expect(catalog.entries).toEqual([
      { alias: "anyllm-openrouter-hy3", gatewayModel: "openrouter:tencent/hy3" },
      {
        alias: "anyllm-claude",
        gatewayModel: "anthropic:<allowlisted-model>",
        allowlistRevision: "7",
        selectableModels: ["claude-sonnet-4-6-20260217"],
      },
    ]);
    expect(resolveAnyLlmAlias(catalog, "anyllm-openrouter-hy3")).toEqual({
      ok: true,
      alias: "anyllm-openrouter-hy3",
      gatewayModel: "openrouter:tencent/hy3",
    });
    expect(resolveAnyLlmAlias(catalog, "anyllm-openrouter-hy3", "other-model")).toEqual({
      ok: false,
      reason: "model-not-allowed",
    });
    expect(resolveAnyLlmAlias(catalog, "anyllm-claude", "claude-not-in-list-20260217")).toEqual({
      ok: false,
      reason: "model-not-allowed",
    });
  });

  it("rejects colliding native aliases and malformed Claude mapping", () => {
    expect(createAnyLlmProviderCatalog({
      version: 1,
      nativeProviders: [{ providerId: "anyllm-openrouter-hy3" }],
      claudeAllowlist: { revision: "1", entries: [] },
    })).toEqual({ ok: false, reason: "provider-id-collision" });
    expect(createAnyLlmProviderCatalog({
      version: 1,
      claudeAllowlist: {
        revision: "1",
        entries: [{
          clientModel: "claude-sonnet-4-6-20260217",
          gatewayModel: "anthropic:another-model",
          enabled: true,
        }],
      },
    })).toEqual({ ok: false, reason: "claude-allowlist" });
  });

  it("requires matching principal and revision CAS without retaining credentials", () => {
    const store = makeAnyLlmProviderSelectionStore({ catalog });
    const credential = { name: "NAIA_ANYLLM_API_KEY", version: "3" } as const;
    expect(store.update({
      scope: userScope,
      actor: { ...actor, tenantId: "tenant-b" },
      expectedRevision: 0,
      alias: "anyllm-openrouter-hy3",
      credential,
    })).toEqual({ ok: false, reason: "forbidden" });
    const accepted = store.update({
      scope: userScope,
      actor,
      expectedRevision: 0,
      alias: "anyllm-openrouter-hy3",
      credential,
    });
    expect(accepted).toMatchObject({ ok: true, selection: { revision: 1, credential } });
    expect(store.update({
      scope: userScope,
      actor,
      expectedRevision: 0,
      alias: "anyllm-openrouter-hy3",
      credential,
    })).toEqual({ ok: false, reason: "stale-revision" });
  });

  it("pins an admitted turn while a later selection affects only future turns", () => {
    const store = makeAnyLlmProviderSelectionStore({ catalog });
    const credential = { name: "NAIA_ANYLLM_API_KEY", version: "3" } as const;
    expect(store.update({
      scope: userScope,
      actor,
      expectedRevision: 0,
      alias: "anyllm-openrouter-hy3",
      credential,
    }).ok).toBe(true);
    const pin = store.pinNewTurn(userScope, actor);
    expect(pin).toMatchObject({ selectionRevision: 1, alias: "anyllm-openrouter-hy3", credentialVersion: "3" });
    expect(store.update({
      scope: userScope,
      actor,
      expectedRevision: 1,
      alias: "anyllm-claude",
      requestedModel: "claude-sonnet-4-6-20260217",
      credential: { name: "NAIA_ANYLLM_API_KEY", version: "4" },
    })).toMatchObject({ ok: true, selection: { revision: 2 } });
    expect(pin).toMatchObject({ selectionRevision: 1, alias: "anyllm-openrouter-hy3", credentialVersion: "3" });
    expect(store.pinNewTurn(userScope, actor)).toMatchObject({ selectionRevision: 2, alias: "anyllm-claude", credentialVersion: "4" });
  });
  it("uses a workspace selection only in that workspace", () => {
    const store = makeAnyLlmProviderSelectionStore({ catalog });
    const credential = { name: "NAIA_ANYLLM_API_KEY", version: "3" } as const;
    const workspace = { ...userScope, scopeType: "workspace", workspaceId: "workspace-a" } as const;
    expect(store.update({
      scope: userScope,
      actor,
      expectedRevision: 0,
      alias: "anyllm-openrouter-hy3",
      credential,
    }).ok).toBe(true);
    expect(store.update({
      scope: workspace,
      actor,
      expectedRevision: 0,
      alias: "anyllm-claude",
      requestedModel: "claude-sonnet-4-6-20260217",
      credential,
    }).ok).toBe(true);
    expect(store.pinEffectiveNewTurn({ ...userScope, workspaceId: "workspace-a" }, actor)).toMatchObject({
      alias: "anyllm-claude",
    });
    expect(store.pinEffectiveNewTurn({ ...userScope, workspaceId: "workspace-b" }, actor)).toMatchObject({
      alias: "anyllm-openrouter-hy3",
    });
    expect(store.pinEffectiveNewTurn(userScope, actor)).toMatchObject({
      alias: "anyllm-openrouter-hy3",
    });
  });
});
