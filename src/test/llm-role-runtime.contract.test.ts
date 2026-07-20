import { describe, expect, it } from "vitest";
import { resolveRoleRuntimeConfig } from "../main/adapters/llm-role-runtime.js";
import type { EffectiveLlmConfig } from "../main/domain/llm-roles.js";

const effective = (
  role: "main" | "sub" | "memory",
  provider: string,
  model = "m",
): EffectiveLlmConfig => ({
  role,
  provider: { value: provider, provenance: "explicit" },
  model: { value: model, provenance: "explicit" },
});

describe("role runtime provider capability/auth", () => {
  it("Codex/Claude Code/Anthropic은 현재 main-only로 fail-closed", () => {
    for (const provider of ["codex", "claude-code-cli", "anthropic"]) {
      expect(resolveRoleRuntimeConfig(effective("sub", provider), () => "key")).toEqual({
        ok: false,
        role: "sub",
        reason: "unsupported",
      });
    }
  });

  it("Naia sub는 gateway endpoint와 X-AnyLLM-Key auth를 사용", () => {
    const result = resolveRoleRuntimeConfig(
      effective("sub", "nextain", "gemini-3.1-flash-lite"),
      (ref) => ref === "NAIA_ANYLLM_API_KEY" ? "naia-key" : undefined,
    );
    expect(result).toEqual({
      ok: true,
      credentialRef: "NAIA_ANYLLM_API_KEY",
      config: {
        provider: "nextain",
        model: "gemini-3.1-flash-lite",
        baseUrl: "https://api.nextain.io/v1",
        apiKey: "naia-key",
        auth: "x-anyllm",
      },
    });
  });

  it("Ollama memory는 key 없이 로컬 기본 endpoint로 구성", () => {
    expect(resolveRoleRuntimeConfig(effective("memory", "ollama", "qwen3:4b"), () => undefined)).toEqual({
      ok: true,
      config: {
        provider: "ollama",
        model: "qwen3:4b",
        baseUrl: "http://localhost:11434/v1",
      },
    });
  });

  it("외부 역할 provider는 credential 누락을 역할 단위로 진단", () => {
    expect(resolveRoleRuntimeConfig(effective("memory", "openai"), () => undefined)).toEqual({
      ok: false,
      role: "memory",
      reason: "credential-missing",
    });
  });
});
