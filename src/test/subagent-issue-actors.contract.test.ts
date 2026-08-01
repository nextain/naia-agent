import { describe, expect, it } from "vitest";
import {
  makeIssueVerifierAdapter,
  makeSubAgentDevelopmentModerator,
  makeSubAgentNaiaFacing,
  makeSubAgentNaiaReporter,
} from "../main/adapters/subagent-issue-actors.js";
import type { SubAgentEvent } from "../main/domain/orchestration.js";
import type { SubAgentPort } from "../main/ports/orchestration.js";

function actor(text: string, model = "gpt-5.6-luna"): SubAgentPort {
  let call = 0;
  return {
    spawn(task) {
      call += 1;
      expect(task.filesystemAccess).toBe("read_only");
      const events: readonly SubAgentEvent[] = [
        { kind: "text_delta", text },
        {
          kind: "session_end",
          ok: true,
          evidence: {
            provider: "openai-codex",
            selectedModel: model,
            inputTokens: 20,
            cachedInputTokens: 5,
            outputTokens: 7,
            totalTokens: 27,
            sessionId: `session-${call}`,
            executionId: `execution-${call}`,
            measuredCostUsd: 0.002,
          },
        },
      ];
      return {
        events: (async function* () { yield* events; })(),
        async cancel() {},
      };
    },
  };
}

const diag = { log() {}, debug() {} };
const binding = { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "low" };

describe("UC-ORCH-001 sub-agent issue actors", () => {
  it("strictly maps facing and moderator JSON into durable contracts", async () => {
    const facing = makeSubAgentNaiaFacing({
      subAgent: actor('{"kind":"work","obligations":["fix parser","run tests"]}'),
      binding, workdir: "/workspace", diag,
    });
    const classified = await facing.classify({ requestId: "r-1", idempotencyKey: "i:facing", text: "fix it" });
    expect(classified.classification).toEqual({ kind: "work", obligations: ["fix parser", "run tests"] });
    expect(classified.receipt).toMatchObject({ role: "naia", model: "gpt-5.6-luna", cost: { state: "measured" } });

    const moderator = makeSubAgentDevelopmentModerator({
      subAgent: actor('{"workerTask":"Fix src/parser.ts","workerProfile":"balanced","acceptanceChecks":["node --test passes"],"questions":[]}', "gpt-5.6-sol"),
      binding: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
      allowedAcceptanceChecks: ["node --test passes"],
      workdir: "/workspace", diag,
    });
    const planned = await moderator.plan({ issueId: "i", idempotencyKey: "i:moderator", originalText: "fix it", obligations: classified.classification.obligations, answers: [] });
    expect(planned.plan).toEqual({ workerTask: "Fix src/parser.ts", workerProfile: "balanced", acceptanceChecks: ["node --test passes"], questions: [] });
    expect(planned.receipt).toMatchObject({ role: "moderator", model: "gpt-5.6-sol" });
  });

  it("rejects malformed actor output instead of guessing", async () => {
    const facing = makeSubAgentNaiaFacing({ subAgent: actor('{"kind":"maybe","obligations":[]}'), binding, workdir: "/workspace", diag });
    await expect(facing.classify({ requestId: "r", idempotencyKey: "k", text: "x" })).rejects.toThrow("schema mismatch");
  });

  it("grounds reporter fields in persisted evidence and prices deterministic verification at zero", async () => {
    const reporter = makeSubAgentNaiaReporter({ subAgent: actor('{"summary":"verified parser fix"}'), binding, workdir: "/workspace", diag });
    const issue = {
      version: 1, requestId: "r", requestDigest: "d", issueId: "i", originalText: "fix", workspacePath: "/workspace",
      state: "completed" as const, naiaBinding: binding, moderatorBinding: binding, answers: [], receipts: [],
      worker: { ok: true, summary: "done", worktreePath: "/managed/i", changedFiles: ["src/parser.ts"], receipt: undefined as never },
      verification: { ok: true, checks: [{ name: "test", pass: true }], receipt: undefined as never },
      createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:01Z",
    };
    const reported = await reporter.report({ issue, events: [], idempotencyKey: "i:report" });
    expect(reported.report).toMatchObject({ state: "completed", summary: "verified parser fix", changedFiles: ["src/parser.ts"], verificationPassed: true });

    const verifier = makeIssueVerifierAdapter({ async verify() { return { ok: false, checks: [{ name: "test", pass: false }] }; } }, (() => { let n = 10; return () => n += 5; })());
    const verified = await verifier.verify({ issueId: "i", idempotencyKey: "i:verify", worktreePath: "/managed/i", acceptanceChecks: ["test"] });
    expect(verified).toMatchObject({ ok: false, receipt: { role: "verifier", provider: "deterministic", latencyMs: 5, cost: { state: "measured", usd: 0 } } });
  });

  it("fails verification when a declared acceptance check was not executed", async () => {
    const verifier = makeIssueVerifierAdapter({ async verify() { return { ok: true, checks: [{ name: "different check", pass: true }] }; } });
    const result = await verifier.verify({ issueId: "i", idempotencyKey: "i:verify", worktreePath: "/managed/i", acceptanceChecks: ["required check"] });
    expect(result).toMatchObject({ ok: false, checks: [{ name: "required check", pass: false, details: "declared acceptance check was not executed" }] });
  });
});
