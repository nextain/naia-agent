import {
  resolveAnyLlmAlias,
  type AnyLlmAlias,
  type AnyLlmProviderCatalog,
} from "../domain/anyllm-provider-catalog.js";

export type AnyLlmScope =
  | { readonly scopeType: "user"; readonly tenantId: string; readonly userId: string }
  | { readonly scopeType: "workspace"; readonly tenantId: string; readonly userId: string; readonly workspaceId: string };

export interface AnyLlmActor {
  readonly tenantId: string;
  readonly userId: string;
  readonly permissions: readonly string[];
}

export interface AnyLlmCredentialReference {
  readonly name: "NAIA_ANYLLM_API_KEY";
  readonly version: string;
}

export interface AnyLlmProviderSelection {
  readonly scope: AnyLlmScope;
  readonly revision: number;
  readonly catalogVersion: number;
  readonly alias: AnyLlmAlias;
  readonly gatewayModel: string;
  readonly credential: AnyLlmCredentialReference;
  readonly allowlistRevision?: string;
}

export interface NewTurnProviderPin {
  readonly catalogVersion: number;
  readonly selectionRevision: number;
  readonly alias: AnyLlmAlias;
  readonly gatewayModel: string;
  readonly credentialVersion: string;
  readonly allowlistRevision?: string;
}

export interface NewTurnScope {
  readonly tenantId: string;
  readonly userId: string;
  readonly workspaceId?: string;
}

export type SelectionUpdateResult =
  | { readonly ok: true; readonly selection: AnyLlmProviderSelection }
  | { readonly ok: false; readonly reason: "forbidden" | "stale-revision" | "invalid-selection" };

export interface AnyLlmProviderSelectionStore {
  read(scope: AnyLlmScope, actor: AnyLlmActor): AnyLlmProviderSelection | null;
  update(input: {
    readonly scope: AnyLlmScope;
    readonly actor: AnyLlmActor;
    readonly expectedRevision: number;
    readonly alias: AnyLlmAlias;
    readonly requestedModel?: string;
    readonly credential: AnyLlmCredentialReference;
  }): SelectionUpdateResult;
  pinNewTurn(scope: AnyLlmScope, actor: AnyLlmActor): NewTurnProviderPin | null;
  /** Workspace selection wins only for the matching workspace; otherwise use the user selection. */
  pinEffectiveNewTurn(scope: NewTurnScope, actor: AnyLlmActor): NewTurnProviderPin | null;
}

export function makeAnyLlmProviderSelectionStore(deps: {
  readonly catalog: AnyLlmProviderCatalog;
  readonly authorize?: (actor: AnyLlmActor, scope: AnyLlmScope) => boolean;
}): AnyLlmProviderSelectionStore {
  const selections = new Map<string, AnyLlmProviderSelection>();
  const authorize = deps.authorize ?? samePrincipalWithProviderPermission;

  const readable = (scope: AnyLlmScope, actor: AnyLlmActor) => authorize(actor, scope);
  return {
    read(scope, actor) {
      if (!readable(scope, actor)) return null;
      const selection = selections.get(scopeKey(scope));
      return selection ? cloneSelection(selection) : null;
    },
    update(input) {
      if (!readable(input.scope, input.actor)) return { ok: false, reason: "forbidden" };
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        return { ok: false, reason: "stale-revision" };
      }
      if (!isCredentialReference(input.credential)) return { ok: false, reason: "invalid-selection" };
      const current = selections.get(scopeKey(input.scope));
      if ((current?.revision ?? 0) !== input.expectedRevision) {
        return { ok: false, reason: "stale-revision" };
      }
      const resolved = resolveAnyLlmAlias(deps.catalog, input.alias, input.requestedModel);
      if (!resolved.ok) return { ok: false, reason: "invalid-selection" };
      const selection: AnyLlmProviderSelection = {
        scope: cloneScope(input.scope),
        revision: input.expectedRevision + 1,
        catalogVersion: deps.catalog.version,
        alias: resolved.alias,
        gatewayModel: resolved.gatewayModel,
        credential: { ...input.credential },
        ...(resolved.allowlistRevision ? { allowlistRevision: resolved.allowlistRevision } : {}),
      };
      selections.set(scopeKey(input.scope), selection);
      return { ok: true, selection: cloneSelection(selection) };
    },
    pinNewTurn(scope, actor) {
      if (!readable(scope, actor)) return null;
      const selection = selections.get(scopeKey(scope));
      if (!selection) return null;
      return Object.freeze({
        catalogVersion: selection.catalogVersion,
        selectionRevision: selection.revision,
        alias: selection.alias,
        gatewayModel: selection.gatewayModel,
        credentialVersion: selection.credential.version,
        ...(selection.allowlistRevision ? { allowlistRevision: selection.allowlistRevision } : {}),
      });
    },
    pinEffectiveNewTurn(scope, actor) {
      const userScope: AnyLlmScope = { scopeType: "user", tenantId: scope.tenantId, userId: scope.userId };
      if (!readable(userScope, actor)) return null;
      const workspaceSelection = scope.workspaceId
        ? selections.get(scopeKey({ ...userScope, scopeType: "workspace", workspaceId: scope.workspaceId }))
        : undefined;
      const selection = workspaceSelection ?? selections.get(scopeKey(userScope));
      if (!selection) return null;
      return Object.freeze({
        catalogVersion: selection.catalogVersion,
        selectionRevision: selection.revision,
        alias: selection.alias,
        gatewayModel: selection.gatewayModel,
        credentialVersion: selection.credential.version,
        ...(selection.allowlistRevision ? { allowlistRevision: selection.allowlistRevision } : {}),
      });
    },
}
  };

function samePrincipalWithProviderPermission(actor: AnyLlmActor, scope: AnyLlmScope): boolean {
  return actor.tenantId === scope.tenantId && actor.userId === scope.userId && actor.permissions.includes("anyllm:select");
}

function isCredentialReference(value: AnyLlmCredentialReference): boolean {
  return value.name === "NAIA_ANYLLM_API_KEY" && /^[1-9][0-9]{0,18}$/.test(value.version);
}

function scopeKey(scope: AnyLlmScope): string {
  return scope.scopeType === "workspace"
    ? `workspace:${scope.tenantId}:${scope.userId}:${scope.workspaceId}`
    : `user:${scope.tenantId}:${scope.userId}`;
}

function cloneScope(scope: AnyLlmScope): AnyLlmScope {
  return scope.scopeType === "workspace" ? { ...scope } : { ...scope };
}

function cloneSelection(selection: AnyLlmProviderSelection): AnyLlmProviderSelection {
  return {
    ...selection,
    scope: cloneScope(selection.scope),
    credential: { ...selection.credential },
  };
}
