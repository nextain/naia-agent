# UC-ORCH-003 profiled issue-team contract

## Goal and boundary

This requirement implements the orchestration SoT stages `S4 issue_1_multi_agent` and the remaining
adapter portion of `S5 multi_issue_and_more_adapters`. Naia remains the conversational process
manager, the Sol-class moderator remains the development authority, and coding work is delegated to
profiled role agents. It does not make the Naia-facing model a frontier coding model.

Included: one issue, one managed worktree, explorer/implementer/tester/reviewer roles, Codex/OpenCode/
built-in Pi selection, durable role evidence, bounded repair, safe restart, integration tests, and a
no-paid-call benchmark. Excluded: actual Discord ingress, Discord authorization, naia-shell UI,
terminal/file opening, SSH/mobile federation, automatic merge, and local-model replacement.

## Architecture and data flow

```text
Naia-facing model -> development moderator -> IssueWorkerPort
                                              |
                                              v
                                   durable issue-team run
                                              |
                  explorer(ro) -> implementer(rw) -> tester(ro) -> reviewer(ro)
                                         ^                          |
                                         +---- bounded repair ------+
                                              |
                                              v
                                issue-level verifier -> grounded report
```

The team worker is an additive implementation of the existing worker port. It cannot change facing,
moderator, multi-session, verifier, or reporter transport boundaries. The parent issue owns the
cross-process execution claim; the team store makes per-role acknowledgment and restart decisions
durable inside that claim.

## Profile and evidence contract

A team profile contains exactly four unique roles. Each role declares an agent-profile id, one of
`codex|opencode|pi`, a provider/model binding, and semantic filesystem access. Only implementer is
`workspace_write`; all other roles are `read_only`. Repair count and required consecutive clean
cycles are positive bounded integers. The moderator selects only the profile id; it cannot construct
or mutate the profile.

Every role attempt emits a strict bounded result and one actor receipt. The receipt preserves role,
agent profile, adapter, provider/model, session/execution identity, usage availability, latency, and
cost. Adapter-requested evidence is allowed only when explicitly labeled. It is never upgraded to
provider-observed evidence or measured zero cost.

The role result is one versioned JSON object:

```text
{ version: 1, role, decision, summary, findings: [{ code, message }] }
```

`role` must equal the dispatched role. Decisions are `proceed` for explorer, `implemented` for
implementer, `pass|fail` for tester, and `clean|changes_requested` for reviewer. Summary is at most
8 KiB; there are at most 32 findings; each code is at most 80 characters and each message at most
2 KiB; the complete collected text stream is capped at 64 KiB. Duplicate codes, unknown fields,
wrong decisions, or any exceeded bound reject the result while retaining a valid paid receipt. Raw
output is never persisted. Downstream prompts receive only the validated bounded object. These
limits are immutable profile-independent safety policy.

`WorkerResult.receipt` remains the legacy lead-implementer receipt so existing single-worker callers
remain source compatible. Team results additionally carry `receipts` (every role attempt, including
that lead exactly once) and a bounded `team` projection containing profile id/digest, clean streak,
repair count, and role outcomes. The parent orchestrator validates every receipt against the
immutable team profile, rejects duplicate session/execution/idempotency identities, appends all of
them once to `IssueSnapshot.receipts`, and computes issue cost from that collection. The SQLite issue
snapshot therefore remains the authoritative aggregate; the team store is execution/recovery state,
not a second accounting authority. User-facing reports expose grounded state/files/verification and
aggregate cost, while detailed role evidence remains queryable from the issue snapshot.

## Durable recovery decisions

| Persisted state | Recovery action |
|---|---|
| terminal result | return the exact stored result |
| last role acknowledged; next role undispatched | continue from the next stable step id |
| role marked running without acknowledged result | return unknown; never blind-replay |
| worktree allocation recorded with stale process lease | validate and release the exact lease, then continue |
| dispatch/profile/task fingerprint mismatch | fail closed as request-id reuse conflict |

The store records only validated summaries/findings and receipts, not prompts, credentials, or raw
model streams. Final issue completion still requires the independent acceptance-check verifier.
Claiming a role attempt durably stores its stable step and idempotency key before adapter execution;
acknowledging it is a later optimistic-version transition that stores only the validated result and
receipt. A process loss between those transitions is therefore an unknown outcome, not permission
to redispatch.
The immutable profile is part of the original issue request fingerprint. Each team run stores its
profile digest and rejects a duplicate dispatch whose task, obligations, checks, workspace, or
profile digest differs.

## Orca reference adoption

Pinned Orca reference: `4c03cdff72d4217994b60563e1edf2236e99a747`.

Adopted: stable run identity separate from worktree identity; explicit agent kind; worktree-bound
sessions; durable acknowledged state; honest stopped/failed/unknown outcomes; exact resource and
process evidence. Deferred: Electron/terminal rendering, mobile, SSH, broad agent catalog, diff UI,
and browser design mode. Rejected: terminal title or process-name inference as execution authority,
Orca database/RPC coupling, and treating any arbitrary CLI command as a trusted coding profile.

## Error and recovery map

| Step | Failure | Recovery | User-visible result |
|---|---|---|---|
| profile validation | unknown role/adapter/model/access | reject before allocation | failed |
| worktree allocation | path/lease/Git boundary rejection | no role spawn | failed |
| role execution | honest session failure with receipt | persist failed attempt | failed |
| role result parsing | missing/oversized/malformed envelope | reject result, retain receipt | failed |
| repair loop | configured limit reached | preserve findings and stop | failed |
| restart | in-flight outcome cannot be proven | no replay | outcome_unknown |
| final verification | any acceptance check fails | grounded report preserves failure | failed |

## Verification and completion claim

The acceptance suite must exercise the real team state machine and SQLite store with deterministic
role executors, plus the real Supervisor composition with fake Codex/OpenCode/Pi protocol streams.
The benchmark artifact must be reproduced from tracked source and contain zero paid calls. Full
regression is rerun; pre-existing environment-sensitive failures remain separately named. Completion
requires two consecutive external Clean reviews on one unchanged candidate and re-reading the
orchestration SoT before each review.
