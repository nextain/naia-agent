import { describe, expect, it } from "vitest";
import { resolveLlmRoles } from "../main/domain/llm-roles.js";
import { makePiRoleSubAgent } from "../main/adapters/pi-role-runner.js";

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
});
