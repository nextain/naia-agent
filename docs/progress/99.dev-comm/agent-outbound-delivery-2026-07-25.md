# UC-019 durable outbound delivery contract

Status: in progress. Requirement authority: user request on 2026-07-25.

## Decision

There are two deliberately separate clocks.

1. `ProactiveScheduler` remains an in-process, profile-session timer for radio DJ and exhibition speech. Input, stop, or a profile change cancels it. It does not survive restart and cannot deliver an external message.
2. `ScheduledTaskRuntime` is a durable, host-owned task scheduler. It persists recurrence, next run, execution identity, delivery outbox, retry state, and history.

The former must not be repurposed as cron: doing so would make a conversation-local voice timer silently acquire restart recovery and external delivery authority.

## Boundaries

- The generic task schema is provider-neutral. `runnerKind: "chat-report"` means “use the active main provider”; the first production acceptance sets that provider to Codex. PI is a later runner/provider test, not a second implementation path now.
- Destination identifiers are selected from Shell-owned policy: an approved Discord DM user id or an approved guild/channel binding. The LLM never turns arbitrary text into a destination.
- Discord is the first `DeliveryPort`; future mail/Slack adapters use the same task/outbox contract.
- Attachments are workspace-relative, canonicalized under approved roots, bounded, and exclude `data-private`/secret paths. Delivery disables all mentions.
- Schedule creation/change and direct send use `ask`. A stored recurring task carries its explicit delivery grant, so it does not prompt on every run.
- A run uses a stable occurrence id. A completed or in-flight outbox item is never re-run as a new occurrence after restart. Ambiguous network failure is reported as unknown/failure, never silently claimed delivered.
- Timezone is required for cron. `at`, `every`, and cron schedules have a bounded next-run calculation. Default late/misfire behavior is `skip`, avoiding a restart flood.

## Acceptance chain

`REQ-017 → UC-019 → TEST-S-019 → SPEC-016 → TEST-F-016`

The Shell work supplies destination policy, schedule controls and run history; the Agent owns execution and delivery. The initial Tauri E2E must exercise a real paired Agent process with a fake Discord HTTP endpoint, not a component-only assertion.
