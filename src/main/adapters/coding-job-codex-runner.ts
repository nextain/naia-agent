import type { CodingJobRunnerPort } from "../ports/coding-job.js";
import type { SubAgentPort } from "../ports/orchestration.js";

/**
 * The current Codex CLI is deliberately an ephemeral run.  It supplies safe
 * workspace-write execution and targeted cancellation, but no thread
 * checkpoint; CodingJobService consequently rejects Resume honestly.
 */
export function makeCodexCodingJobRunner(subAgent: SubAgentPort): CodingJobRunnerPort {
  return {
    start({ job, terminal }) {
      const selectedWorkspaceBoundary = job.executionMode === "selected_workspace"
        ? "\n\nCourse execution boundary: edit only the approved files. Do not run git commit, git push, git remote, GitHub Pages, or any deployment command. Leave changes uncommitted for the student to review."
        : "";
      const session = subAgent.spawn({ prompt: `${job.task}${selectedWorkspaceBoundary}`, workdir: job.worktreePath, ...(job.model ? { model: job.model } : {}) });
      void (async () => {
        try {
          for await (const event of session.events) {
            if (event.kind === "session_end") queueMicrotask(() => terminal({ ok: event.ok, ...(event.reason ? { reason: event.reason } : {}) }));
          }
        } catch (error) {
          queueMicrotask(() => terminal({ ok: false, reason: error instanceof Error ? error.message : String(error) }));
        }
      })();
      return { cancel: (reason) => session.cancel(reason) };
    },
  };
}
