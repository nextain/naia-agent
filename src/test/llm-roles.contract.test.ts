import { describe, expect, it } from "vitest";
import { resolveLlmRoles } from "../main/domain/llm-roles.js";

describe("main/sub/memory 역할 해석", () => {
  it("세 역할을 서로 다른 provider/model로 독립 해석한다", () => {
    const result = resolveLlmRoles({
      roles: {
        main: { provider: "codex", model: "gpt-5.4" },
        sub: { provider: "naia", model: "gemini-3.1-flash-lite", credentialRef: "sub-key" },
        memory: { provider: "ollama", model: "qwen3:4b", baseUrl: "http://localhost:11434/v1" },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configs.map((c) => [c.role, c.provider.value, c.model.value])).toEqual([
      ["main", "codex", "gpt-5.4"],
      ["sub", "naia", "gemini-3.1-flash-lite"],
      ["memory", "ollama", "qwen3:4b"],
    ]);
    expect(result.configs.every((c) => c.provider.provenance === "explicit")).toBe(true);
  });

  it("memory가 sub를 상속해도 effective config와 출처를 역할별로 만든다", () => {
    const result = resolveLlmRoles({
      roles: {
        main: { provider: "codex", model: "gpt-5.4" },
        sub: { provider: "naia", model: "gemini-3.1-flash-lite", credentialRef: "sub-key" },
        memory: { inherit: "sub" },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const memory = result.configs[2];
    expect(memory.provider).toEqual({ value: "naia", provenance: "inherit", inheritedFromRole: "sub" });
    expect(memory.model).toEqual({ value: "gemini-3.1-flash-lite", provenance: "inherit", inheritedFromRole: "sub" });
    expect(memory.credentialRef).toEqual({ value: "sub-key", provenance: "inherit", inheritedFromRole: "sub" });
  });

	it("legacy memoryLlm*은 memory로 보존하고 sub는 legacy-inherit로 해석한다", () => {
    const result = resolveLlmRoles({
      legacy: {
        main: { provider: "openai", model: "gpt-5.4" },
        memory: { provider: "ollama", model: "gemma3:4b", baseUrl: "http://localhost:11434/v1" },
      },
	});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configs[1].provider).toEqual({
      value: "ollama",
      provenance: "legacy-inherit",
      inheritedFromRole: "memory",
    });
    expect(result.configs[2].provider).toEqual({ value: "ollama", provenance: "explicit" });
  });

	it("main만 고르면 sub와 memory가 main을 기본 상속한다", () => {
		const result = resolveLlmRoles({
			legacy: { main: { provider: "ollama", model: "dna3:latest" } },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.configs.map((config) => [
			config.role,
			config.provider.value,
			config.provider.provenance,
			config.provider.inheritedFromRole,
		])).toEqual([
			["main", "ollama", "explicit", undefined],
			["sub", "ollama", "inherit", "main"],
			["memory", "ollama", "inherit", "main"],
		]);
	});

  it("신규 역할 설정이 legacy보다 우선한다", () => {
    const result = resolveLlmRoles({
      roles: {
        main: { provider: "codex", model: "gpt-5.4" },
        sub: { provider: "nextain", model: "gemini-3.1-flash-lite" },
        memory: { inherit: "sub" },
      },
      legacy: {
        main: { provider: "openai", model: "gpt-4o" },
        memory: { provider: "ollama", model: "old" },
      },
    });
    expect(result.ok && result.configs[0].provider.value).toBe("codex");
    expect(result.ok && result.configs[1].provider.value).toBe("nextain");
  });

  it("불완전 설정과 상속 순환은 역할 단위로 fail-closed한다", () => {
    expect(resolveLlmRoles({
      roles: {
        main: { provider: "codex" },
        sub: { provider: "naia", model: "small" },
        memory: { inherit: "sub" },
      },
    })).toEqual({ ok: false, role: "main", reason: "incomplete" });
    expect(resolveLlmRoles({
      roles: {
        main: { inherit: "sub" },
        sub: { inherit: "main" },
        memory: { inherit: "sub" },
      },
    })).toEqual({ ok: false, role: "main", reason: "cycle" });
  });
});
