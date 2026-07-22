import { describe, expect, it } from "vitest";
import { CodingJobService } from "../main/app/coding-job-service.js";
import { JeonjuDiscordCourseService, parseJeonjuDiscordCourseConfig } from "../main/app/jeonju-discord-course.js";
import { DiscordChannelRuntime } from "../main/adapters/discord-channel.js";
import { wireAgentUC1 } from "../main/composition/index.js";
import type { JeonjuCoursePatch } from "../main/domain/jeonju-course.js";
import type { CodingJob } from "../main/domain/coding-job.js";
import type { CodingJobRunnerPort, CodingJobStore, CodingJobWorktreePort, SelectedWorkspaceCodingPort } from "../main/ports/coding-job.js";
import type { DiscordGatewayClose, DiscordGatewayConnection, DiscordGatewayHandlers, DiscordGatewayPort } from "../main/ports/discord.js";
import type { DiagnosticLog, ProviderPort, ToolExecutorPort } from "../main/ports/uc1.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeConnection implements DiscordGatewayConnection {
  readonly #done = deferred<DiscordGatewayClose>();
  readonly closed = this.#done.promise;
  readonly replies: string[] = [];
  readonly replyTargets: string[] = [];
  async sendReply(input: { guildId: string; channelId: string; messageId: string; content: string }): Promise<string> {
    if (!/^\d+$/.test(input.messageId)) throw new Error("invalid_reply");
    this.replyTargets.push(input.messageId);
    this.replies.push(input.content);
    return `reply_${this.replies.length}`;
  }
  close(): void { this.#done.resolve({ code: "closed", retryable: false }); }
}

class FakeGateway implements DiscordGatewayPort {
  readonly connection = new FakeConnection();
  handlers?: DiscordGatewayHandlers;
  async connect(_token: string, handlers: DiscordGatewayHandlers): Promise<DiscordGatewayConnection> {
    this.handlers = handlers;
    handlers.onReady("999");
    return this.connection;
  }
  message(messageId: string, content: string): void {
    this.handlers?.onMessage({
      messageId, guildId: "100", channelId: "200", authorId: "300", authorIsBot: false,
      content, mentionedUserIds: ["999"],
    });
  }
}

function waitFor(check: () => boolean): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) return resolve();
      if (Date.now() - started > 1_000) return reject(new Error("waitFor timeout"));
      setTimeout(poll, 0);
    };
    poll();
  });
}

describe("UC-JEONJU vertical Discord acceptance", () => {
  it("runs get_time, starts only the host-selected course target, and replies with safe lifecycle states", async () => {
    const gateway = new FakeGateway();
    const courseDedupeIds: string[] = [];
    const jobs = new Map<string, CodingJob>();
    let terminal: ((result: { ok: boolean; reason?: string; patch?: JeonjuCoursePatch }) => void) | undefined;
    const prepared: unknown[] = [];
    const store: CodingJobStore = { get: (id) => jobs.get(id), list: () => [...jobs.values()], save: (job) => jobs.set(job.jobId, job) };
    const worktrees: CodingJobWorktreePort = { allocate: () => { throw new Error("course must not allocate an isolated worktree"); } };
    const selectedWorkspace: SelectedWorkspaceCodingPort = {
      prepare: (input) => {
        prepared.push(input);
        return { workspacePath: input.workspacePath, worktreePath: input.workspacePath, branch: "selected", leaseId: "selected", release: () => {} };
      },
      apply: () => ({ ok: true, summary: "applied" }),
      verify: () => ({ ok: true, summary: "verified" }),
    };
    const runner: CodingJobRunnerPort = {
      start: ({ terminal: done }) => { terminal = done; return { cancel: async () => {} }; },
    };
    const config = parseJeonjuDiscordCourseConfig({
      version: 1,
      workspacePath: "D:/alpha-adk/projects/naia-adk/projects/student-page",
      allowedFiles: ["hero.svg", "index.html"],
    });
    expect(config).toBeDefined();
    let course!: JeonjuDiscordCourseService;
    const codingJobs = new CodingJobService({
      store, worktrees, selectedWorkspace, runner,
      courseLifecycle: { report: (event) => course.report(event) },
      ids: () => "job_vertical", now: () => "2026-07-22T00:00:00.000Z",
    });
    const runtime = new DiscordChannelRuntime({
      gateway,
      token: { load: async () => "secret" },
      dedupe: {
        reserve: async ({ messageId }) => {
          if (/^course_(received|running|completed|failed)_/.test(messageId)) courseDedupeIds.push(messageId);
          return { decision: "process" as const };
        },
        beginReply: async () => true,
        claimChunk: async () => true,
        confirmChunk: async () => true,
        complete: async () => true,
        partial: async () => true,
      },
      clock: { now: () => 1, sleep: async () => {} },
      text: { emptyReply: () => "EMPTY", failureReply: () => "FAILED", processingDisclosure: () => "PROCESSING" },
      diag: { log: () => {}, debug: () => {} } satisfies DiagnosticLog,
      courseCommand: {
        start: (input) => course.start(input),
      },
    }, {
      bindings: [{
        bindingId: "binding_1", guildId: "100", channelId: "200", allowedUserIds: ["300"],
        processingProfileRef: "profile_1", participation: "mentions",
      }],
    });
    course = new JeonjuDiscordCourseService({
      codingJobs,
      config: config!,
      status: { send: (event) => runtime.sendCourseLifecycle(event) },
    });
    let providerRound = 0;
    const provider: ProviderPort = {
      async *chat() {
        if (providerRound++ === 0) {
          yield { kind: "toolUse" as const, id: "time_call", name: "get_time", args: { timezone: "Asia/Seoul" } };
          yield { kind: "finish" as const };
          return;
        }
        yield { kind: "text" as const, text: "현재 시각입니다." };
        yield { kind: "finish" as const };
      },
    };
    const toolExecutor: ToolExecutorPort = {
      specs: () => [{ name: "get_time", description: "time", parameters: {} }],
      execute: async () => ({ output: "2026-07-22 14:31:00 (Asia/Seoul)" }),
    };
    const wired = wireAgentUC1({
      ingress: runtime.ingress, egress: runtime.egress, provider, toolExecutor,
      defaultConfig: { provider: "fake", model: "fake" },
      processingGuard: {
        authorize: () => ({ processingProfileRef: "profile_1", workload: "main_llm", destination: "local_device", decision: "allowed" }),
        authorizePlan: () => [],
        preparePlan: () => ({ disclosures: [], commit: () => true, rollback: () => true }),
      },
      diag: { log: () => {}, debug: () => {} },
    });
    wired.start?.();
    runtime.start();
    await waitFor(() => gateway.handlers !== undefined);

    gateway.message("4001", "<@999> get_time Asia/Seoul");
    await waitFor(() => gateway.connection.replies.length === 3);
    expect(gateway.connection.replies.at(-1)).toBe(
      "TOOL_RECORD state=succeeded tool=get_time value=2026-07-22 14:31:00 (Asia/Seoul)\n\n현재 시각입니다.",
    );

    gateway.message("4002", "<@999> /course 제목을 전주에서 만든 나의 AI 페이지로 바꿔줘");
    await waitFor(() => gateway.connection.replies.length === 5);
    expect(prepared).toEqual([{
      jobId: "job_vertical",
      workspacePath: "D:/alpha-adk/projects/naia-adk/projects/student-page",
      allowedFiles: ["index.html", "hero.svg"],
    }]);
    terminal?.({ ok: true, patch: { version: 1, files: [{ path: "index.html", content: "<img src=\"./hero.svg\">" }] } });
    await waitFor(() => gateway.connection.replies.length === 6);
    expect(gateway.connection.replies.slice(3)).toEqual([
      "수업 작업을 접수했습니다.",
      "수업 작업을 진행하고 있습니다.",
      "수업 작업이 완료되었습니다. Shell에서 결과를 확인해 주세요.",
    ]);
    expect(courseDedupeIds).toHaveLength(3);
    expect(new Set(courseDedupeIds).size).toBe(3);
    expect(courseDedupeIds.every((id) => /^course_(received|running|completed)_[a-f0-9]{32}$/.test(id))).toBe(true);
    expect(gateway.connection.replyTargets.slice(3)).toEqual(["4002", "4002", "4002"]);
    const publicEvidence = JSON.stringify(gateway.connection.replies);
    expect(publicEvidence).not.toContain("student-page");
    expect(publicEvidence).not.toContain("D:/alpha-adk");
    expect(publicEvidence).not.toContain("index.html");
    await runtime.stop();
  });

  it("rejects malformed or broadened host course configuration", () => {
    expect(parseJeonjuDiscordCourseConfig({ version: 1, workspacePath: "/safe", allowedFiles: ["index.html"] })).toBeUndefined();
    expect(parseJeonjuDiscordCourseConfig({ version: 1, workspacePath: "/safe", allowedFiles: ["index.html", "hero.svg", "extra.js"] })).toBeUndefined();
    expect(parseJeonjuDiscordCourseConfig({ version: 1, workspacePath: "/safe", allowedFiles: ["index.html", "hero.svg"], extra: true })).toBeUndefined();
  });
});
