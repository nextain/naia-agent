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
9. A locally correlated gateway receipt is sufficient for operational budget settlement. A bounded
   internal comparison additionally requires an external-key HMAC over the complete evidence; the
   unsigned gateway response is never represented as a transferable public audit.
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
  exact per-role attempt counts, rejects cross-arm execution/gateway identity reuse, requires
  both arms to bind the same frozen starting-worktree digest and model-specific price versions, and
  verifies an HMAC key identity pinned before any paid call. Tampering, omission, replay under a
  different contract, a missing key, or a wrong key fails closed;
- two clean review-pass cycles against an unchanged candidate.

## Azure model qualification boundary

The local gateway candidate now exposes the Azure deployment alias
`DeepSeek-V4-Flash → deepseek-v4-flash`, and the Agent treats Flash and Pro as analysis-only models.
The paid candidate profile uses the lower-cost Flash route for facing/read-only roles and the
tool-capable Grok route for implementation; the control keeps Grok for every role. This is a routing
contract, not a price claim. A live comparison still requires the deployed gateway catalog, credential,
and complete price-versioned receipts because no numeric Flash rate is inferred from model metadata.

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
gateway. The paired analyzer now verifies an external-key HMAC over all contract bindings, arm
denominators, quality results, request-correlated receipts, independently reread receipt-journal heads,
the complete per-arm shared-ledger delta, exact decimal costs, and budget evidence. Savings thresholds
and the combined USD cap are decided with integer fixed-point arithmetic. Price and HMAC identities are
supplied through a benchmark/task-bound pins file whose exact SHA-256 must first be anchored in the
frozen task contract; an arbitrary caller-supplied pins file has no authority.
It enables a claim only for the frozen internal case after that verification. The current gateway
response remains unsigned, so this does not establish a provider-issued public attestation. Live
evidence remains unavailable until the credential, model price-version IDs, and HMAC key ID are pinned.
`prepare-pi-cost-pins.mjs` creates the exact pins file and a derived contract with zero network and paid
calls. The derived loader permits only `pinsDigest` to differ from repository SoT, and both live runner
and analyzer consume the same `--contract`/`--pins` pair.
The HMAC key is removed from all model, verifier, digest, and Git child environments; benchmark Git also
ignores system/global configuration and uses an isolated empty hook path.
The pinned file additionally binds an absolute Git executable and SHA-256. The runner rechecks that binary
before every use, injects it into worktree and changed-file operations, replaces the benchmark verifier's
Git subprocess with the same trusted boundary, and removes provider credentials from Git and digest child
environments.
The frozen comparison contract pins a manifest digest for the runner, analyzer, integrity helpers,
complete transitive local runtime closure, the separately loaded Pi billing extension, its narrow direct `pi-ai` OpenAI-completion dependency
closure, package/lock files, and the workspace-local Pi executable's full statically reachable package
graph. Inherited `PI_BIN` is ignored.
Critical entry modules are preloaded before model execution and the complete closure is rehashed before
every actor spawn and after each arm, preventing an arm from replacing signer, billing, or provider code
before a credential-bearing child or the parent can use it. Benchmark writers use a shell-free Pi tool
allowlist, and read-only roles are intersected to read-only tools, so the child has no alternate network
execution path around the ledger.
The same extension blocks `read`, `write`, `edit`, `grep`, `find`, and `ls` paths that leave the actor's
real worktree or traverse a symbolic link outside it, including absolute paths and paths whose leading
`@` Pi strips before execution.
