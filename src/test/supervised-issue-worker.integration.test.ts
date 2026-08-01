import { describe, expect, it } from "vitest";
import { makeSupervisedIssueWorker } from "../main/composition/supervised-issue-worker.js";
import type { SubAgentEvent } from "../main/domain/orchestration.js";
import { IssueActorResultError } from "../main/ports/issue-orchestration.js";

async function* events(): AsyncIterable<SubAgentEvent> {
  yield { kind: "planning" };
  yield { kind: "session_end", ok: true, evidence: {
    provider: "openai-codex", selectedModel: "gpt-5.6-terra", inputTokens: 100,
    reasoningEffort: "medium",
    cachedInputTokens: 40, outputTokens: 20, totalTokens: 120,
    sessionId: "codex-thread-1", executionId: "codex-execution-1", measuredCostUsd: 0.0004,
  } };
}

describe("UC-ORCH-001 supervised worker adapter", () => {
  it("composes managed worktree, supervisor, receipt, and dispatch dedupe before issue verification", async () => {
    let allocations = 0;
    const worker = makeSupervisedIssueWorker({
      worktrees: { allocate() { allocations += 1; return { workspacePath: "/repo", worktreePath: "/managed/issue", branch: "naia/issue", leaseId: "lease", release() {} }; } },
      subAgent: { spawn() { return { events: events(), async cancel() {} }; } },
      diag: { log() {}, debug() {} },
      changedFiles: () => ["src/parser.ts"],
      nowMs: (() => { let now = 100; return () => now += 10; })(),
    });
    const input = {
      issueId: "issue-0001", dispatchId: "issue-0001:dispatch:1", workspacePath: "/repo",
      task: "fix parser", profileId: "balanced", acceptanceChecks: ["test"], signal: new AbortController().signal,
      binding: { provider: "openai-codex", model: "gpt-5.6-terra", reasoningEffort: "medium" },
    };
    const first = await worker.execute(input);
    const duplicate = await worker.execute(input);
    expect(duplicate).toEqual(first);
    expect(allocations).toBe(1);
    expect(first).toMatchObject({ ok: true, summary: "session=true; issue verification pending", changedFiles: ["src/parser.ts"], receipt: {
      provider: "openai-codex", model: "gpt-5.6-terra", sessionId: "codex-thread-1",
      executionId: "codex-execution-1", cost: { state: "measured", usd: 0.0004 },
    } });
    expect(await worker.reconcile?.(input.dispatchId)).toEqual(first);
  });

  it("never fabricates worker identity when the provider omits model evidence", async () => {
    const worker = makeSupervisedIssueWorker({
      worktrees: { allocate() { return { workspacePath: "/repo", worktreePath: "/managed/issue", branch: "naia/issue", leaseId: "lease", release() {} }; } },
      subAgent: { spawn() { return { events: (async function* () { yield { kind: "session_end", ok: true } as const; })(), async cancel() {} }; } },
      diag: { log() {}, debug() {} }, changedFiles: () => [],
    });
    await expect(worker.execute({
      issueId: "issue-0002", dispatchId: "issue-0002:dispatch:1", workspacePath: "/repo",
      task: "fix", profileId: "balanced", acceptanceChecks: ["test"], signal: new AbortController().signal,
      binding: { provider: "openai-codex", model: "gpt-5.6-terra", reasoningEffort: "medium" },
    })).rejects.toThrow("worker receipt evidence unavailable");
  });

  it("carries the completed paid receipt when model-binding policy rejects the result", async () => {
    const worker = makeSupervisedIssueWorker({
      worktrees: { allocate() { return { workspacePath: "/repo", worktreePath: "/managed/issue", branch: "naia/issue", leaseId: "lease", release() {} }; } },
      subAgent: { spawn() { return { events: events(), async cancel() {} }; } },
      diag: { log() {}, debug() {} }, changedFiles: () => [],
    });
    const error = await worker.execute({
      issueId: "issue-0003", dispatchId: "issue-0003:dispatch:1", workspacePath: "/repo",
      task: "fix", profileId: "balanced", acceptanceChecks: ["test"], signal: new AbortController().signal,
      binding: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "medium" },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IssueActorResultError);
    expect((error as IssueActorResultError).receipt).toMatchObject({ role: "worker", model: "gpt-5.6-terra", cost: { state: "measured" } });
  });
});
