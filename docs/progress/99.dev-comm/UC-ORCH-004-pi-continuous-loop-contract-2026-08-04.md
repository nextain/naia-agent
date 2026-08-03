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
- two clean review-pass cycles against an unchanged candidate.

## Azure model qualification boundary

Microsoft's current Foundry catalog lists `DeepSeek-V4-Flash` and confirms that it has no tool
calling. The workspace routing SoT still marks that binding inactive, and the Naia Pi gateway
catalog currently exposes only `deepseek-v4-pro` and `grok-4.3`. Therefore Flash is not silently
substituted into this implementation. The deterministic profile uses the deployed analysis-only
DeepSeek route for read-only roles and the tool-capable Grok route for implementation. A Flash live
comparison requires an explicit gateway catalog/credential activation and complete priced receipts;
the public Azure pricing table does not currently expose numeric Flash rates without account context.
