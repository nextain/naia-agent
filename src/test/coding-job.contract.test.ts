import { describe, expect, it, vi } from "vitest";
import { CodingJobService, CodingJobResumeUnavailableError } from "../main/app/coding-job-service.js";
import { decodeCodingJobStdio, dispatchCodingJobStdio } from "../main/adapters/coding-job-stdio.js";
import { makeCodexCodingJobRunner } from "../main/adapters/coding-job-codex-runner.js";
import { makeGitCodingJobWorktrees } from "../main/adapters/coding-job-worktree.js";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodingJob } from "../main/domain/coding-job.js";
import type { JeonjuCoursePatch } from "../main/domain/jeonju-course.js";
import { transitionCodingJob } from "../main/domain/coding-job.js";
import type { CodingJobCourseLifecyclePort, CodingJobRunnerPort, CodingJobStore, CodingJobWorktreePort, SelectedWorkspaceCodingPort } from "../main/ports/coding-job.js";
import type { SubAgentPort } from "../main/ports/orchestration.js";

function fixture() {
  const jobs = new Map<string, CodingJob>();
  const released: string[] = [];
  const cancelled: string[] = [];
  const terminals = new Map<string, (r: { ok: boolean; reason?: string; patch?: JeonjuCoursePatch; releaseLease?: boolean }) => void>();
  const store: CodingJobStore = {
    get: (id) => jobs.get(id), list: (workspace) => [...jobs.values()].filter((j) => !workspace || j.workspacePath === workspace), save: (job) => jobs.set(job.jobId, job),
  };
  const worktrees: CodingJobWorktreePort = {
    recover: () => true,
    allocate: ({ jobId, workspacePath }) => ({ workspacePath: `/root/${workspacePath}`, worktreePath: `/work/${jobId}`, branch: `naia/coding-job/${jobId}`, leaseId: `lease-${jobId}`, release: () => { released.push(jobId); } }),
  };
  const runner: CodingJobRunnerPort = {
    start: ({ job, terminal }) => { terminals.set(job.jobId, terminal); return { cancel: async () => { cancelled.push(job.jobId); } }; },
  };
  let n = 0;
  const service = new CodingJobService({ store, worktrees, runner, ids: () => `job_${++n}abcdef`, now: () => "2026-07-22T00:00:00.000Z" });
  return { service, jobs, released, cancelled, terminals };
}

describe("UC-CW durable coding jobs", () => {
  it("creates isolated concurrent worktrees and durable running jobs", () => {
    const f = fixture();
    const first = f.service.start({ workspacePath: "alpha", task: "one" });
    const second = f.service.start({ workspacePath: "alpha", task: "two" });
    expect(first.state).toBe("running");
    expect(second.state).toBe("running");
    expect(first.worktreePath).not.toBe(second.worktreePath);
    expect(first.branch).not.toBe(second.branch);
    expect(f.service.list("/root/alpha")).toHaveLength(2);
  });

  it("cancels only the requested job and keeps terminal state immutable", async () => {
    const f = fixture();
    const first = f.service.start({ workspacePath: "alpha", task: "one" });
    const second = f.service.start({ workspacePath: "alpha", task: "two" });
    await f.service.cancel(first.jobId);
    expect(f.cancelled).toEqual([first.jobId]);
    expect(f.service.get(first.jobId).state).toBe("cancelled");
    f.terminals.get(first.jobId)?.({ ok: true });
    expect(f.service.get(first.jobId).state).toBe("cancelled");
    expect(f.service.get(second.jobId).state).toBe("running");
    expect(f.released).toEqual([first.jobId]);
  });

  it("persists an unconfirmed timeout failure without releasing the active worktree lease", () => {
    const f = fixture();
    const job = f.service.start({ workspacePath: "alpha", task: "one" });
    f.terminals.get(job.jobId)?.({ ok: false, reason: "deadline cancellation not confirmed", releaseLease: false });
    expect(f.service.get(job.jobId)).toMatchObject({ state: "failed", error: "deadline cancellation not confirmed" });
    expect(f.released).toEqual([]);
  });
  it("does not claim a resume without a persisted runner checkpoint", () => {
    const f = fixture();
    const job = f.service.start({ workspacePath: "alpha", task: "one" });
    expect(() => f.service.resume(job.jobId)).toThrow(CodingJobResumeUnavailableError);
  });

  it("rejects invalid terminal transitions", () => {
    const f = fixture();
    const job = f.service.start({ workspacePath: "alpha", task: "one" });
    const complete = transitionCodingJob(f.service.get(job.jobId), "completed", "later");
    expect(() => transitionCodingJob(complete, "running", "later2")).toThrow("invalid coding job transition");
  });

  it("has explicit JSON-line stdio command and precondition response", async () => {
    const f = fixture();
    const start = decodeCodingJobStdio('{"command":"coding_job.start","workspacePath":"alpha","task":"one"}');
    expect(start).not.toBeNull();
    const started = await dispatchCodingJobStdio(f.service, start!);
    expect(started.ok).toBe(true);
    const jobId = ((started.job as CodingJob).jobId);
    const resumed = await dispatchCodingJobStdio(f.service, { command: "coding_job.resume", jobId });
    expect(resumed).toMatchObject({ ok: false, code: "FAILED_PRECONDITION" });
  });

  it("records runner spawn failure as durable failed rather than running", () => {
    const f = fixture();
    const failing: CodingJobRunnerPort = { start: () => { throw new Error("codex executable unavailable"); } };
    const service = new CodingJobService({
      store: { get: (id) => f.jobs.get(id), list: () => [...f.jobs.values()], save: (job) => f.jobs.set(job.jobId, job) },
      worktrees: { allocate: ({ jobId, workspacePath }) => ({ workspacePath, worktreePath: `/work/${jobId}`, branch: `naia/coding-job/${jobId}`, leaseId: `lease-${jobId}`, release: () => { f.released.push(jobId); } }) },
      runner: failing, ids: () => "job_spawnfailure", now: () => "now",
    });
    const job = service.start({ workspacePath: "alpha", task: "one" });
    expect(job).toMatchObject({ state: "failed", error: "codex executable unavailable" });
    expect(service.get(job.jobId)).toMatchObject({ state: "failed", error: "codex executable unavailable" });
  });

  it("reports the course lifecycle once per durable state without exposing task or path details", () => {
    const f = fixture();
    const events: Array<{ jobId: string; state: string }> = [];
    const courseLifecycle: CodingJobCourseLifecyclePort = {
      report: (event) => events.push(event),
    };
    const service = new CodingJobService({
      store: { get: (id) => f.jobs.get(id), list: () => [...f.jobs.values()], save: (job) => f.jobs.set(job.jobId, job) },
      worktrees: { allocate: ({ jobId, workspacePath }) => ({ workspacePath, worktreePath: `/work/${jobId}`, branch: `naia/coding-job/${jobId}`, leaseId: `lease-${jobId}`, release: () => {} }) },
      selectedWorkspace: {
        prepare: ({ jobId, workspacePath }) => ({ workspacePath, worktreePath: workspacePath, branch: "selected-workspace", leaseId: `selected-${jobId}`, release: () => {} }),
        apply: () => ({ ok: true, summary: "applied" }),
        verify: () => ({ ok: true, summary: "verified" }),
      },
      runner: { start: ({ job, terminal }) => { f.terminals.set(job.jobId, terminal); return { cancel: async () => {} }; } },
      courseLifecycle,
      ids: () => "job_lifecycle",
      now: () => "now",
    });

    const job = service.start({ workspacePath: "/private/student/repo", task: "private course prompt", executionMode: "selected_workspace", allowedFiles: ["index.html", "hero.svg"], courseReply: { bindingId: "course_binding", guildId: "100", channelId: "200", sourceMessageId: "300" } });
    f.terminals.get(job.jobId)?.({ ok: true, patch: { version: 1, files: [{ path: "index.html", content: "<img src=\"./hero.svg\">" }] } });
    // A duplicate runner callback must not emit a second terminal status.
    f.terminals.get(job.jobId)?.({ ok: true });

    expect(events).toEqual([
      { jobId: "job_lifecycle", state: "received" },
      { jobId: "job_lifecycle", state: "running" },
      { jobId: "job_lifecycle", state: "completed" },
    ]);
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("reports a failed terminal state once when the runner cannot start", () => {
    const f = fixture();
    const states: string[] = [];
    const service = new CodingJobService({
      store: { get: (id) => f.jobs.get(id), list: () => [...f.jobs.values()], save: (job) => f.jobs.set(job.jobId, job) },
      worktrees: { allocate: ({ jobId, workspacePath }) => ({ workspacePath, worktreePath: `/work/${jobId}`, branch: `naia/coding-job/${jobId}`, leaseId: `lease-${jobId}`, release: () => {} }) },
      selectedWorkspace: {
        prepare: ({ jobId, workspacePath }) => ({ workspacePath, worktreePath: workspacePath, branch: "selected-workspace", leaseId: `selected-${jobId}`, release: () => {} }),
        apply: () => ({ ok: true, summary: "applied" }),
        verify: () => ({ ok: true, summary: "verified" }),
      },
      runner: { start: () => { throw new Error("private runner detail"); } },
      courseLifecycle: { report: ({ state }) => states.push(state) },
      ids: () => "job_start_failure",
      now: () => "now",
    });

    expect(service.start({ workspacePath: "/private/student/repo", task: "private task", executionMode: "selected_workspace", allowedFiles: ["index.html", "hero.svg"], courseReply: { bindingId: "course_binding", guildId: "100", channelId: "200", sourceMessageId: "300" } }).state).toBe("failed");
    expect(states).toEqual(["received", "running", "failed"]);
  });

  it("cannot overwrite a synchronous terminal callback with a stale running state", () => {
    const f = fixture();
    const states: string[] = [];
    const service = new CodingJobService({
      store: { get: (id) => f.jobs.get(id), list: () => [...f.jobs.values()], save: (job) => f.jobs.set(job.jobId, job) },
      worktrees: { allocate: ({ jobId, workspacePath }) => ({ workspacePath, worktreePath: `/work/${jobId}`, branch: "selected", leaseId: jobId, release: () => {} }) },
      selectedWorkspace: {
        prepare: ({ jobId, workspacePath }) => ({ workspacePath, worktreePath: workspacePath, branch: "selected", leaseId: jobId, release: () => {} }),
        apply: () => ({ ok: true, summary: "applied" }), verify: () => ({ ok: true, summary: "verified" }),
      },
      runner: { start: ({ terminal }) => { terminal({ ok: true, patch: { version: 1, files: [{ path: "index.html", content: "<img src=\"./hero.svg\">" }] } }); return { cancel: async () => {} }; } },
      courseLifecycle: { report: ({ state }) => states.push(state) }, ids: () => "job_sync", now: () => "now",
    });
    const job = service.start({ workspacePath: "/student", task: "course", executionMode: "selected_workspace", allowedFiles: ["index.html", "hero.svg"], courseReply: { bindingId: "course_binding", guildId: "100", channelId: "200", sourceMessageId: "300" } });
    expect(job.state).toBe("completed");
    expect(service.get(job.jobId).state).toBe("completed");
    expect(states).toEqual(["received", "running", "completed"]);
  });

  it("does not send ordinary isolated-worktree jobs to the course chat bridge", () => {
    const f = fixture();
    const states: string[] = [];
    const service = new CodingJobService({
      store: { get: (id) => f.jobs.get(id), list: () => [...f.jobs.values()], save: (job) => f.jobs.set(job.jobId, job) },
      worktrees: { allocate: ({ jobId, workspacePath }) => ({ workspacePath, worktreePath: `/work/${jobId}`, branch: `naia/coding-job/${jobId}`, leaseId: `lease-${jobId}`, release: () => {} }) },
      runner: { start: () => ({ cancel: async () => {} }) },
      courseLifecycle: { report: ({ state }) => states.push(state) },
      ids: () => "job_private_worker",
      now: () => "now",
    });

    expect(service.start({ workspacePath: "/private/other-project", task: "private task" }).state).toBe("running");
    expect(states).toEqual([]);
  });

  it("uses selected workspace only when explicitly requested and fails closed on post-run verification", () => {
    const f = fixture();
    const prepared: string[] = [];
    const selectedWorkspace: SelectedWorkspaceCodingPort = {
      prepare: ({ jobId, workspacePath, allowedFiles }) => {
        prepared.push(`${workspacePath}:${allowedFiles.join(",")}`);
        return { workspacePath: "/student/repo", worktreePath: "/student/repo", branch: "selected-workspace", leaseId: `selected-${jobId}`, release: () => { f.released.push(jobId); } };
      },
      apply: () => ({ ok: true, summary: "applied" }),
      verify: () => ({ ok: false, summary: "unexpected_file; changes were preserved for manual review" }),
    };
    const service = new CodingJobService({
      store: { get: (id) => f.jobs.get(id), list: () => [...f.jobs.values()], save: (job) => f.jobs.set(job.jobId, job) },
      worktrees: { allocate: () => { throw new Error("isolated worktree must not be used"); } },
      runner: { start: ({ job, terminal }) => { f.terminals.set(job.jobId, terminal); return { cancel: async () => {} }; } },
      selectedWorkspace, ids: () => "job_selected", now: () => "now",
    });
    const job = service.start({ workspacePath: "/student/repo", task: "edit course", executionMode: "selected_workspace", allowedFiles: ["index.html", "hero.svg"] });
    expect(prepared).toEqual(["/student/repo:index.html,hero.svg"]);
    expect(job).toMatchObject({ executionMode: "selected_workspace", worktreePath: "/student/repo" });
    f.terminals.get(job.jobId)?.({ ok: true, reason: "codex process exit=0; stderr=none; parsed_events=planning,session_end", patch: { version: 1, files: [{ path: "index.html", content: "<img src=\"./hero.svg\">" }] } });
    expect(service.get(job.jobId)).toMatchObject({
      state: "failed",
      verificationSummary: "unexpected_file; changes were preserved for manual review; runner: codex process exit=0; stderr=none; parsed_events=planning,session_end",
    });
  });

  it("Codex runner persists its session failure and cancellation stays with its child", async () => {
    const cancelled: string[] = [];
    const spawned: string[] = [];
    const terminals: (() => void)[] = [];
    const subAgent: SubAgentPort = {
      spawn(task) {
        spawned.push(task.workdir);
        let finish: ((value: IteratorResult<{ kind: "session_end"; ok: boolean; reason?: string }>) => void) | undefined;
        const events: AsyncIterable<{ kind: "session_end"; ok: boolean; reason?: string }> = {
          [Symbol.asyncIterator]() { return { next: () => new Promise((resolve) => { finish = resolve; }) }; },
        };
        terminals.push(() => finish?.({ value: { kind: "session_end", ok: false, reason: "codex missing" }, done: false }));
        return { events, cancel: async () => { cancelled.push(task.workdir); } };
      },
    };
    const jobs = new Map<string, CodingJob>(); let n = 0;
    const service = new CodingJobService({
      store: { get: (id) => jobs.get(id), list: () => [...jobs.values()], save: (job) => jobs.set(job.jobId, job) },
      worktrees: { allocate: ({ jobId, workspacePath }) => ({ workspacePath, worktreePath: `/work/${jobId}`, branch: `naia/coding-job/${jobId}`, leaseId: `lease-${jobId}`, release: () => {} }) },
      runner: makeCodexCodingJobRunner(subAgent), ids: () => `job_runner_${++n}`, now: () => "now",
    });
    const first = service.start({ workspacePath: "alpha", task: "one" });
    const second = service.start({ workspacePath: "alpha", task: "two" });
    expect(spawned).toEqual([first.worktreePath, second.worktreePath]);
    await service.cancel(first.jobId);
    expect(cancelled).toEqual([first.worktreePath]);
    terminals[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.get(second.jobId)).toMatchObject({
      state: "failed",
      error: "codex missing; parsed_events=session_end; agent_message=none",
    });
    expect(service.get(first.jobId).state).toBe("cancelled");
  });

  it("Codex course runner requests a read-only structured proposal before Naia applies it", () => {
    let prompt = "";
    const runner = makeCodexCodingJobRunner({
      spawn(task) {
        prompt = task.prompt;
        return { events: (async function* () { yield { kind: "session_end" as const, ok: false, reason: "not run" }; })(), cancel: async () => {} };
      },
    });
    runner.start({
      job: {
        jobId: "course_runner", workspacePath: "/course", worktreePath: "/course", branch: "selected-workspace", leaseId: "lease",
        task: "Create the two course files", executionMode: "selected_workspace", allowedFiles: ["index.html", "hero.svg"], state: "running", createdAt: "now", updatedAt: "now",
      },
      terminal: () => {},
    });
    expect(prompt).toContain("Course proposal contract: inspect only");
    expect(prompt).toContain("Return exactly one JSON object");
    expect(prompt).toContain("Naia validates, applies, and verifies");
    expect(prompt).toContain("index.html and hero.svg");
  });

  it("turns only a valid read-only provider response into a Naia-applicable proposal", async () => {
    let access: string | undefined;
    const runner = makeCodexCodingJobRunner({
      spawn(task) {
        access = task.filesystemAccess;
        return {
          events: (async function* () {
            yield { kind: "text_delta" as const, text: "I will inspect the existing SVG first." };
            yield { kind: "tool_use_end" as const, tool: "command_execution", ok: true };
            yield { kind: "text_delta" as const, text: JSON.stringify({ version: 1, files: [{ path: "hero.svg", content: "<svg/>" }] }) };
            yield { kind: "session_end" as const, ok: true };
          })(),
          cancel: async () => {},
        };
      },
    });
    const result = await new Promise<{ ok: boolean; reason?: string; patch?: JeonjuCoursePatch }>((resolve) => {
      runner.start({
        job: {
          jobId: "course_proposal", workspacePath: "/course", worktreePath: "/course", branch: "selected-workspace", leaseId: "lease",
          task: "revise hero", executionMode: "selected_workspace", allowedFiles: ["index.html", "hero.svg"], state: "running", createdAt: "now", updatedAt: "now",
        },
        terminal: resolve,
      });
    });
    expect(access).toBe("read_only");
    expect(result).toMatchObject({ ok: true, patch: { files: [{ path: "hero.svg", content: "<svg/>" }] } });
  });

  it("rejects workspace escapes and gives each job an exclusive generated lease", () => {
    const temp = mkdtempSync(join(tmpdir(), "naia-coding-job-"));
    const root = join(temp, "root"); const source = join(root, "repo"); const outside = join(temp, "outside");
    mkdirSync(source, { recursive: true }); mkdirSync(outside, { recursive: true });
    const calls: string[][] = [];
    const worktrees = makeGitCodingJobWorktrees({ allowedWorkspaceRoot: root, worktreeRoot: join(temp, "managed"), git: (args) => { calls.push([...args]); } });
    try {
      const allocation = worktrees.allocate({ jobId: "job_abcdef", workspacePath: source });
      expect(allocation.branch).toBe("naia/coding-job/job_abcdef");
      expect(calls).toContainEqual(["worktree", "add", "--no-track", "-b", allocation.branch, allocation.worktreePath, "HEAD"]);
      expect(() => worktrees.allocate({ jobId: "job_abcdef", workspacePath: source })).toThrow("unavailable");
      expect(() => worktrees.allocate({ jobId: "job_escape", workspacePath: outside })).toThrow("outside configured root");
      const recoverable = worktrees.allocate({ jobId: "recover_job", workspacePath: source });
      const recover = worktrees.recover;
      expect(recover?.({ jobId: "recover_job", workspacePath: source, worktreePath: recoverable.worktreePath, leaseId: "wrong-lease" })).toBe(false);
      expect(recover?.({ jobId: "recover_job", workspacePath: source, worktreePath: recoverable.worktreePath, leaseId: recoverable.leaseId })).toBe(true);
      expect(recover?.({ jobId: "recover_job", workspacePath: source, worktreePath: recoverable.worktreePath, leaseId: recoverable.leaseId })).toBe(false);
      allocation.release();
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it("marks durable nonterminal work as failed when the Agent starts after a restart", () => {
    const f = fixture();
    const orphan = f.service.start({ workspacePath: "alpha", task: "one" });
    const recovered = new CodingJobService({
      store: { get: (id) => f.jobs.get(id), list: () => [...f.jobs.values()], save: (job) => f.jobs.set(job.jobId, job) },
      worktrees: { recover: () => true, allocate: () => { throw new Error("recovery must not allocate a new worktree"); } },
      runner: { start: () => { throw new Error("recovery must not run a job"); } },
      now: () => "after-restart",
    });
    expect(recovered.get(orphan.jobId)).toMatchObject({
      state: "failed",
      error: "agent restarted before the coding job reached a terminal state",
      updatedAt: "after-restart",
    });
  });

  it("cancels and terminalizes a Codex session that emits no terminal event before its deadline", async () => {
    vi.useFakeTimers();
    try {
      let cancellation = "";
      const runner = makeCodexCodingJobRunner({
        spawn() {
          return {
            events: { [Symbol.asyncIterator]: async function* () { await new Promise<void>(() => {}); } },
            cancel: async (reason) => { cancellation = reason; },
          };
        },
      }, { executionTimeoutMs: 5 });
      const result = new Promise<{ ok: boolean; reason?: string }>((resolve) => {
        runner.start({
          job: { jobId: "deadline", workspacePath: "/work", worktreePath: "/work", branch: "branch", leaseId: "lease", task: "one", state: "running", createdAt: "now", updatedAt: "now" },
          terminal: resolve,
        });
      });
      await vi.advanceTimersByTimeAsync(5);
      await expect(result).resolves.toMatchObject({ ok: false, reason: "Codex execution exceeded 5ms without a terminal event" });
      expect(cancellation).toBe("execution deadline exceeded");
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminalizes without releasing the lease when deadline cancellation never confirms", async () => {
    vi.useFakeTimers();
    try {
      const runner = makeCodexCodingJobRunner({
        spawn() {
          return {
            events: { [Symbol.asyncIterator]: async function* () { await new Promise<void>(() => {}); } },
            cancel: async () => await new Promise<void>(() => {}),
          };
        },
      }, { executionTimeoutMs: 5, cancellationConfirmationTimeoutMs: 5 });
      const result = new Promise<{ ok: boolean; reason?: string; releaseLease?: boolean }>((resolve) => {
        runner.start({
          job: { jobId: "deadline-pending", workspacePath: "/work", worktreePath: "/work", branch: "branch", leaseId: "lease", task: "one", state: "running", createdAt: "now", updatedAt: "now" },
          terminal: resolve,
        });
      });
      await vi.advanceTimersByTimeAsync(10);
      await expect(result).resolves.toMatchObject({ ok: false, releaseLease: false, reason: "Codex deadline cancellation was not confirmed: cancellation confirmation exceeded 5ms" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("reports a failed terminal result without releasing a lease when deadline cancellation is rejected", async () => {
    vi.useFakeTimers();
    try {
      const runner = makeCodexCodingJobRunner({
        spawn() {
          return {
            events: { [Symbol.asyncIterator]: async function* () { await new Promise<void>(() => {}); } },
            cancel: async () => { throw new Error("kill denied"); },
          };
        },
      }, { executionTimeoutMs: 5 });
      const result = new Promise<{ ok: boolean; reason?: string; releaseLease?: boolean }>((resolve) => {
        runner.start({
          job: { jobId: "deadline-rejected", workspacePath: "/work", worktreePath: "/work", branch: "branch", leaseId: "lease", task: "one", state: "running", createdAt: "now", updatedAt: "now" },
          terminal: resolve,
        });
      });
      await vi.advanceTimersByTimeAsync(5);
      await expect(result).resolves.toMatchObject({ ok: false, releaseLease: false, reason: "Codex deadline cancellation was not confirmed: kill denied" });
    } finally {
      vi.useRealTimers();
    }
  });
});
