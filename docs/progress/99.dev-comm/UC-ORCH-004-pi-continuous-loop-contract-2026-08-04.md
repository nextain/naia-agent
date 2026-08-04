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
8. Atomic gateway billing is adapted only on the Naia route. The parent owns the execution identity
   and accepts measured cost only from an ordered, owner-only, request-correlated receipt journal.
9. A locally correlated gateway receipt is sufficient for operational budget settlement, but not for
   a public savings claim without independent gateway and harness attestations.
10. Actor attempts and billable gateway requests have separate durable ceilings. Every new logical
    gateway request reserves calls, USD, input, and output allowances before network I/O; retries reuse
    that reservation. Every paid benchmark path requires a durable output and preserves partial evidence.

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
- a frozen paired case with equal actor-attempt topology, deterministic file/Git scoring, a separate
  Node process that reopens and hashes the checkpoint before paid execution, combined
  20-actor-attempt/60-gateway-call/$0.50 ceilings, and a 10% minimum saving. Every
  tool-loop gateway request is separately counted, so request-count differences remain part of cost.
  Its pure decision gate rejects
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

## Exact-receipt integration boundary

The AnyLLM atomic billing route rejects streaming, while Pi's native OpenAI-compatible tool loop
expects SSE. The Agent therefore owns a narrow Naia provider extension: it sends each logical turn as
non-streaming, adds a request ID derived from the parent execution identity, validates the settled
versioned billing response, writes an atomic 0600 receipt journal, then reconstructs a standards-based
SSE response for Pi. Retries keep the logical gateway request identity and advance only the attempt.
The parent rejects missing, reordered, conflicting, route-drifted, token-drifted, or unsettled rows.
The extension also shares a SQLite request ledger across both benchmark arms. It reserves a
conservative allowance before `fetch`, settles exact receipt usage afterward, leaves ambiguous effects
reserved, and commits over-allowance actuals before failing the work. The paid comparison and one-call
smoke write incremental status outside their evidence directories and never delete those directories
on a partial failure. Continuous-loop and benchmark compositions inject shared contract budgets; the
common Naia Pi factory supplies legacy CLI and mixed-team paths an execution-local durable fallback
bounded to 8 gateway calls, $0.20, 32,000 input tokens, and eight output allowances, so no Naia
extension invocation can reach provider I/O without a ledger.

This closes exact local request correlation for operational budget settlement without changing the
gateway. It does not solve independent attestation: the child process can write its own journal and
the current gateway response is unsigned. Self-asserted JSON is therefore only structurally inspected;
without authenticated gateway export and a verified harness journal, the analyzer always returns
`unavailable` with claims disabled.
