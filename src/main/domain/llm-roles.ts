// domain/llm-roles — main/sub/memory 역할별 설정 해석과 provenance.
// I/O·provider 생성·비밀 해석 없음. 신규 구조화 설정과 legacy 필드를 한 경계에서 정규화한다.

export type LlmRole = "main" | "sub" | "memory";
export type ConfigProvenance = "explicit" | "inherit" | "legacy-inherit" | "default";

export interface ResolvedConfigValue {
  readonly value: string;
  readonly provenance: ConfigProvenance;
  readonly inheritedFromRole?: LlmRole;
}

export interface EffectiveLlmConfig {
  readonly role: LlmRole;
  readonly provider: ResolvedConfigValue;
  readonly model: ResolvedConfigValue;
  readonly baseUrl?: ResolvedConfigValue;
  readonly credentialRef?: ResolvedConfigValue;
}

export interface LlmRoleSelection {
  readonly provider?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly credentialRef?: string;
  readonly inherit?: LlmRole;
}

export interface LlmRolesInput {
  readonly roles?: Partial<Record<LlmRole, LlmRoleSelection>>;
  readonly legacy?: {
    readonly main?: LlmRoleSelection;
    readonly sub?: LlmRoleSelection;
    readonly memory?: LlmRoleSelection;
  };
  /** 제품이 명시한 literal 기본값. 사용자 선택을 임의로 바꾸지 않도록 선택적이다. */
  readonly defaults?: Partial<Record<LlmRole, LlmRoleSelection>>;
}

export type LlmRolesResolution =
  | { readonly ok: true; readonly configs: readonly [EffectiveLlmConfig, EffectiveLlmConfig, EffectiveLlmConfig] }
  | { readonly ok: false; readonly role: LlmRole; readonly reason: "missing" | "incomplete" | "cycle" | "invalid-inherit" };

interface Source {
  readonly selection: LlmRoleSelection;
  readonly provenance: ConfigProvenance;
  readonly inheritedFromRole?: LlmRole;
}

const ORDER: readonly LlmRole[] = ["main", "sub", "memory"];
const clean = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

function directSource(selection: LlmRoleSelection | undefined, provenance: ConfigProvenance): Source | undefined {
  if (!selection) return undefined;
  return { selection, provenance };
}

/**
 * 우선순위:
 * 1) 신규 llmRoles 명시 설정/상속
 * 2) 역할별 legacy 설정(main=provider/model, sub=subLlm*, memory=memoryLlm*)
 * 3) 구버전에서 subLlm*이 없고 memoryLlm*만 있으면 sub=memory legacy 상속
 * 4) 신규 memory 미설정은 sub가 명시된 경우에만 sub 상속
 * 5) 선택적 literal defaults
 */
export function resolveLlmRoles(input: LlmRolesInput): LlmRolesResolution {
  const sources = new Map<LlmRole, Source>();
  for (const role of ORDER) {
    const explicit = input.roles?.[role];
    if (explicit) {
      sources.set(role, {
        selection: explicit,
        provenance: explicit.inherit ? "inherit" : "explicit",
        ...(explicit.inherit ? { inheritedFromRole: explicit.inherit } : {}),
      });
      continue;
    }
    const legacy = input.legacy?.[role];
    if (legacy) {
      sources.set(role, directSource(legacy, "explicit")!);
      continue;
    }
    if (role === "sub" && input.legacy?.memory) {
      sources.set(role, {
        selection: { inherit: "memory" },
        provenance: "legacy-inherit",
        inheritedFromRole: "memory",
      });
      continue;
    }
    if (role === "memory" && (input.roles?.sub || input.legacy?.sub || input.legacy?.memory || sources.has("sub"))) {
      sources.set(role, {
        selection: { inherit: "sub" },
        provenance: "inherit",
        inheritedFromRole: "sub",
      });
      continue;
    }
    const fallback = input.defaults?.[role];
    if (fallback) sources.set(role, directSource(fallback, "default")!);
  }

  const resolved = new Map<LlmRole, EffectiveLlmConfig>();
  const resolving = new Set<LlmRole>();
  const resolveOne = (role: LlmRole): EffectiveLlmConfig | LlmRolesResolution => {
    const cached = resolved.get(role);
    if (cached) return cached;
    if (resolving.has(role)) return { ok: false, role, reason: "cycle" };
    const source = sources.get(role);
    if (!source) return { ok: false, role, reason: "missing" };
    resolving.add(role);

    const inherit = source.selection.inherit;
    if (inherit) {
      if (!ORDER.includes(inherit) || inherit === role) {
        resolving.delete(role);
        return { ok: false, role, reason: inherit === role ? "cycle" : "invalid-inherit" };
      }
      const parent = resolveOne(inherit);
      if ("ok" in parent) {
        resolving.delete(role);
        return parent;
      }
      const wrap = (value: ResolvedConfigValue): ResolvedConfigValue => ({
        value: value.value,
        provenance: source.provenance,
        inheritedFromRole: inherit,
      });
      const config: EffectiveLlmConfig = {
        role,
        provider: wrap(parent.provider),
        model: wrap(parent.model),
        ...(parent.baseUrl ? { baseUrl: wrap(parent.baseUrl) } : {}),
        ...(parent.credentialRef ? { credentialRef: wrap(parent.credentialRef) } : {}),
      };
      resolving.delete(role);
      resolved.set(role, config);
      return config;
    }

    const provider = clean(source.selection.provider);
    const model = clean(source.selection.model);
    if (!provider || !model) {
      resolving.delete(role);
      return { ok: false, role, reason: provider || model ? "incomplete" : "missing" };
    }
    const value = (raw: string): ResolvedConfigValue => ({ value: raw, provenance: source.provenance });
    const baseUrl = clean(source.selection.baseUrl);
    const credentialRef = clean(source.selection.credentialRef);
    const config: EffectiveLlmConfig = {
      role,
      provider: value(provider.toLowerCase()),
      model: value(model),
      ...(baseUrl ? { baseUrl: value(baseUrl) } : {}),
      ...(credentialRef ? { credentialRef: value(credentialRef) } : {}),
    };
    resolving.delete(role);
    resolved.set(role, config);
    return config;
  };

  const configs: EffectiveLlmConfig[] = [];
  for (const role of ORDER) {
    const config = resolveOne(role);
    if ("ok" in config) return config;
    configs.push(config);
  }
  return {
    ok: true,
    configs: configs as unknown as readonly [EffectiveLlmConfig, EffectiveLlmConfig, EffectiveLlmConfig],
  };
}
