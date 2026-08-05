import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import { makeCodingSessionSkill } from "../main/adapters/coding-session-skill.js";
import { SqliteMultiIssueSessionStore } from "../main/adapters/sqlite-multi-issue-session-store.js";
import { ChatTurnHandler } from "../main/app/chat-turn-handler.js";
import { MultiIssueSessionManager } from "../main/app/multi-issue-session-manager.js";
import type { AgentEmit, ChatRequest, ProviderChunk } from "../main/domain/chat.js";
import type { IssueReport, IssueSnapshot, IssueStartRequest } from "../main/domain/issue-orchestration.js";
import type { MemoryPort } from "../main/ports/memory.js";
import type { SingleIssueExecutionPort } from "../main/ports/multi-issue-session.js";
import type { ProviderPort } from "../main/ports/uc1.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

function report(issueId: string, state: IssueReport["state"], summary: string, questionId?: string): IssueReport {
  return {
    state, summary, issueId, changedFiles: state === "completed" ? ["src/feature.ts"] : [],
    verificationPassed: state === "completed" ? true : null,
    totalCost: { state: "measured", usd: 0, source: "scenario_fixture" },
    ...(questionId ? { question: { questionId, text: "Which acceptance target should be used?" } } : {}),
  };
}

function fakeIssues(): SingleIssueExecutionPort {
  const snapshots = new Map<string, IssueSnapshot>();
  let next = 0;
  return {
    ensure(request: IssueStartRequest) {
      const issueId = `issue-${++next}`;
      const snapshot: IssueSnapshot = {
        version: 1, requestId: request.requestId, requestDigest: `digest-${issueId}`, issueId,
        originalText: request.text, requiredObligations: request.requiredObligations,
        workspacePath: request.workspacePath, state: "accepted", naiaBinding: request.naiaBinding,
        moderatorBinding: request.moderatorBinding, workerProfiles: request.workerProfiles,
        answers: [], receipts: [], createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z",
      };
      snapshots.set(issueId, snapshot);
      return snapshot;
    },
    async resume(issueId) { return report(issueId, "awaiting_user", "waiting for user", `${issueId}-question`); },
    async answer(issueId, questionId, answer) {
      expect(questionId).toBe(`${issueId}-question`);
      expect(answer).toBe("use the strict target");
      return report(issueId, "completed", "implementation and verification completed");
    },
    async cancel(issueId) { return report(issueId, "cancelled", "cancelled by user"); },
    snapshot(issueId) {
      const snapshot = snapshots.get(issueId);
      if (!snapshot) throw new Error(`unknown fixture issue: ${issueId}`);
      return snapshot;
    },
  };
}

function commandProvider(captured: { prompts: string[]; tools: string[][]; results: string[] }): ProviderPort {
  return {
    async *chat(_config, messages, opts): AsyncIterable<ProviderChunk> {
      captured.prompts.push(opts.systemPrompt ?? "");
      captured.tools.push((opts.tools ?? []).map((tool) => tool.name));
      const toolResult = [...messages].reverse().find((message) => message.role === "tool");
      if (toolResult) {
        captured.results.push(toolResult.content);
        yield { kind: "text", text: "Naia confirmed the durable coding-session result." };
        yield { kind: "finish" };
        return;
      }
      const text = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
      const sessionId = text.includes("second") ? "session-2" : "session-1";
      const command = text.startsWith("start")
        ? { name: "start_coding_task", args: { task: text, obligations: ["preserve behavior", "run verification"] } }
        : text.startsWith("list")
          ? { name: "list_coding_tasks", args: {} }
          : text.startsWith("show")
            ? { name: "show_coding_task", args: { session_id: sessionId } }
            : text.startsWith("answer")
              ? { name: "answer_coding_task", args: {
                session_id: sessionId, question_id: "issue-1-question", answer: "use the strict target",
              } }
              : { name: "cancel_coding_task", args: { session_id: sessionId } };
      yield { kind: "toolUse", id: `call-${command.name}`, ...command };
      yield { kind: "finish" };
    },
  };
}

async function waitForState(manager: MultiIssueSessionManager, sessionId: string, state: string): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (manager.get(sessionId).state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`session ${sessionId} did not reach ${state}; current=${manager.get(sessionId).state}`);
}

describe("UC-024 Naia coding assistant actual conversation scenario", () => {
  it("boots the real CLI host with --coding-config and closes its durable runtime without a paid call", async () => {
    const root = mkdtempSync(join(tmpdir(), "naia-coding-cli-scenario-")); dirs.push(root);
    const home = join(root, "home");
    const stateDir = join(root, "state");
    const worktreeRoot = join(root, "worktrees");
    const configPath = join(root, "coding.json");
    const workspaceRoot = resolve(".");
    writeFileSync(configPath, JSON.stringify({
      stateDir, workspaceRoot, worktreeRoot,
      facing: { provider: "naia", model: "deepseek-v4-flash" },
      moderator: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "medium" },
      reporter: { provider: "naia", model: "deepseek-v4-flash" },
      roles: {
        explorer: { provider: "naia", model: "grok-4.3" },
        implementer: { provider: "naia", model: "grok-4.3" },
        tester: { provider: "naia", model: "grok-4.3" },
        reviewer: { provider: "naia", model: "grok-4.3" },
      },
      profileId: "scenario-balanced", maxRepairCycles: 1, requiredCleanCycles: 2,
      acceptanceChecks: [{ name: "node", command: process.execPath, args: ["--version"] }], concurrency: 1,
      budget: { maxPaidCalls: 2, maxUsd: 0.1, maxInputTokens: 10_000, maxOutputTokens: 2_000 },
      callAllowance: { reservedUsd: 0.05, reservedInputTokens: 5_000, reservedOutputTokens: 1_000 },
    }), { mode: 0o600 });
    const env = {
      ...process.env, HOME: home, USERPROFILE: home,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, "no-session-bus")}`,
      AGENT_PROVIDER: "fake", NAIA_AGENT_MEMORY: "off", NAIA_AGENT_SKILLS: "off",
      NAIA_AGENT_TRANSCRIPT: "off",
      NAIA_API_KEY: "", NAIA_ANYLLM_API_KEY: "",
    };
    const result = await run(process.execPath, [resolve("bin/naia-agent.mjs"), "chat",
      "--once", "hello from the actual host", "--provider", "fake", "--model", "scenario",
      "--workspace", workspaceRoot, "--coding-config", configPath], env);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("(fake) 안녕하세요, 나이아입니다.");
    expect(result.stderr).toContain("coding=durable");
    expect(result.stderr).toContain("provider=fake/scenario");
    expect(existsSync(join(stateDir, "sessions.db"))).toBe(true);
    expect(existsSync(join(stateDir, "issues.db"))).toBe(true);
    expect(existsSync(join(stateDir, "teams.db"))).toBe(true);
    expect(existsSync(join(stateDir, "paid-calls.db"))).toBe(true);
  }, 30_000);

  it("keeps persona, memory, and workspace context while controlling durable coding sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "naia-coding-assistant-scenario-")); dirs.push(dir);
    const store = new SqliteMultiIssueSessionStore(join(dir, "sessions.sqlite"));
    let nextSession = 0;
    const manager = new MultiIssueSessionManager({
      store, issues: fakeIssues(), concurrency: 1, autoPump: false,
      ids: () => `session-${++nextSession}`, ownerIds: () => "scenario-owner",
      now: () => "2026-08-06T00:00:00.000Z", clockMs: () => 1_000,
    });
    const skill = makeCodingSessionSkill({
      sessions: manager, pump: () => manager.pump(),
      context: {
        workspacePath: dir, actorId: "luke",
        naiaBinding: { provider: "naia", model: "assistant" },
        moderatorBinding: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "medium" },
        workerProfiles: { balanced: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "medium" } },
      },
    });
    const recalled: string[] = [];
    const saved: Array<[string, string]> = [];
    const memory: MemoryPort = {
      async recall(query) { recalled.push(query); return { facts: ["Luke prefers cost-balanced coding profiles."], episodes: [] }; },
      async save(user, assistant) { saved.push([user, assistant]); },
    };
    const captured = { prompts: [] as string[], tools: [] as string[][], results: [] as string[] };
    const emits = new Map<string, AgentEmit[]>();
    const handler = new ChatTurnHandler({
      provider: commandProvider(captured),
      conversation: { assemble: (request) => request },
      credentials: { update: () => {}, get: () => undefined },
      approval: makeInMemoryApproval(),
      egress: { emit: (requestId, event) => emits.set(requestId, [...(emits.get(requestId) ?? []), event]) },
      diag: { log: () => {} }, toolExecutor: skill, memory,
      personaSource: { load: () => ({ agentName: "Naia", userName: "Luke", locale: "ko", speechStyle: "formal",
        systemPromptPrefix: "You are Luke's orchestration assistant." }) },
      workspaceContext: { snapshot: () => ({ cwd: dir, projects: ["alpha-adk", "naia-agent"], projectTotal: 2 }) },
    });
    const turn = async (requestId: string, text: string) => {
      const request: ChatRequest = { kind: "chat", requestId, provider: { provider: "fake", model: "scenario" },
        messages: [{ role: "user", content: text }], enableTools: true };
      await handler.onChatRequest(request);
      expect(emits.get(requestId)?.map((event) => event.kind)).toEqual(["toolUse", "toolResult", "text", "usage", "finish"]);
    };

    await turn("turn-start-1", "start first coding task");
    await waitForState(manager, "session-1", "awaiting_user");
    await turn("turn-list", "list coding tasks");
    await turn("turn-show", "show first coding task");
    await turn("turn-answer", "answer first coding task");
    await waitForState(manager, "session-1", "completed");
    await turn("turn-start-2", "start second coding task");
    await waitForState(manager, "session-2", "awaiting_user");
    await turn("turn-cancel", "cancel second coding task");
    await waitForState(manager, "session-2", "cancelled");

    expect(manager.get("session-1")).toMatchObject({ state: "completed",
      report: { verificationPassed: true, changedFiles: ["src/feature.ts"] } });
    expect(manager.get("session-2")).toMatchObject({ state: "cancelled", cancellationRequested: true });
    expect(captured.results).toHaveLength(6);
    expect(captured.results.join("\n")).toContain("session-1");
    expect(captured.results.join("\n")).toContain("issue-1-question");
    expect(captured.results.join("\n")).not.toContain("digest-issue");
    expect(captured.results.join("\n")).not.toContain(dir);
    expect(captured.tools.every((tools) => ["start_coding_task", "list_coding_tasks", "show_coding_task",
      "answer_coding_task", "cancel_coding_task"].every((name) => tools.includes(name)))).toBe(true);
    expect(captured.prompts.every((prompt) => prompt.includes("Luke's orchestration assistant"))).toBe(true);
    expect(captured.prompts.every((prompt) => prompt.includes("Projects (2): alpha-adk, naia-agent"))).toBe(true);
    expect(captured.prompts.every((prompt) => prompt.includes("Luke prefers cost-balanced coding profiles"))).toBe(true);
    expect(recalled).toEqual(["start first coding task", "list coding tasks", "show first coding task",
      "answer first coding task", "start second coding task", "cancel second coding task"]);
    expect(saved).toHaveLength(6);
    expect(saved.every(([, assistant]) => assistant.includes("Naia confirmed"))).toBe(true);
    store.close();
  });
});
