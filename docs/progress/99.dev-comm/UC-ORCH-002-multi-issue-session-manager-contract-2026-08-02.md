# UC-ORCH-002 multi-issue session manager contract

Status: done for the declared Agent-side library and deterministic benchmark scope

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

- Intake durably assigns a monotonic ready sequence and stable session identity.
- Before actor execution, the manager calls an additive `REQ-021` ensure operation that atomically
  creates-or-gets the issue without invoking an actor, then immutably links its id to the session.
- The scheduler admits FIFO-ready records up to a positive concurrency limit. Recovery work has higher
  priority than new/answered work; FIFO is preserved inside each priority class.
- `awaiting_user` releases its slot. A matching answer assigns a new ready sequence to only that session.
- Cancellation targets one session and is idempotent.
- Every settled or thrown execution releases its slot and triggers another scheduling pass.

## Ports and ownership

- The manager depends on a provider-neutral single-issue execution port with ensure, resume, answer,
  cancel, and snapshot access. `SingleIssueOrchestrator.ensure()` is an additive create-or-get boundary;
  `start()` remains a compatibility convenience that composes ensure plus resume.
- Neutral intake, answer, cancel, list, get, and portfolio DTOs carry source kind/id and actor id as
  provenance. They do not grant transport authorization; future ingress adapters must authorize before
  calling these application ports.
- A separate SQLite session store owns queue order, source metadata, manager lifecycle, stable issue
  linkage, and manager events. It does not duplicate actor receipts or the issue state machine.
- Queries compose session rows with issue evidence. Aggregate cost is measured only when all selected
  issue totals are measured; otherwise it is unavailable with a reason.
- The scheduling core imports neither Discord, Shell, Codex protocol, nor model SDK modules.

## Identity, retry, and recovery

- `request_id` and its full bound digest preserve `REQ-021` conflict semantics.
- `session_id` is the stable management identity exposed to future ingress/UI adapters.
- `issue_id` does not exist at intake. `REQ-021` allocates it through `ensure()` before any actor call;
  the manager atomically links the returned id before resume and rejects every attempted replacement.
- One expiring database-wide scheduler-owner lease serializes admission across Agent processes. Its
  renewal requires the previous lease to remain unexpired, and every scheduler lifecycle write is
  fenced by owner id and current time. A process-local in-flight map is only an optimization.
- The active owner admits at most the configured number of sessions across that database. Per-issue
  execution remains independently fenced by the `REQ-021` SQLite execution claim.
- On startup, `queued` records are eligible in original order. Previously `running` records retain
  their issue identity and use resume/reconciliation; they are never re-intaken as new work.

## Budget and evidence semantics

Per-admission reservations and an aggregate observed-spend threshold are optional harness policies.
When the threshold is enabled, every candidate must declare a reservation. Admission requires:

`settled measured cost + active reservations + candidate reservation <= threshold`

Any unavailable cost among included settled/running sessions blocks further admission until resolved.
Without a threshold, a reservation is advisory and unavailable cost does not block scheduling.
Completion replaces the active reservation with measured cost exactly once by session identity;
unavailable cost and reservation overruns are persisted honestly. None of these rules guarantees a
provider-side dollar ceiling for a call already in flight.

The portfolio view exposes counts, queue order, session states, last update, outcomes, and cost
availability derived from persisted records. A future Naia narrative is commentary only.

## Verification plan

Deterministic integration tests will cover bounded concurrency, FIFO fairness, duplicate/conflicting
intake, waiting/failure/cancellation isolation, answer binding, slot release on every outcome, a
two-process scheduler lease/expiry/fencing race, issue ensure/link before actor execution, competing
answered/new ready ordering, restart recovery, durable list/get visibility, source metadata, and the
exact budget admission predicate including unavailable cost. A source-import contract test will keep the manager domain/application
layers independent of Discord, Shell, Codex protocol, and model SDKs. A frozen no-network
benchmark workload will score completion, isolation, fairness, maximum concurrency, recovery,
visibility, and accounting; every category is a hard gate.

Implementation review and final integration review reread the orchestration charter and this contract.
The final source revision requires two consecutive independent Clean reviews before completion.

## P04 implementation evidence

- `SingleIssueOrchestrator.ensure()` establishes the durable request/issue identity without invoking
  Naia, moderator, worker, verifier, or reporter. Existing `start()` composes ensure plus resume.
- The manager persists transport-neutral provenance and session lifecycle separately from REQ-021
  issue snapshots/receipts. It schedules through only the neutral single-issue execution port.
- SQLite owns monotonic ready order, recovery priority, append-only manager events, one expiring
  database-wide scheduler lease, unexpired renewal, and fenced claim/settle writes.
- Eleven deterministic integration scenarios cover identity-before-actor, replay conflict (including
  source/reservation drift), work-conserving bounded FIFO, waiting/answer/cancel isolation, cancellation
  from waiting, lease expiry/fencing, atomic idle-release wakeup, two-manager recovery with one
  idempotent effect, exact budget admission, transport-neutral grounded visibility, and mismatched
  issue-report rejection.
- The layer contract rejects Discord, Shell, provider SDK, and Codex-protocol imports from the manager
  domain/port/app modules.
- `uc-orch-002-deterministic-v1` runs the built manager, two SQLite stores, and deterministic execution
  port; it makes zero paid calls and derives passing completion, isolation, fairness, concurrency,
  restart, visibility, and cost-accounting observations. Seven counterexamples each prove that one
  failed gate prohibits the claim. The runner rejects committed and uncommitted input drift, records
  every tracked input and imported runtime-module SHA, and the contract test rebuilds into an isolated
  output directory before byte-comparing the reproduced result. Exact artifact:
  `benchmark/results/multi-issue-deterministic.json`, source `bd770dc91f8766abd04c690199420c475623302a`,
  SHA-256 `106013c77676e05cd2fa1b9dd174fa71fcfdffff2cf1f112942c080ed9ad3507`.
- The focused TypeScript build and 62 affected/new tests pass. The full suite reached 1,512 passes and
  10 skips; its two failures are the same documented environment-sensitive baselines: management
  doctor status expectation and nested-ADK credential discovery in the Pi CLI process test. No new
  multi-session test failed.
- Excluding exactly those two baseline process files, the complete regression passes: 133 test files,
  1,512 tests passed, and 9 skipped. Compile, logging, traceability, terminology, root structure,
  SDLC, charter, completion, and structure gates pass. File-anchor remains the baseline 29 and canon
  conformance returns to the baseline 57 after registering user-directed UC-ORCH-001/002.
- Review history and final convergence protocol are recorded in
  `.agents/reviews/r-req-022-multi-issue-session-manager-2026-08-02.json`. Production ingress/UI and
  multi-agent worker collaboration remain deferred exactly as declared in the product boundary.
