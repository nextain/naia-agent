import type { CodingJobRunnerPort } from "../ports/coding-job.js";
import type { SubAgentPort } from "../ports/orchestration.js";
import { parseJeonjuCoursePatch } from "../domain/jeonju-course.js";

/**
 * The current Codex CLI is deliberately an ephemeral run.  It supplies safe
 * workspace-write execution and targeted cancellation, but no thread
 * checkpoint; CodingJobService consequently rejects Resume honestly.
 */
export function makeCodexCodingJobRunner(subAgent: SubAgentPort): CodingJobRunnerPort {
  return {
    start({ job, terminal }) {
      const selectedWorkspaceBoundary = job.executionMode === "selected_workspace"
        ? "\n\nCourse proposal contract: inspect only. Do not modify files or run write, Git, package, deployment, or network commands. Return exactly one JSON object and no Markdown or explanation: {\"version\":1,\"files\":[{\"path\":\"index.html\",\"content\":\"...\"},{\"path\":\"hero.svg\",\"content\":\"...\"}]}. The files array must be a nonempty subset of only index.html and hero.svg, each path exactly once. Include complete replacement UTF-8 file content. Naia validates, applies, and verifies an accepted proposal; if you cannot produce it, return no success."
        : "";
      const session = subAgent.spawn({ prompt: `${job.task}${selectedWorkspaceBoundary}`, workdir: job.worktreePath, ...(job.model ? { model: job.model } : {}), ...(job.executionMode === "selected_workspace" ? { filesystemAccess: "read_only" as const } : {}) });
      void (async () => {
        try {
          const eventKinds: string[] = [];
          let agentMessageClass = "none";
          let proposalText = "";
          for await (const event of session.events) {
            eventKinds.push(event.kind);
            if (event.kind === "text_delta") {
              agentMessageClass = classifyAgentMessage(event.text);
              // A read-only provider may announce inspection before using
              // read tools, then emit the contract object as its final message.
              // Only that final message is eligible to be a proposal.
              if (job.executionMode === "selected_workspace") proposalText = event.text;
            }
            if (event.kind === "session_end") {
              const parsed = `parsed_events=${eventKinds.join(",") || "none"}; agent_message=${agentMessageClass}`;
              const reason = event.reason ? `${event.reason}; ${parsed}` : parsed;
              const proposal = job.executionMode === "selected_workspace" && event.ok
                ? parseJeonjuCoursePatch(proposalText)
                : undefined;
              queueMicrotask(() => terminal({
                ok: proposal ? proposal.ok : event.ok,
                reason: proposal && !proposal.ok ? `course proposal ${proposal.reason}; ${parsed}` : reason,
                ...(proposal?.ok ? { patch: proposal.patch } : {}),
              }));
            }
          }
        } catch (error) {
          queueMicrotask(() => terminal({ ok: false, reason: error instanceof Error ? error.message : String(error) }));
        }
      })();
      return { cancel: (reason) => session.cancel(reason) };
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
