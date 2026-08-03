import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runPiLoopControlSession } from "../main/composition/pi-continuous-loop-control.js";
import { makePiContinuousLoop, type PiContinuousLoopConfig } from "../main/composition/pi-continuous-loop.js";

describe("Pi continuous-loop command backend", () => {
  it("reopens one durable control state for budget and portfolio queries", () => {
    const root = mkdtempSync(join(tmpdir(), "naia-pi-loop-cli-"));
    try {
      const workspace = join(root, "workspace"); mkdirSync(workspace); mkdirSync(join(root, "worktrees"));
      const binding = { provider: "naia", model: "grok-4.3" };
      const config: PiContinuousLoopConfig = { stateDir: join(root, "state"), workspaceRoot: workspace,
        worktreeRoot: join(root, "worktrees"), facing: binding, moderator: binding, reporter: binding,
        roles: { explorer: binding, implementer: binding, tester: binding, reviewer: binding },
        profileId: "economy-pi", maxRepairCycles: 1, requiredCleanCycles: 1,
        acceptanceChecks: [{ name: "test", command: process.execPath, args: ["--version"] }],
        concurrency: 2, budget: { maxPaidCalls: 8, maxUsd: 0.2, maxInputTokens: 10_000, maxOutputTokens: 4_000 },
        callAllowance: { reservedUsd: 0.02, reservedInputTokens: 1_000, reservedOutputTokens: 400 } };
      let loop = makePiContinuousLoop(config);
      expect(loop.budget.snapshot()).toMatchObject({ paidCalls: 0, activeReservations: 0, maxPaidCalls: 8 });
      expect(loop.sessions.portfolio()).toMatchObject({ sessions: [], activeReservationsUsd: 0, budgetBlocked: false });
      loop.close(); loop = makePiContinuousLoop(config);
      expect(loop.budget.snapshot()).toMatchObject({ paidCalls: 0, activeReservations: 0 });
      expect(loop.sessions.list()).toEqual([]); loop.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps one NDJSON control session for multiple starts and reports a background pump failure", async () => {
    const submissions: unknown[] = []; let sequence = 0;
    const loop = { profile: { kind: "team" }, sessions: {
      async submit(input: unknown) { submissions.push(input); return { sessionId: `s-${++sequence}` }; },
      async answer() { return {}; }, async cancel() { return {}; }, get(id: string) { return { sessionId: id }; },
      portfolio() { return { sessions: submissions.length }; }, async pump() { throw new Error("fixture scheduler failure"); },
    }, budget: { snapshot() { return { paidCalls: 0 }; }, reservations() { return []; } } };
    const responses: Array<{ id: unknown; ok: boolean; error?: string }> = [];
    await runPiLoopControlSession(loop, { profileId: "economy", facing: { provider: "naia", model: "grok-4.3" },
      moderator: { provider: "naia", model: "grok-4.3" } }, lines([
        JSON.stringify({ id: "a", command: "start", request: { requestId: "r1", text: "one",
          requiredObligations: ["one"], workspacePath: "/workspace/one" } }),
        JSON.stringify({ id: "b", command: "start", request: { requestId: "r2", text: "two",
          requiredObligations: ["two"], workspacePath: "/workspace/two" } }),
        JSON.stringify({ id: "c", command: "list" }),
      ]), (response) => responses.push(response));
    expect(submissions).toHaveLength(2);
    expect(responses.map((response) => response.id)).toEqual(["a", "b", "c"]);
    expect(responses.some((response) => response.ok === false
      && response.error?.includes("background pump failed"))).toBe(true);
  });

  it("emits a terminal failure when stdin closes before a late background pump rejection", async () => {
    const responses: Array<{ id: unknown; ok: boolean; error?: string }> = [];
    const loop = { profile: {}, sessions: { async submit() { return { sessionId: "s" }; }, async answer() {},
      async cancel() {}, get() {}, portfolio() { return {}; }, async pump() {
        await new Promise((resolve) => setImmediate(resolve)); throw new Error("late failure");
      } }, budget: { snapshot() { return {}; }, reservations() { return []; } } };
    await runPiLoopControlSession(loop, { profileId: "p", facing: { provider: "naia", model: "grok-4.3" },
      moderator: { provider: "naia", model: "grok-4.3" } }, lines([JSON.stringify({ id: "start", command: "start",
        request: { text: "x", requiredObligations: ["x"], workspacePath: "/workspace" } })]),
    (response) => responses.push(response));
    expect(responses.at(-1)).toMatchObject({ id: null, ok: false, error: expect.stringContaining("late failure") });
  });

  it("serializes and drains every pump requested by overlapping start commands before EOF", async () => {
    let active = 0; let maximumActive = 0; let pumpCalls = 0;
    const responses: Array<{ ok: boolean }> = [];
    const loop = { profile: {}, sessions: { async submit() { return { sessionId: "s" }; }, async answer() {},
      async cancel() {}, get() {}, portfolio() { return {}; }, async pump() { pumpCalls += 1; active += 1;
        maximumActive = Math.max(maximumActive, active); await new Promise((resolve) => setImmediate(resolve)); active -= 1;
      } }, budget: { snapshot() { return {}; }, reservations() { return []; } } };
    const request = (id: string) => JSON.stringify({ id, command: "start",
      request: { requestId: id, text: id, requiredObligations: [id], workspacePath: `/workspace/${id}` } });
    await runPiLoopControlSession(loop, { profileId: "p", facing: { provider: "naia", model: "grok-4.3" },
      moderator: { provider: "naia", model: "grok-4.3" } }, immediateLines([request("a"), request("b")]),
    (response) => responses.push(response));
    expect(responses).toHaveLength(2); expect(maximumActive).toBe(1); expect(pumpCalls).toBe(2); expect(active).toBe(0);
  });

});

async function* lines(values: readonly string[]) {
  for (const value of values) { yield value; await new Promise((resolve) => setImmediate(resolve)); }
}
async function* immediateLines(values: readonly string[]) { for (const value of values) yield value; }
