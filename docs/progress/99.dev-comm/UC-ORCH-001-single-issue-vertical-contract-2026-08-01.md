# UC-ORCH-001 single-issue moderated coding contract

Status: frozen before implementation

## Product boundary

Naia is the conversational owner and process reporter. It is not the coding expert. One work request
flows through a separate development moderator into one isolated Codex worker execution, then a
separate verifier, then a report grounded in durable evidence. Chat remains chat. OpenCode,
multi-worker collaboration, multiple concurrent issues, and naia-shell UI are later contracts.

## State machine

`accepted → classified → planning → awaiting_user | dispatch_ready → worker_running →
verifying → reporting → completed | failed | cancelled | outcome_unknown`

Terminal states are immutable. `awaiting_user` resumes only with the exact pending question id.
Every transition appends an event in the same SQLite transaction as the current snapshot.

## Identity and retry

- `request_id` binds the exact original text digest. Same id plus different text is rejected.
- `issue_id` is stable for the accepted request.
- facing, moderator, worker, verifier, and reporter each expose session and execution identities.
- `dispatch_id` is the worker idempotency key and is stable across restart/retry.
- an acknowledged actor result is never called again; an unacknowledged worker transport loss is
  `outcome_unknown` unless exact dispatch reconciliation proves a terminal result.

## Receipt and report

Each actor receipt records role, provider, model, session/execution ids, input/cached/output tokens,
latency, and cost as measured or unavailable. Total cost is available only when all required costs
are measured. The final report reads the persisted snapshot/events, never an unpersisted model
summary. Verification failure cannot produce `completed`.

## First bindings

- Naia-facing proxy: GPT-5.6 Luna, explicit opt-in, low/medium reasoning.
- Development moderator: GPT-5.6 Sol, separate session/execution.
- Worker: existing role-profile selector, first real adapter Codex in a managed worktree.
- Verifier: existing deterministic verifier port.

## Acceptance

The tests named in `docs/user-scenarios.md` cover chat isolation, obligation preservation, questions,
duplicate/restart replay, cancellation, unknown outcomes, real worktree/Codex composition, and frozen
Luna-proxy versus all-Sol accounting. No benchmark claim is valid with a missing receipt or failed
hard gate.

## Implementation evidence

- The provider-neutral state machine, SQLite snapshot/event store, strict JSON actors, managed-worktree
  worker composition, separate verifier, and grounded reporter are implemented behind ports.
- Codex `turn.completed` evidence now survives the shared subprocess terminal path, including thread,
  execution, cached-input, output, and priced-usage fields. Requested model and role bindings fail
  closed on mismatch; reasoning effort is pinned separately from model id.
- Deterministic coverage includes chat isolation, exact question binding, duplicate/reopen behavior,
  unreconciled restart, cancellation, transport loss, unavailable cost, strict actor schemas, layer
  boundaries, worktree composition, and the benchmark claim gate.
- The paid runner is opt-in and runs one frozen paired coding case only. It writes owner-only JSON and
  permits a numeric savings comparison only when both compositions pass every quality and receipt gate.
- Full regression excluding two baseline environment-sensitive process tests: 130 files passed, 3
  skipped; 1,437 tests passed, 9 skipped. The unchanged baseline failures are the management-doctor
  status expectation and nested-ADK credential discovery in the Pi CLI process test. No credential
  value is retained in this document or benchmark artifact.
- Repository gates: compile, logging, traceability, terminology, and new-file anchors pass. The global
  file-anchor command still reports the same 29 pre-existing drift entries recorded in process-status.
