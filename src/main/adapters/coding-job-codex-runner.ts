import type { CodingJobRunnerPort } from "../ports/coding-job.js";
import type { SubAgentPort } from "../ports/orchestration.js";
import { parseJeonjuCoursePatch } from "../domain/jeonju-course.js";

const DEFAULT_EXECUTION_TIMEOUT_MS = 15 * 60_000;

export interface CodexCodingJobRunnerOptions {
  /** Bounded execution avoids a durable `running` job when a CLI stops emitting events. */
  readonly executionTimeoutMs?: number;
}

/**
 * The current Codex CLI is deliberately an ephemeral run. It supplies safe
 * workspace-write execution and targeted cancellation, but no thread
 * checkpoint; CodingJobService consequently rejects Resume honestly.
 */
export function makeCodexCodingJobRunner(
  subAgent: SubAgentPort,
  options: CodexCodingJobRunnerOptions = {},
): CodingJobRunnerPort {
  const executionTimeoutMs = options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
  if (!Number.isFinite(executionTimeoutMs) || executionTimeoutMs <= 0) {
    throw new Error("Codex coding job execution timeout must be positive");
  }
  return {
    start({ job, terminal }) {
      const selectedWorkspaceBoundary = job.executionMode === "selected_workspace"
        ? "\n\nCourse proposal contract: inspect only. Do not modify files or run write, Git, package, deployment, or network commands. Return exactly one JSON object and no Markdown or explanation: {\"version\":1,\"files\":[{\"path\":\"index.html\",\"content\":\"...\"},{\"path\":\"hero.svg\",\"content\":\"...\"}]}. The files array must be a nonempty subset of only index.html and hero.svg, each path exactly once. Include complete replacement UTF-8 file content. Naia validates, applies, and verifies an accepted proposal; if you cannot produce it, return no success."
        : "";
      const session = subAgent.spawn({ prompt: `${job.task}${selectedWorkspaceBoundary}`, workdir: job.worktreePath, ...(job.model ? { model: job.model } : {}), ...(job.executionMode === "selected_workspace" ? { filesystemAccess: "read_only" as const } : {}) });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let terminalEmitted = false;
      const finish = (result: { ok: boolean; reason?: string; patch?: import("../domain/jeonju-course.js").JeonjuCoursePatch; releaseLease?: boolean }) => {
        if (terminalEmitted) return;
        terminalEmitted = true;
        if (deadline) clearTimeout(deadline);
        queueMicrotask(() => terminal(result));
      };
      deadline = setTimeout(() => {
        void (async () => {
          try {
            await session.cancel("execution deadline exceeded");
            finish({ ok: false, reason: `Codex execution exceeded ${executionTimeoutMs}ms without a terminal event` });
          } catch (error) {
            finish({ ok: false, reason: `Codex deadline cancellation was not confirmed: ${error instanceof Error ? error.message : String(error)}`, releaseLease: false });
          }
        })();
      }, executionTimeoutMs);
      void (async () => {
        try {
          const eventKinds: string[] = [];
          let agentMessageClass = "none";
          let proposalText = "";
          for await (const event of session.events) {
            eventKinds.push(event.kind);
            if (event.kind === "text_delta") {
              agentMessageClass = classifyAgentMessage(event.text);
              if (job.executionMode === "selected_workspace") proposalText = event.text;
            }
            if (event.kind === "session_end") {
              const parsed = `parsed_events=${eventKinds.join(",") || "none"}; agent_message=${agentMessageClass}`;
              const reason = event.reason ? `${event.reason}; ${parsed}` : parsed;
              const proposal = job.executionMode === "selected_workspace" && event.ok
                ? parseJeonjuCoursePatch(proposalText)
                : undefined;
              finish({
                ok: proposal ? proposal.ok : event.ok,
                reason: proposal && !proposal.ok ? `course proposal ${proposal.reason}; ${parsed}` : reason,
                ...(proposal?.ok ? { patch: proposal.patch } : {}),
              });
            }
          }
        } catch (error) {
          finish({ ok: false, reason: error instanceof Error ? error.message : String(error) });
        }
      })();
      return { cancel: async (reason: string) => { await session.cancel(reason); finish({ ok: false, reason }); } };
    },
  };
}

/** A safe category for the model's own final text; never persist its raw text. */
function classifyAgentMessage(text: string): string {
  const lower = text.toLowerCase();
  if (/auth|login|credential|unauthori[sz]ed/.test(lower)) return "authentication";
  if (/cannot|can't|unable|not able|refus|blocked|permission/.test(lower)) return "blocked";
  if (/edit|changed|updated|created|wrote/.test(lower)) return "reported_edit";
  return "present";
}