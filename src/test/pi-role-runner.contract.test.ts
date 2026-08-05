import { describe, expect, it } from "vitest";
import { resolveLlmRoles } from "../main/domain/llm-roles.js";
import { makePiRoleSubAgent, piProviderForRole } from "../main/adapters/pi-role-runner.js";

describe("Pi-only development role factory", () => {
  const resolved = resolveLlmRoles({
    roles: {
      main: { provider: "codex", model: "gpt-5.6" },
      expert: { provider: "claude-code-cli", model: "claude-opus-4-8" },
      sub: { inherit: "main" },
      memory: { inherit: "sub" },
    },
  });

  it("accepts a configured Codex or Claude development role", () => {
    expect(makePiRoleSubAgent(resolved, "expert").ok).toBe(true);
    expect(makePiRoleSubAgent(resolved, "main").ok).toBe(true);
    expect(makePiRoleSubAgent(resolved, "sub").ok).toBe(true);
  });

  it("maps the Codex account role to Pi's OAuth provider rather than the OpenAI API-key provider", () => {
    expect(piProviderForRole("codex")).toBe("openai-codex");
    expect(piProviderForRole("codex")).not.toBe("openai");
    expect(piProviderForRole("claude-code-cli")).toBe("anthropic");
    expect(piProviderForRole("nextain")).toBe("naia");
  });

  it("does not allow memory to become a development Pi role", () => {
    // The public role type excludes memory; runtime callers cannot select it.
    expect(makePiRoleSubAgent(resolved, "memory" as never).ok).toBe(false);
  });

  it("fails closed for an unsupported provider rather than falling back", () => {
    const invalid = resolveLlmRoles({
      roles: {
        main: { provider: "opencode", model: "anything" },
        sub: { inherit: "main" },
        memory: { inherit: "sub" },
        expert: { inherit: "main" },
      },
    });
    expect(makePiRoleSubAgent(invalid, "main")).toEqual({
      ok: false,
      reason: "Provider 'opencode' is not permitted for Pi role 'main'",
    });
  });

  it("accepts only the registered Naia Pi catalog and keeps analysis-only models explicit", () => {
    const valid = resolveLlmRoles({
      roles: {
        main: { provider: "nextain", model: "deepseek-v4-flash" },
        sub: { inherit: "main" }, memory: { inherit: "sub" }, expert: { inherit: "main" },
      },
    });
    expect(makePiRoleSubAgent(valid, "sub").ok).toBe(true);
    const invalid = resolveLlmRoles({
      roles: {
        main: { provider: "nextain", model: "invented-model" },
        sub: { inherit: "main" }, memory: { inherit: "sub" }, expert: { inherit: "main" },
      },
    });
    expect(makePiRoleSubAgent(invalid, "sub")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not registered"),
    });
  });
});
