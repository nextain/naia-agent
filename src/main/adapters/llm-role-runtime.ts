// adapters/llm-role-runtime — effective role config를 OpenAI-compatible batch/memory 런타임 설정으로 변환.
// provider capability·endpoint·credential ref 규칙을 한 곳에 모아 sub와 memory가 설정 필드를 공유하지 않게 한다.
import type { EffectiveLlmConfig, LlmRole, LlmRolesResolution } from "../domain/llm-roles.js";
import { nativeBaseUrl } from "../domain/provider-route.js";
import type { SubLlmConfig } from "./sub-llm-provider.js";

const MAIN_ONLY = new Set(["codex", "claude-code-cli", "anthropic"]);
const LOCAL = new Set(["ollama", "vllm"]);

export function providerSupportsLlmRole(provider: string, role: LlmRole): boolean {
  if (role === "main") return true;
  return !MAIN_ONLY.has(provider.toLowerCase());
}

export function defaultCredentialRef(provider: string): string | undefined {
  switch (provider.toLowerCase()) {
    case "nextain":
    case "naia":
      return "NAIA_ANYLLM_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    case "xai":
      return "XAI_API_KEY";
    case "zai":
    case "glm":
      return "GLM_API_KEY";
    default:
      return undefined;
  }
}

function defaultRoleBaseUrl(provider: string): string | undefined {
  switch (provider) {
    case "nextain":
    case "naia":
      return "https://api.nextain.io/v1";
    default:
      try {
        return nativeBaseUrl(provider);
      } catch {
        return undefined;
      }
  }
}

export type RoleRuntimeResolution =
  | { readonly ok: true; readonly config: SubLlmConfig; readonly credentialRef?: string }
  | { readonly ok: false; readonly role: LlmRole; readonly reason: "unsupported" | "base-url-missing" | "credential-missing" };

export function resolveRoleRuntimeConfig(
  effective: EffectiveLlmConfig,
  resolveSecret: (ref: string) => string | undefined,
): RoleRuntimeResolution {
  const provider = effective.provider.value.toLowerCase();
  if (!providerSupportsLlmRole(provider, effective.role)) {
    return { ok: false, role: effective.role, reason: "unsupported" };
  }
  const baseUrl = effective.baseUrl?.value || defaultRoleBaseUrl(provider);
  if (!baseUrl) return { ok: false, role: effective.role, reason: "base-url-missing" };
  const credentialRef = effective.credentialRef?.value || defaultCredentialRef(provider);
  const apiKey = credentialRef ? resolveSecret(credentialRef) : undefined;
  if (!LOCAL.has(provider) && !apiKey) {
    return { ok: false, role: effective.role, reason: "credential-missing" };
  }
  return {
    ok: true,
    config: {
      provider,
      model: effective.model.value,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
	  ...(effective.thinkingLevel?.value ? { thinkingLevel: effective.thinkingLevel.value } : {}),
      ...((provider === "nextain" || provider === "naia") ? { auth: "x-anyllm" as const } : {}),
    },
    ...(credentialRef ? { credentialRef } : {}),
  };
}

/** Look up only trusted selected roles; an ambiguous same-model endpoint fails closed. */
export function resolveMemoryRoleEndpoint(
  roles: LlmRolesResolution | null,
  actual: { provider: string; model: string },
  resolveSecret: (ref: string) => string | undefined,
): string | undefined {
  if (!roles?.ok) return undefined;
  const urls = roles.configs.filter((role) => role.role === "memory" || role.role === "main")
    .map((role) => resolveRoleRuntimeConfig({ ...role, role: "sub" }, resolveSecret))
    .filter((result): result is Extract<RoleRuntimeResolution, { ok: true }> => result.ok)
    .filter((result) => result.config.provider === actual.provider && result.config.model === actual.model)
    .map((result) => result.config.baseUrl)
    .filter((url): url is string => !!url);
  const unique = [...new Set(urls)];
  return unique.length === 1 ? unique[0] : undefined;
}
