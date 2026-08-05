# UC-024 — Naia coding orchestration assistant contract

## User outcome

One `naia-agent` CLI conversation keeps Naia's persona, memory, workspace context, and knowledge
tools while also starting and controlling durable coding sessions. Starting a coding task returns a
stable session identity without waiting for the coding worker to finish. The user can later list,
inspect, answer, or cancel that session from the same assistant tool surface.

## Boundary

- Naia owns conversation continuity, task admission, and grounded reporting.
- The durable multi-issue manager owns task identity and lifecycle.
- Trusted runtime configuration owns workspace, actor bindings, worker profiles, and capabilities.
- Codex, Claude Code, OpenCode, and Pi are worker adapter kinds. Model output cannot invent or
  silently fall back to an undeclared adapter.
- Workers receive bounded task/role/worktree context, not Naia persona or long-term memory.

## Tool contract

- `start_coding_task(task, obligations?)` creates or gets one durable session and returns its safe
  projection immediately.
- `list_coding_tasks()` returns bounded safe projections.
- `show_coding_task(session_id)` returns one safe projection.
- `answer_coding_task(session_id, question_id, answer)` resumes only the matching durable question.
- `cancel_coding_task(session_id)` requests idempotent cancellation.

Projections contain lifecycle identity, state, timestamps, grounded question/result fields, changed
files, verification state, and cost availability. They exclude raw prompts, provider secrets, private
chain-of-thought, unrestricted command output, and raw model transcripts.

## Failure and recovery

- Invalid arguments and unknown sessions return tool errors without throwing through the chat loop.
- Background pump failures are diagnosed without rewriting the accepted session as success.
- Duplicate request identity is delegated to the existing manager/orchestrator idempotency contract.
- Restart, awaiting-user, cancellation, and `outcome_unknown` retain their existing durable semantics.

## P0 verification

1. Tool contract tests prove trusted context binding, projection redaction, and no-throw failures.
2. SQLite integration proves start/list/show/cancel across reopen without a paid model call.
3. An actual CLI process proves `--coding-config` opens the durable stores and exits cleanly; an
   actual chat tool-loop scenario proves persona, recalled memory, and workspace context remain
   active while start/list/show/answer/cancel operate on durable SQLite sessions.
4. Team-profile tests prove Claude Code joins the same declared adapter-kind boundary.
5. Existing chat, Discord, and Codex workshop tests remain green.
