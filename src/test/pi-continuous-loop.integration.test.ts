import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqlitePaidCallBudget } from "../main/adapters/sqlite-paid-call-budget.js";
import { makeSubAgentNaiaFacing } from "../main/adapters/subagent-issue-actors.js";
import { makeIssueTeamRoleExecutor } from "../main/composition/issue-team-role-executor.js";
import type { SubAgentModelEvidence } from "../main/domain/orchestration.js";
import type { SubAgentPort } from "../main/ports/orchestration.js";

describe("Pi continuous-loop paid actor wiring", () => {
  it("reserves before spawn and settles facing and role evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "naia-pi-loop-wiring-"));
    try {
      const budget = new SqlitePaidCallBudget(join(root, "budget.db"),
        { maxPaidCalls: 4, maxUsd: 1, maxInputTokens: 4_000, maxOutputTokens: 2_000 });
      const allowance = { reservedUsd: 0.2, reservedInputTokens: 1_000, reservedOutputTokens: 500 };
      const facing = makeSubAgentNaiaFacing({ subAgent: fakeAgent(() => JSON.stringify({ kind: "work", obligations: ["fix"] }), "face"),
        binding: { provider: "naia", model: "grok-4.3" }, workdir: root, diag: { log() {} }, budget, callAllowance: allowance });
      await facing.classify({ requestId: "r", idempotencyKey: "issue:facing", text: "fix",
        requiredObligations: ["fix"], signal: new AbortController().signal });
      expect(budget.snapshot()).toMatchObject({ paidCalls: 1, activeReservations: 0, chargedUsd: 0.01 });

      const roles = makeIssueTeamRoleExecutor({ agents: { "pi-explorer": { agentKind: "pi",
        adapter: fakeAgent(() => JSON.stringify({ version: 1, role: "explorer", decision: "proceed", summary: "ok", findings: [] }), "role") } },
        diag: { log() {} }, budget, callAllowance: allowance });
      await roles.execute({ issueId: "issue", dispatchId: "dispatch", stepId: "issue:explorer:1",
        worktreePath: root, task: "inspect", context: "{}", roleProfile: { agentProfileId: "pi-explorer",
          agentKind: "pi", binding: { provider: "naia", model: "grok-4.3" }, filesystemAccess: "read_only" },
        signal: new AbortController().signal });
      expect(budget.snapshot()).toMatchObject({ paidCalls: 2, activeReservations: 0, chargedUsd: 0.02 });
      budget.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("settles complete failed actor evidence instead of misclassifying it as crash-unknown", async () => {
    const root = mkdtempSync(join(tmpdir(), "naia-pi-loop-failed-"));
    try {
      const budget = new SqlitePaidCallBudget(join(root, "budget.db"),
        { maxPaidCalls: 1, maxUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 500 });
      const facing = makeSubAgentNaiaFacing({ subAgent: fakeAgent(() => "", "failed", false),
        binding: { provider: "naia", model: "grok-4.3" }, workdir: root, diag: { log() {} }, budget,
        callAllowance: { reservedUsd: 0.2, reservedInputTokens: 1_000, reservedOutputTokens: 500 } });
      await expect(facing.classify({ requestId: "r", idempotencyKey: "issue:failed", text: "fix",
        requiredObligations: ["fix"], signal: new AbortController().signal })).rejects.toThrow(/did not complete/u);
      expect(budget.snapshot()).toMatchObject({ paidCalls: 1, activeReservations: 0,
        chargedUsd: 0.01, costBasis: "estimated" });
      budget.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

function fakeAgent(text: () => string, identity: string, ok = true): SubAgentPort {
  return { spawn() {
    const evidence: SubAgentModelEvidence = { provider: "naia", selectedModel: "grok-4.3",
      modelEvidenceSource: "provider_reported", usageAvailable: true, inputTokens: 100, outputTokens: 50,
      totalTokens: 150, piEstimatedCost: 0.01, sessionId: `session-${identity}`, executionId: `execution-${identity}` };
    return { events: (async function* () { yield { kind: "text_delta" as const, text: text() };
      yield { kind: "model_evidence" as const, evidence }; yield { kind: "session_end" as const, ok, evidence }; })(),
      async cancel() {} };
  } };
}
