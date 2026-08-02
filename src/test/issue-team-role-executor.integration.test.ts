import { describe, expect, it } from "vitest";
import { makeIssueTeamRoleExecutor } from "../main/composition/issue-team-role-executor.js";
import type { SubAgentPort } from "../main/ports/orchestration.js";

function agent(provider: string, model: string, session: string): SubAgentPort {
  return { spawn(task) { return { async cancel() {}, events: (async function* () {
    const role = task.filesystemAccess === "workspace_write" ? "implementer" : provider === "pi" ? "tester" : provider === "opencode" ? "reviewer" : "explorer";
    const decision = role === "explorer" ? "proceed" : role === "implementer" ? "implemented" : role === "tester" ? "pass" : "clean";
    yield { kind: "text_delta", text: JSON.stringify({ version: 1, role, decision, summary: "ok", findings: [] }) } as const;
    yield { kind: "session_end", ok: true, evidence: { provider, selectedModel: model, modelEvidenceSource: "adapter_requested",
      inputTokens: 0, outputTokens: 0, totalTokens: 0, usageAvailable: false, sessionId: session, executionId: `${session}-execution` } } as const;
  })() }; } };
}

describe("REQ-023 profiled role executor", () => {
  it("selects only declared Codex/OpenCode/Pi profiles and preserves honest evidence", async () => {
    const executor = makeIssueTeamRoleExecutor({ agents: { codex: { agentKind: "codex", adapter: agent("codex", "codex-model", "s1") }, opencode: { agentKind: "opencode", adapter: agent("opencode", "opencode-model", "s2") }, pi: { agentKind: "pi", adapter: agent("pi", "pi-model", "s3") } },
      diag: { log() {}, debug() {} }, nowMs: (() => { let n = 0; return () => ++n; })() });
    const cases = [
      ["explorer", "codex", "codex", "codex-model", "read_only"],
      ["implementer", "opencode", "opencode", "opencode-model", "workspace_write"],
      ["tester", "pi", "pi", "pi-model", "read_only"],
    ] as const;
    for (const [role, id, provider, model, filesystemAccess] of cases) {
      const output = await executor.execute({ issueId: "issue", dispatchId: "dispatch", stepId: `dispatch:${role}:1`, worktreePath: "/repo", task: "fix", context: "{}",
        roleProfile: { agentProfileId: id, agentKind: id, binding: { provider, model }, filesystemAccess }, signal: new AbortController().signal });
      expect(output).toMatchObject({ result: { role }, receipt: { workerRole: role, agentProfileId: id, agentKind: id,
        provider, model, tokenCountsAvailable: false, cost: { state: "unavailable" } } });
    }
    await expect(executor.execute({ issueId: "issue", dispatchId: "dispatch", stepId: "dispatch:reviewer:1", worktreePath: "/repo", task: "fix", context: "{}",
      roleProfile: { agentProfileId: "missing", agentKind: "codex", binding: { provider: "codex", model: "codex-model" }, filesystemAccess: "read_only" }, signal: new AbortController().signal }))
      .rejects.toThrow("undeclared issue-team agent profile");
    await expect(executor.execute({ issueId: "issue", dispatchId: "dispatch", stepId: "dispatch:reviewer:1", worktreePath: "/repo", task: "fix", context: "{}",
      roleProfile: { agentProfileId: "pi", agentKind: "codex", binding: { provider: "pi", model: "pi-model" }, filesystemAccess: "read_only" }, signal: new AbortController().signal }))
      .rejects.toThrow("undeclared issue-team agent profile");
  });
});
