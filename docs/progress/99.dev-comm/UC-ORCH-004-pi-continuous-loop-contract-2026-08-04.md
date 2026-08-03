# UC-ORCH-004 Pi continuous-loop contract

## Objective

Expose the existing durable orchestration stack as one standalone Naia Agent control session whose
coding roles use embedded Pi. This is a cost-optimized assistant/orchestrator path, not an attempt to
replace Codex or Claude capability, and not an OpenCode wrapper.

## Invariants

1. The Pi-only composition has no OpenCode import or fallback edge.
2. A paid provider effect cannot begin until its stable key and conservative allowances are committed.
3. Crash-unknown reservations remain charged and block unsafe replay.
4. Settlement accepts only complete token and measured-or-explicitly-estimated priced usage bound to
   the same key and expected model. Estimated evidence never authorizes an Azure savings claim.
5. Multi-session identity, question binding, worktree isolation, verification, and grounded reports
   retain REQ-021 through REQ-023 semantics.
6. Repair and clean-cycle counts are the loop bounds; two minutes is not a product ceiling.
7. Discord ingress and naia-shell presentation are later adapters.

## Evidence plan

- deterministic SQLite concurrency/restart tests;
- Pi-only composition/import-boundary tests;
- multi-message foreground-control tests plus durable backend restart and multi-session integration;
- a zero-paid frozen end-to-end corpus that drives the real Pi-only composition with deterministic
  provider/worktree/verifier effects, hashes the exact executed JavaScript, proves it is the current
  TypeScript emission, and mutation-tests forbidden import/executable edges, plus an opt-in one-call
  route/receipt smoke;
- an explicit unavailable result—not a completion claim—until identical candidate/control cases
  expose authoritative provider-priced receipts for the cost-efficiency gate;
- a frozen paired case with equal paid-call denominators, deterministic file/Git scoring, checkpoint
  reopen, a combined 20-call/$0.50 ceiling, and a 10% minimum saving. Its pure decision gate rejects
  missing/extra/unsettled receipts, estimate-only cost, route/token drift, and any receipt lacking
  execution ID ↔ gateway request ID ↔ price-version binding. It also enforces the combined caps and
  exact per-role attempt counts, rejects cross-arm execution/gateway identity reuse, and requires
  both arms to bind the same frozen starting-worktree digest and model-specific price versions;
- two clean review-pass cycles against an unchanged candidate.

## Azure model qualification boundary

Microsoft's current Foundry catalog lists `DeepSeek-V4-Flash` and confirms that it has no tool
calling. The workspace routing SoT still marks that binding inactive, and the Naia Pi gateway
catalog currently exposes only `deepseek-v4-pro` and `grok-4.3`. Therefore Flash is not silently
substituted into this implementation. The deterministic profile uses the deployed analysis-only
DeepSeek route for read-only roles and the tool-capable Grok route for implementation. A Flash live
comparison requires an explicit gateway catalog/credential activation and complete priced receipts;
the public Azure pricing table does not currently expose numeric Flash rates without account context.

## Current exact-receipt blocker

The current AnyLLM profile log exposes model, tokens, and customer cost, but not a value that binds the
row to Pi's local execution ID. Its legacy streaming accounting path also does not return a versioned
gateway request/price receipt through Pi's `message_end`. A before/after profile-log delta would be
vulnerable to concurrent account use, so it is explicitly rejected. Until a request-correlated
versioned receipt reaches the Pi event, the paid comparison exits unavailable with zero calls when
evidence is absent; this is a missing integration capability, not a successful cost result.
Self-asserted JSON is only structurally inspected: without authenticated gateway export and a
verified harness journal, the analyzer always returns `unavailable` with claims disabled.
