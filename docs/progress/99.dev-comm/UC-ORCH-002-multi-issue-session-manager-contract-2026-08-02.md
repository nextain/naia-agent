# UC-ORCH-002 multi-issue session manager contract

Status: frozen before implementation

## Product boundary

Naia is the conversational owner and process manager for several coding issues. It does not become a
coding expert or replace the development moderator. The completed `UC-ORCH-001` vertical remains the
only execution unit: Luna-proxy intake/reporting, a distinct Sol development moderator, one pinned
Codex worker, independent verification, and a grounded report.

This slice adds durable intake, bounded scheduling, isolation, restart recovery, commands, and
portfolio visibility around that unit. It does not activate OpenCode/naia-agent worker collaboration,
Discord ingress, naia-shell UI, or terminal/file opening. Those later surfaces attach through source
metadata and application ports rather than entering the scheduling domain.

## Session lifecycle

The manager lifecycle is intentionally smaller than the issue state machine:

`queued → running → awaiting_user | terminal`

`terminal` retains the exact issue outcome: `completed`, `failed`, `cancelled`, or
`outcome_unknown`. Chat-only classification also settles without creating coding work. The manager
does not infer stage transitions from prose; it maps the durable `REQ-021` report/snapshot.

- Intake durably assigns a monotonic queue sequence and stable session identity.
- The scheduler admits FIFO-ready records up to a positive concurrency limit.
- `awaiting_user` releases its slot. A matching answer returns only that session to ready work.
- Cancellation targets one session and is idempotent.
- Every settled or thrown execution releases its slot and triggers another scheduling pass.

## Ports and ownership

- The manager depends on a provider-neutral single-issue execution port with start, resume, answer,
  cancel, and snapshot access. `SingleIssueOrchestrator` is the first adapter.
- A separate SQLite session store owns queue order, source metadata, manager lifecycle, stable issue
  linkage, and manager events. It does not duplicate actor receipts or the issue state machine.
- Queries compose session rows with issue evidence. Aggregate cost is measured only when all selected
  issue totals are measured; otherwise it is unavailable with a reason.
- The scheduling core imports neither Discord, Shell, Codex protocol, nor model SDK modules.

## Identity, retry, and recovery

- `request_id` and its full bound digest preserve `REQ-021` conflict semantics.
- `session_id` is the stable management identity exposed to future ingress/UI adapters.
- `issue_id` is linked once established and never replaced.
- A process-local in-flight map prevents duplicate execution in one manager. Cross-process issue
  execution remains fenced by the `REQ-021` SQLite execution claim.
- On startup, `queued` records are eligible in original order. Previously `running` records retain
  their issue identity and use resume/reconciliation; they are never re-intaken as new work.

## Budget and evidence semantics

Per-session reservations and an aggregate observed-spend threshold are optional harness policies.
They can stop further admission based on complete persisted observations, but cannot guarantee a
provider-side dollar ceiling for a call already in flight. Receipts are counted once by stable
session/receipt identity. Unknown cost blocks a numeric aggregate claim.

The portfolio view exposes counts, queue order, session states, last update, outcomes, and cost
availability derived from persisted records. A future Naia narrative is commentary only.

## Verification plan

Deterministic integration tests will cover bounded concurrency, FIFO fairness, duplicate/conflicting
intake, waiting/failure/cancellation isolation, answer binding, slot release on every outcome, restart
recovery, durable list/get visibility, source metadata, and cost aggregation. A frozen no-network
benchmark workload will score completion, isolation, fairness, maximum concurrency, recovery,
visibility, and accounting; every category is a hard gate.

Implementation review and final integration review reread the orchestration charter and this contract.
The final source revision requires two consecutive independent Clean reviews before completion.
