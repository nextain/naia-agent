# UC-ORCH-001 single-issue moderated coding contract

Status: frozen before implementation

## Product boundary

Naia is the conversational owner and process reporter. It is not the coding expert. One work request
flows through a separate development moderator into one isolated Codex worker execution, then a
separate verifier, then a report grounded in durable evidence. Chat remains chat. OpenCode,
multi-worker collaboration, multiple concurrent issues, and naia-shell UI are later contracts.

## State machine

`accepted → classifying → classified → planning → moderator_running → awaiting_user |
dispatch_ready → worker_running → verifying → reporting → reporter_running → completed | failed |
cancelled | outcome_unknown`

Terminal states are immutable. `awaiting_user` resumes only with the exact pending question id.
Every transition appends an event in the same SQLite transaction as the current snapshot.
Cancellation before worker dispatch is a durable request: it aborts an in-process facing/moderator
session, is observed by a peer process through the execution heartbeat, and fences late stage writes.

## Identity and retry

- `request_id` binds the exact request text, workspace, Naia/moderator bindings, and worker-profile map
  digest. SQLite establishes it with atomic create-or-get across processes; reusing the id with any
  drift is rejected.
- `issue_id` is stable for the accepted request.
- facing, moderator, worker, verifier, and reporter each expose session and execution identities.
- `dispatch_id` is the worker idempotency key and is stable across restart/retry.
- an expiring SQLite execution claim serializes stage advancement across Agent processes. A live peer
  is observed rather than misclassified as a crash; stale owners are fenced from snapshot writes.
  A false or thrown lease renewal aborts the stale local actor, removes its local write authority,
  suppresses further writes even if the actor ignores abort, and rejoins the successor's latest
  grounded state instead of leaking a fenced-save exception.
- an acknowledged actor result is never called again; an unacknowledged worker transport loss is
  `outcome_unknown` unless exact dispatch reconciliation proves a terminal result.
- every paid actor has a persisted running boundary before invocation. Restart at that boundary never
  blindly repeats the call; without exact reconciliation it becomes `outcome_unknown` and cost remains
  unavailable.

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
- Provider output may choose conversational execution, but terminal state, changed files, verification,
  and authoritative summary claims are reconstructed deterministically from the persisted snapshot.
  Naia's evidence-fed narrative is retained separately as non-authoritative commentary, so the paid
  reporter contributes to the user report without controlling terminal facts. Credential-shaped request
  text is redacted before SQLite persistence and actor relay.
- Codex `turn.completed` evidence now survives the shared subprocess terminal path, including thread,
  execution, cached-input, output, and priced-usage fields. Requested model and role bindings fail
  closed on adapter request drift; reasoning effort is pinned separately from model id. The receipt
  labels this as adapter-request evidence because Codex JSONL does not independently report its backend
  model routing. The benchmark therefore gates `profile_request_exact`, not provider-observed identity.
  Missing, malformed, or internally inconsistent usage is marked unavailable and cannot become a
  measured zero-cost receipt or an apparently available zero-token count. Availability is opt-in:
  only explicit `usageAvailable: true` permits token and monetary measurement for both JSON actors
  and the supervised worker.
- Deterministic coverage includes chat isolation, exact question binding, duplicate/reopen behavior,
  simultaneous cross-thread creation, concurrent cross-instance delivery, execution-claim
  expiry/fencing, stable dispatch assignment,
  unreconciled restart, cancellation, transport loss, unavailable cost, strict actor schemas, layer
  boundaries, worktree composition, and the benchmark claim gate.
- A paid actor result rejected after strict JSON/policy validation carries its already completed receipt
  across the port boundary and terminates as `failed`. Missing or internally invalid receipt evidence
  terminates immediately as `outcome_unknown`; neither path remains stranded in a running state.
- A thrown verifier or invalid verifier receipt also terminalizes as `outcome_unknown` with unavailable
  cost evidence. `verifying` is a dispatched boundary: only the invocation that just persisted worker
  completion may call it; a restarted boundary without exact reconciliation becomes `outcome_unknown`.
- Codex actor children receive an explicit non-secret environment allowlist. Parent thread identity,
  provider/API keys, repository tokens, and unrelated host credentials are not inherited by workers.
- The retained built-in Pi adapter assigns distinct adapter-owned session/execution ids per spawn and
  carries them with Pi-reported provider/model/usage evidence, so the same provider-neutral JSON actor
  ports can use Pi without fabricating provider identity.
- The paid runner is opt-in and runs one frozen paired coding case only. It writes owner-only JSON and
  fixes the paid call count at eight, requires explicit observed-spend/per-call reservation thresholds
  plus per-actor time limits, and permits a numeric savings comparison only when both compositions pass
  every quality and receipt gate. Codex CLI exposes no provider-side token/dollar ceiling, so the runner
  labels this limitation explicitly instead of claiming a hard credit ceiling. Its observed-spend ledger
  is behaviorally tested and carries a completed receipt even when a per-call reservation is exceeded.
  The corpus pins each route's worker provider/model/reasoning binding; runtime model overrides are
  rejected before any paid call. The runner loads the workspace's frozen 2026-07-29 OpenAI price
  snapshot byte-for-byte, verifies SHA-256 `36ff2bca30e2823cddda6b207bdf68b3bb15700c5fdc4e0e67792bda44bc6626`,
  and writes its id, capture time, currency, token unit, normalization method, applicability, and
  declared cost scope into the result. Inputs above 272,000 tokens retain usage evidence but monetary
  cost becomes unavailable, which blocks a savings claim until a long-context rule is frozen.
- Full regression excluding two baseline environment-sensitive process tests: 130 files passed, 3
  skipped; 1,485 tests passed, 9 skipped. The unchanged baseline failures are the management-doctor
  status expectation and nested-ADK credential discovery in the Pi CLI process test. No credential
  value is retained in this document or benchmark artifact.
- Repository gates: compile, logging, traceability, terminology, and new-file anchors pass. The global
  file-anchor command still reports the same 29 pre-existing drift entries recorded in process-status.
- Production chat/CLI ingress activation is deliberately not claimed in this slice. The new path is
  exercised as a provider-neutral composition/library and through the opt-in paired runner; host ingress
  and naia-shell wiring remain later integration work.
