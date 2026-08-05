import { describe, expect, it } from "vitest";
import { assertIssueTeamProfile, type IssueTeamProfile } from "../main/domain/issue-team.js";

function valid(): IssueTeamProfile { return { kind: "team", maxRepairCycles: 2, requiredCleanCycles: 2, roles: {
  explorer: { agentProfileId: "explorer", agentKind: "codex", binding: { provider: "codex", model: "terra" }, filesystemAccess: "read_only" },
  implementer: { agentProfileId: "implementer", agentKind: "opencode", binding: { provider: "openrouter", model: "deepseek" }, filesystemAccess: "workspace_write" },
  tester: { agentProfileId: "tester", agentKind: "pi", binding: { provider: "naia", model: "economy" }, filesystemAccess: "read_only" },
  reviewer: { agentProfileId: "reviewer", agentKind: "codex", binding: { provider: "codex", model: "sol" }, filesystemAccess: "read_only" },
} }; }
describe("REQ-023 issue-team profile contract", () => {
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
