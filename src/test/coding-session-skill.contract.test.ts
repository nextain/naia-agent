import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { makeCodingSessionSkill } from "../main/adapters/coding-session-skill.js";
import type { ManagedIssueSession } from "../main/domain/multi-issue-session.js";
import type { MultiIssuePortfolio } from "../main/domain/multi-issue-session.js";
import type { MultiIssueSessionCommands, MultiIssueSessionQueries } from "../main/ports/multi-issue-session.js";

function session(overrides: Partial<ManagedIssueSession> = {}): ManagedIssueSession {
  return {
    version: 1,
    sessionId: "session-1",
    requestId: "request-1",
    requestDigest: "digest-secret",
    issueId: "issue-1",
    workspacePath: "/private/workspace",
    source: { kind: "local", sourceId: "source-1", actorId: "owner" },
    state: "queued",
    readyPriority: "normal",
    readySequence: 1,
    cancellationRequested: false,
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

function harness(overrides: Partial<MultiIssueSessionCommands & MultiIssueSessionQueries> = {}) {
  let stored = session();
  const api: MultiIssueSessionCommands & MultiIssueSessionQueries = {
    submit: vi.fn(async () => stored),
    answer: vi.fn(async () => stored),
    cancel: vi.fn(async () => stored),
    get: vi.fn(() => stored),
    list: vi.fn(() => [stored]),
    portfolio: vi.fn((): MultiIssuePortfolio => ({ sessions: [stored], counts: { queued: 1, running: 0, awaiting_user: 0,
      chat: 0, completed: 0, failed: 0, cancelled: 0, outcome_unknown: 0 },
      totalCost: { state: "unavailable", reason: "active" }, activeReservationsUsd: 0, budgetBlocked: false })),
    ...overrides,
  };
  const pump = vi.fn(async () => {});
  const skill = makeCodingSessionSkill({ sessions: api, pump, requestId: () => "stable-request",
    context: {
      workspacePath: "/trusted/workspace",
      actorId: "naia-cli-owner",
      naiaBinding: { provider: "naia", model: "assistant" },
      moderatorBinding: { provider: "codex", model: "luna" },
      workerProfiles: { trusted: { provider: "claude-code", model: "claude-sonnet" } },
    } });
  return { api, pump, skill, set(value: ManagedIssueSession) { stored = value; } };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: `call-${name}`, name, args });
const opts = () => ({ signal: new AbortController().signal });

describe("REQ-025 coding-session chat skill", () => {
  it("the ordinary chat host composes durable coding tools beside existing runtime dependencies", () => {
    const source = readFileSync(new URL("../../bin/naia-agent-chat.mjs", import.meta.url), "utf8");
    expect(source).toContain("makeCodingSessionSkill");
    expect(source).toContain("makePiContinuousLoop");
    expect(source).toContain("makeCompositeToolExecutor([codingExec");
    expect(source).toContain("deps.memory");
    expect(source).toContain("deps.personaSource");
    expect(source).toContain("deps.workspaceContextSource");
  });
  it("publishes only the five adapter-neutral lifecycle tools", () => {
    const names = harness().skill.specs().map((spec) => spec.name);
    expect(names).toEqual(["start_coding_task", "list_coding_tasks", "show_coding_task",
      "answer_coding_task", "cancel_coding_task"]);
    expect(JSON.stringify(harness().skill.specs())).not.toMatch(/codex|claude|opencode|pi/i);
  });

  it("starts from trusted host bindings and returns a redacted projection before background pump settles", async () => {
    const h = harness();
    let release!: () => void;
    h.pump.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const result = await h.skill.execute(call("start_coding_task", {
      task: "implement the requested change",
      obligations: ["preserve existing behavior", "run tests"],
      workspacePath: "/attacker/path",
      workerProfile: "attacker-profile",
    }), opts());
    expect(result.isError).toBeUndefined();
    expect(h.api.submit).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({
      requestId: "stable-request",
      workspacePath: "/trusted/workspace",
      naiaBinding: { provider: "naia", model: "assistant" },
      moderatorBinding: { provider: "codex", model: "luna" },
      workerProfiles: { trusted: { provider: "claude-code", model: "claude-sonnet" } },
      requiredObligations: ["preserve existing behavior", "run tests"],
    }) }));
    expect(h.pump).toHaveBeenCalledOnce();
    expect(result.output).toContain("session-1");
    expect(result.output).not.toMatch(/trusted\/workspace|attacker|digest-secret|implement the requested change/);
    release();
  });

  it("lists, shows, answers, and cancels exact session identities with safe grounded results", async () => {
    const h = harness();
    h.set(session({ state: "awaiting_user", report: {
      state: "awaiting_user", summary: "waiting for required input", issueId: "issue-1",
      question: { questionId: "question-1", text: "Which target?" }, changedFiles: [],
      verificationPassed: null, totalCost: { state: "unavailable", reason: "/private/billing-ledger.db is locked" },
      naiaCommentary: "raw model narrative must stay hidden",
    } }));
    const listed = await h.skill.execute(call("list_coding_tasks"), opts());
    const shown = await h.skill.execute(call("show_coding_task", { session_id: "session-1" }), opts());
    await h.skill.execute(call("answer_coding_task", { session_id: "session-1", question_id: "question-1", answer: "target A" }), opts());
    await h.skill.execute(call("cancel_coding_task", { session_id: "session-1" }), opts());
    expect(listed.output).toContain("question-1");
    expect(shown.output).not.toContain("raw model narrative");
    expect(shown.output).not.toContain("private/billing-ledger");
    expect(h.api.answer).toHaveBeenCalledWith("session-1", "question-1", "target A");
    expect(h.api.cancel).toHaveBeenCalledWith("session-1");
  });

  it("contains validation and store failures as tool errors", async () => {
    const h = harness({ get: () => { throw new Error("unknown session: missing"); } });
    expect(await h.skill.execute(call("start_coding_task", { task: " " }), opts())).toMatchObject({ isError: true });
    const missing = await h.skill.execute(call("show_coding_task", { session_id: "missing" }), opts());
    expect(missing).toMatchObject({ isError: true });
    expect(missing.output).toContain("unknown coding session");
    const internal = harness({ get: () => { throw new Error("EACCES: /private/session-store.db"); } });
    const failed = await internal.skill.execute(call("show_coding_task", { session_id: "session-1" }), opts());
    expect(failed.output).toContain("coding session command failed");
    expect(failed.output).not.toContain("private/session-store");
  });
});
