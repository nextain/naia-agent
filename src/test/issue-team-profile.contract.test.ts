import { describe, expect, it } from "vitest";
import { composeIssueTeamAgents } from "../main/composition/mixed-issue-team-agents.js";
import { assertIssueTeamProfile, type IssueTeamProfile } from "../main/domain/issue-team.js";

function valid(): IssueTeamProfile { return { kind: "team", maxRepairCycles: 2, requiredCleanCycles: 2, roles: {
  explorer: { agentProfileId: "explorer", agentKind: "codex", binding: { provider: "codex", model: "terra" }, filesystemAccess: "read_only" },
  implementer: { agentProfileId: "implementer", agentKind: "opencode", binding: { provider: "openrouter", model: "deepseek" }, filesystemAccess: "workspace_write" },
  tester: { agentProfileId: "tester", agentKind: "pi", binding: { provider: "naia", model: "economy" }, filesystemAccess: "read_only" },
  reviewer: { agentProfileId: "reviewer", agentKind: "codex", binding: { provider: "codex", model: "sol" }, filesystemAccess: "read_only" },
} }; }
describe("REQ-023 issue-team profile contract", () => {
  it("accepts and composes Claude Code through the same declared worker-kind boundary", async () => {
    const profile = valid();
    const withClaude = { ...profile, roles: { ...profile.roles,
      reviewer: { ...profile.roles.reviewer, agentProfileId: "claude-reviewer", agentKind: "claude-code",
        binding: { provider: "claude-code", model: "claude-sonnet" } },
    } } satisfies IssueTeamProfile;
    expect(() => assertIssueTeamProfile(withClaude)).not.toThrow();
    const composed = composeIssueTeamAgents(withClaude, { claudeCode: {
      resolveBin: () => { throw new Error("fixture unavailable"); },
    } });
    expect(composed["claude-reviewer"].agentKind).toBe("claude-code");
    const events = [];
    for await (const event of composed["claude-reviewer"].adapter.spawn({ prompt: "review", workdir: "/tmp" }).events) events.push(event);
    expect(events).toEqual([expect.objectContaining({ kind: "session_end", ok: false,
      reason: expect.stringContaining("claude-code unavailable") })]);
  });
  it("accepts only the four fixed roles and the implementer write boundary", () => { expect(() => assertIssueTeamProfile(valid())).not.toThrow();
    expect(() => assertIssueTeamProfile({ ...valid(), roles: { ...valid().roles, tester: { ...valid().roles.tester, filesystemAccess: "workspace_write" } } })).toThrow();
    expect(() => assertIssueTeamProfile({ ...valid(), roles: { ...valid().roles, reviewer: { ...valid().roles.reviewer, agentProfileId: "tester" } } })).toThrow("duplicate");
  });
  it("bounds repair and clean-cycle policy independently of wall time", () => {
    expect(() => assertIssueTeamProfile({ ...valid(), maxRepairCycles: 33 })).toThrow("loop bounds");
    expect(() => assertIssueTeamProfile({ ...valid(), requiredCleanCycles: 0 })).toThrow("loop bounds");
    expect(() => assertIssueTeamProfile({ ...valid(), roles: { ...valid().roles, explorer: { ...valid().roles.explorer,
      binding: { ...valid().roles.explorer.binding, provider: " codex" } } } })).toThrow("explorer profile");
    expect(() => assertIssueTeamProfile({ ...valid(), roles: { ...valid().roles, tester: { ...valid().roles.tester,
      binding: { ...valid().roles.tester.binding, model: "pi\u0000model" } } } })).toThrow("tester profile");
    expect(() => assertIssueTeamProfile({ ...valid(), roles: { ...valid().roles, reviewer: { ...valid().roles.reviewer,
      binding: { ...valid().roles.reviewer.binding, reasoningEffort: "extreme" } } } })).toThrow("reviewer profile");
  });
});
