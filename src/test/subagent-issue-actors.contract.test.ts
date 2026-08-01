import { describe, expect, it } from "vitest";
import {
  makeIssueVerifierAdapter,
  makeSubAgentDevelopmentModerator,
  makeSubAgentNaiaFacing,
  makeSubAgentNaiaReporter,
} from "../main/adapters/subagent-issue-actors.js";
import type { SubAgentEvent } from "../main/domain/orchestration.js";
import { groundedIssueCommentary } from "../main/domain/issue-orchestration.js";
import type { SubAgentPort } from "../main/ports/orchestration.js";
import { IssueActorResultError } from "../main/ports/issue-orchestration.js";

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
            reasoningEffort: model === "gpt-5.6-sol" ? "high" : "low",
            inputTokens: 20,
            cachedInputTokens: 5,
            outputTokens: 7,
            totalTokens: 27,
            usageAvailable: true,
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
const signal = () => new AbortController().signal;

describe("UC-ORCH-001 sub-agent issue actors", () => {
  it("strictly maps facing and moderator JSON into durable contracts", async () => {
    const facing = makeSubAgentNaiaFacing({
      subAgent: actor('{"kind":"work","obligations":["fix parser","run tests"]}'),
      binding, workdir: "/workspace", diag,
    });
    const classified = await facing.classify({ requestId: "r-1", idempotencyKey: "i:facing", text: "fix it", requiredObligations: ["fix parser", "run tests"], signal: signal() });
    expect(classified.classification).toEqual({ kind: "work", obligations: ["fix parser", "run tests"] });
    expect(classified.receipt).toMatchObject({ role: "naia", model: "gpt-5.6-luna", cost: { state: "measured" } });

    const moderator = makeSubAgentDevelopmentModerator({
      subAgent: actor('{"workerTask":"Fix src/parser.ts","workerProfile":"balanced","acceptanceChecks":["node --test passes"],"questions":[]}', "gpt-5.6-sol"),
      binding: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
      allowedAcceptanceChecks: ["node --test passes"],
      workdir: "/workspace", diag,
    });
    const planned = await moderator.plan({ issueId: "i", idempotencyKey: "i:moderator", originalText: "fix it", obligations: classified.classification.obligations, answers: [], signal: signal() });
    expect(planned.plan).toEqual({ workerTask: "Fix src/parser.ts", workerProfile: "balanced", acceptanceChecks: ["node --test passes"], questions: [] });
    expect(planned.receipt).toMatchObject({ role: "moderator", model: "gpt-5.6-sol" });
  });

  it("rejects malformed actor output instead of guessing", async () => {
    const facing = makeSubAgentNaiaFacing({ subAgent: actor('{"kind":"maybe","obligations":[]}'), binding, workdir: "/workspace", diag });
    const error = await facing.classify({ requestId: "r", idempotencyKey: "k", text: "x", requiredObligations: [], signal: signal() }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IssueActorResultError);
    expect(error).toMatchObject({ message: expect.stringContaining("schema mismatch"), receipt: { role: "naia", idempotencyKey: "k", cost: { state: "measured" } } });

    const dropped = makeSubAgentNaiaFacing({
      subAgent: actor('{"kind":"work","obligations":["fix parser"]}'), binding, workdir: "/workspace", diag,
    });
    await expect(dropped.classify({
      requestId: "r", idempotencyKey: "k:dropped", text: "fix parser and run tests",
      requiredObligations: ["fix parser", "run tests"], signal: signal(),
    })).rejects.toThrow("obligation binding mismatch");
  });

  it("treats omitted usage availability as unavailable even when a zero measured cost is present", async () => {
    const omittedUsage: SubAgentPort = { spawn() { return {
      events: (async function* () {
        yield { kind: "text_delta", text: '{"kind":"work","obligations":["fix"]}' } as const;
        yield { kind: "session_end", ok: true, evidence: {
          provider: "openai-codex", selectedModel: "gpt-5.6-luna", reasoningEffort: "low",
          inputTokens: 0, outputTokens: 0, totalTokens: 0, sessionId: "session-omitted", executionId: "execution-omitted",
          measuredCostUsd: 0,
        } } as const;
      })(), async cancel() {},
    }; } };
    const facing = makeSubAgentNaiaFacing({ subAgent: omittedUsage, binding, workdir: "/workspace", diag });
    const result = await facing.classify({ requestId: "r", idempotencyKey: "k", text: "fix", requiredObligations: ["fix"], signal: signal() });
    expect(result.receipt).toMatchObject({
      tokenCountsAvailable: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
      cost: { state: "unavailable" },
    });
  });

  it("attaches the completed paid receipt when actor binding evidence drifts", async () => {
    const facing = makeSubAgentNaiaFacing({
      subAgent: actor('{"kind":"work","obligations":["fix"]}', "gpt-5.6-sol"),
      binding, workdir: "/workspace", diag,
    });
    const error = await facing.classify({
      requestId: "r", idempotencyKey: "k:binding-drift", text: "fix", requiredObligations: ["fix"], signal: signal(),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IssueActorResultError);
    expect(error).toMatchObject({
      message: expect.stringContaining("binding mismatch"),
      receipt: {
        role: "naia", provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high",
        idempotencyKey: "k:binding-drift", cost: { state: "measured", usd: 0.002 },
      },
    });
  });

  it("grounds reporter fields in persisted evidence and prices deterministic verification at zero", async () => {
    const issue = {
      version: 1, requestId: "r", requestDigest: "d", issueId: "i", originalText: "fix", requiredObligations: ["fix"], workspacePath: "/workspace",
      state: "completed" as const, naiaBinding: binding, moderatorBinding: binding, workerProfiles: {}, answers: [], receipts: [],
      worker: { ok: true, summary: "done", worktreePath: "/managed/i", changedFiles: ["src/parser.ts"], receipt: undefined as never },
      verification: { ok: true, checks: [{ name: "test", pass: true }], receipt: undefined as never },
      createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:01Z",
    };
    const expectedSummary = groundedIssueCommentary(issue, "completed");
    const reporter = makeSubAgentNaiaReporter({ subAgent: actor(JSON.stringify({ summary: expectedSummary })), binding, workdir: "/workspace", diag });
    const reported = await reporter.report({ issue, events: [], idempotencyKey: "i:report", signal: signal() });
    expect(reported.report).toMatchObject({ state: "completed", summary: expectedSummary, changedFiles: ["src/parser.ts"], verificationPassed: true });

    const contradicted = makeSubAgentNaiaReporter({ subAgent: actor('{"summary":"verification remains pending"}'), binding, workdir: "/workspace", diag });
    await expect(contradicted.report({ issue, events: [], idempotencyKey: "i:report:bad", signal: signal() }))
      .rejects.toMatchObject({ message: expect.stringContaining("evidence binding mismatch"), receipt: { role: "reporter" } });

    await expect(reporter.report({
      issue: { ...issue, state: "outcome_unknown" } as never,
      events: [], idempotencyKey: "i:report:invalid-state", signal: signal(),
    })).rejects.toThrow("requires a completed or failed issue");

    const verifier = makeIssueVerifierAdapter({ async verify() { return { ok: false, checks: [{ name: "test", pass: false }] }; } }, (() => { let n = 10; return () => n += 5; })());
    const verified = await verifier.verify({ issueId: "i", idempotencyKey: "i:verify", worktreePath: "/managed/i", acceptanceChecks: ["test"], signal: signal() });
    expect(verified).toMatchObject({ ok: false, receipt: { role: "verifier", provider: "deterministic", latencyMs: 5, cost: { state: "measured", usd: 0 } } });
  });

  it("fails verification when a declared acceptance check was not executed", async () => {
    const verifier = makeIssueVerifierAdapter({ async verify() { return { ok: true, checks: [{ name: "different check", pass: true }] }; } });
    const result = await verifier.verify({ issueId: "i", idempotencyKey: "i:verify", worktreePath: "/managed/i", acceptanceChecks: ["required check"], signal: signal() });
    expect(result).toMatchObject({ ok: false, checks: [{ name: "required check", pass: false, details: "declared acceptance check was not executed" }] });
  });

  it("requires canonical acceptance-check policy and rejects model drift from it", async () => {
    const withoutPolicy = makeSubAgentDevelopmentModerator({
      subAgent: actor('{"workerTask":"fix","workerProfile":"balanced","acceptanceChecks":["test"],"questions":[]}', "gpt-5.6-sol"),
      binding: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" }, workdir: "/workspace", diag,
    });
    await expect(withoutPolicy.plan({ issueId: "i", idempotencyKey: "k", originalText: "fix", obligations: ["fix"], answers: [], signal: signal() }))
      .rejects.toThrow("acceptance check policy missing");

    const drifted = makeSubAgentDevelopmentModerator({
      subAgent: actor('{"workerTask":"fix","workerProfile":"balanced","acceptanceChecks":["different"],"questions":[]}', "gpt-5.6-sol"),
      binding: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
      allowedAcceptanceChecks: ["required"], workdir: "/workspace", diag,
    });
    await expect(drifted.plan({ issueId: "i", idempotencyKey: "k", originalText: "fix", obligations: ["fix"], answers: [], signal: signal() }))
      .rejects.toThrow("acceptance check binding mismatch");
  });

  it("bounds a silent paid actor with the configured timeout", async () => {
    let cancelled = 0;
    const silent: SubAgentPort = { spawn() { return {
      events: (async function* () { await new Promise((resolve) => setTimeout(resolve, 25)); yield { kind: "session_end", ok: false } as const; })(),
      async cancel() { cancelled += 1; },
    }; } };
    const facing = makeSubAgentNaiaFacing({ subAgent: silent, binding, timeoutMs: 5, workdir: "/workspace", diag });
    await expect(facing.classify({ requestId: "r", idempotencyKey: "k", text: "fix", requiredObligations: ["fix"], signal: signal() })).rejects.toThrow("actor timed out");
    expect(cancelled).toBe(1);
  });

  it("cancels the underlying sub-agent session when the orchestration signal aborts", async () => {
    let release!: () => void;
    let cancelled = 0;
    const waiting: SubAgentPort = { spawn() { return {
      events: (async function* () { await new Promise<void>((resolve) => { release = resolve; }); yield { kind: "session_end", ok: false } as const; })(),
      async cancel() { cancelled += 1; release(); },
    }; } };
    const controller = new AbortController();
    const facing = makeSubAgentNaiaFacing({ subAgent: waiting, binding, workdir: "/workspace", diag });
    const result = facing.classify({ requestId: "r", idempotencyKey: "k", text: "fix", requiredObligations: ["fix"], signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(result).rejects.toThrow("actor cancelled");
    expect(cancelled).toBe(1);
  });
});
