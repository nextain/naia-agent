import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteIssueTeamStore } from "../main/adapters/sqlite-issue-team-store.js";
import type { SpawnFn } from "../main/adapters/subprocess-session.js";
import { makeProfiledIssueWorker } from "../main/composition/profiled-issue-worker.js";
import type { ActorReceipt, WorkerResult } from "../main/domain/issue-orchestration.js";
import type { IssueTeamProfile } from "../main/domain/issue-team.js";
import type { IssueWorkerPort } from "../main/ports/issue-orchestration.js";

const team: IssueTeamProfile = { kind: "team", maxRepairCycles: 1, requiredCleanCycles: 1, roles: {
  explorer: declared("explorer", "read_only"), implementer: declared("implementer", "workspace_write"),
  tester: declared("tester", "read_only"), reviewer: declared("reviewer", "read_only"),
} };
function declared(role: "explorer" | "implementer" | "tester" | "reviewer", filesystemAccess: "read_only" | "workspace_write") {
  return { agentProfileId: `${role}-codex`, agentKind: "codex" as const, binding: { provider: "openai-codex", model: "fixture-model" }, filesystemAccess };
}
function input(issueId: string, profileId: string, profile: Parameters<IssueWorkerPort["execute"]>[0]["profile"]) {
  return { issueId, dispatchId: `${issueId}:dispatch:1`, workspacePath: "/repo", task: "fix", obligations: ["fix"], profileId, profile,
    ...(profile && !("kind" in profile) ? { binding: profile } : {}), acceptanceChecks: ["tests"], signal: new AbortController().signal };
}

describe("REQ-023 production profiled issue worker composition", () => {
  it("routes one immutable catalog to legacy or real durable team composition", async () => {
    const root = mkdtempSync(join(tmpdir(), "profiled-worker-"));
    try {
      const store = new SqliteIssueTeamStore(join(root, "team.db")); let legacyCalls = 0; let allocations = 0;
      const legacyProfile = { provider: "openai-codex", model: "legacy-model" };
      const legacyResult = result("legacy:dispatch:1", legacyProfile);
      const legacy: IssueWorkerPort = { async execute() { legacyCalls += 1; return legacyResult; }, async recover() { return legacyResult; }, async reconcile() { return legacyResult; } };
      const worker = makeProfiledIssueWorker({ legacy, profiles: { legacy: legacyProfile, team }, store,
        worktrees: { allocate() { allocations += 1; return { workspacePath: "/repo", worktreePath: "/managed/team", branch: "naia/team", leaseId: "lease", release() {} }; }, recover() { return true; } },
        diag: { log() {}, debug() {} }, changedFiles: () => ["src/fix.ts"],
        agentEnvironment: { codex: { resolveBin: () => ({ command: "codex", prefixArgs: [] }), spawnFn: codexFixture() } } });

      expect(await worker.execute(input("legacy", "legacy", legacyProfile))).toEqual(legacyResult);
      const completed = await worker.execute(input("team", "team", team));
      expect(legacyCalls).toBe(1); expect(allocations).toBe(1);
      expect(completed).toMatchObject({ ok: true, changedFiles: ["src/fix.ts"], team: { cleanCycles: 1, repairCycles: 0 } });
      expect(completed.receipts?.map((receipt) => receipt.workerRole)).toEqual(["explorer", "implementer", "tester", "reviewer"]);
      expect(await worker.recover?.(input("team", "team", team))).toEqual(completed);

      const alteredTeam = { ...team, maxRepairCycles: 2 };
      await expect(worker.execute(input("altered", "team", alteredTeam))).rejects.toThrow("does not match declared catalog");
      await expect(worker.recover?.(input("altered", "team", alteredTeam))).rejects.toThrow("does not match declared catalog");
      await expect(worker.execute(input("unknown", "missing", team))).rejects.toThrow("does not match declared catalog");
      expect(allocations).toBe(1);

      const alteredLegacy = { ...legacyProfile, model: "undeclared-model" };
      await expect(worker.execute(input("altered-legacy", "legacy", alteredLegacy))).rejects.toThrow("does not match declared catalog");
      expect(legacyCalls).toBe(1);
      store.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

function codexFixture(): SpawnFn {
  return (_command, args) => {
    let stdout: ((data: Buffer) => void) | undefined; const handlers: Record<string, (...values: unknown[]) => void> = {}; let closed = false;
    const child = { stdout: { on(_event: string, callback: (data: Buffer) => void) { stdout = callback; } }, stderr: { on() {} },
      on(event: string, callback: (...values: unknown[]) => void) { handlers[event] = callback; return this; },
      kill() { if (!closed) { closed = true; queueMicrotask(() => handlers.close?.(0, null)); } return true; } };
    queueMicrotask(() => {
      const prompt = String(args.at(-1)); const role = /You are the (explorer|implementer|tester|reviewer) /u.exec(prompt)?.[1];
      if (!role) { handlers.error?.(new Error("role missing from production prompt")); return; }
      const decision = role === "explorer" ? "proceed" : role === "implementer" ? "implemented" : role === "tester" ? "pass" : "clean";
      const lines = [{ type: "thread.started", thread_id: `thread-${role}` },
        { type: "item.completed", item: { id: `item-${role}`, type: "agent_message", text: JSON.stringify({ version: 1, role, decision, summary: "ok", findings: [] }) } },
        { type: "turn.completed", usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1 } }];
      stdout?.(Buffer.from(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8"));
      if (!closed) { closed = true; handlers.close?.(0, null); }
    });
    return child as unknown as ChildProcess;
  };
}
function result(key: string, binding: { provider: string; model: string }): WorkerResult {
  const receipt: ActorReceipt = { role: "worker", provider: binding.provider, model: binding.model, sessionId: "legacy-session", executionId: "legacy-execution",
    idempotencyKey: key, tokenCountsAvailable: true, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, latencyMs: 1,
    cost: { state: "measured", usd: 0.001, source: "fixture" } };
  return { ok: true, summary: "legacy", worktreePath: "/managed/legacy", changedFiles: [], receipt };
}
