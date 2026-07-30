# Naia account Pi/Azure contract — issue #93

## Goal and boundary

Two supported entry points must reach the same supervised Pi runtime:

1. `Codex -> naia-agent run --agent pi -> Pi -> Naia gateway -> Azure`
2. `naia-agent run --agent pi -> Pi -> Naia gateway -> Azure`

The supported model set for this slice is exactly `grok-4.3` and
`deepseek-v4-pro`. Sol, Terra, Luna and Shell Coding Workers are out of scope.
OpenCode remains an independent legacy adapter and is never a fallback here.

`grok-4.3` is the tool-using coding model. Azure declares
`deepseek-v4-pro` without tool calling, so it is analysis/review-only and a Pi
coding request must fail before a child process or upstream request starts.

## Requirements (human authority)

| ID | Requirement | Acceptance evidence |
|---|---|---|
| REQ-NAIA-PI-001 | Both entry points use the same `naia-agent` CLI and Pi adapter. | `uc-naia-pi-cli-process.integration.test.ts` exercises direct and parent-process invocation and compares JSON evidence. |
| REQ-NAIA-PI-002 | A Naia login is sufficient; users do not supply Azure, xAI or DeepSeek credentials. | child env/config contract contains only a Naia-key reference; direct-provider keys are absent. |
| REQ-NAIA-PI-003 | `grok-4.3` performs a bounded tool-using coding task through the Naia gateway. | temp workspace: one allowed file diff, verifier pass, no escape, bounded timeout/cancel; mocked Azure integration. Live status stays UNVERIFIED until an existing deployment is exercised. |
| REQ-NAIA-PI-004 | `deepseek-v4-pro` performs non-tool analysis only when `--no-tools` is explicit. Without it, Agent rejects before spawn; Gateway rejects any request body containing tools before upstream. | parser boundary cases, child spawn count=0, Gateway 400 and upstream call count=0, positive `--no-tools` process test. |
| REQ-NAIA-PI-005 | Request model, Azure endpoint/deployment, usage and billed key preserve canonical identity; there is no silent fallback. | exact spawn plus `azure:<model>` usage/billing assertions, per-model endpoint/cache-order tests, negative direct alias/fallback cases. |
| REQ-NAIA-PI-006 | A fresh CLI process with an isolated HOME reuses only `naia-agent login --provider naia`. | actual login + fresh CLI process test loads isolated `.naia-agent/.env`; no run-time key argument or developer HOME/env. |
| REQ-NAIA-PI-007 | `docs/naia-account-pi-manual.md` is verified as an executable acceptance script. | exact prerequisites/commands/exit codes/model evidence/failure table; manual commands run in isolated HOME with a named env allowlist. |

## UC and Feature mapping

| UC | User-visible outcome | Feature (FE) | Tests |
|---|---|---|---|
| UC-NAIA-PI-1 | Codex invokes the CLI and receives one honest supervisor report. | FE-NAIA-PI-1 shared CLI host and Pi adapter | CLI subprocess integration |
| UC-NAIA-PI-2 | Standalone CLI runs Grok coding with the Naia account. | FE-NAIA-PI-2 generated secret-free Pi provider config | config unit + fake Pi + live opt-in |
| UC-NAIA-PI-3 | Standalone CLI runs explicit `--no-tools` DeepSeek analysis. | FE-NAIA-PI-3 CLI tool policy and model/capability resolver | positive no-tools contract |
| UC-NAIA-PI-4 | DeepSeek coding fails before spawn/upstream. | FE-NAIA-PI-4 capability guard at both trust boundaries | negative Agent + Gateway tests |
| UC-NAIA-PI-5 | Restarted CLI reuses stored Naia login. | FE-NAIA-PI-5 shared env-file loader | real child-process integration |
| UC-NAIA-PI-6 | User can diagnose auth, unsupported model and upstream failure without a leaked secret. | FE-NAIA-PI-6 structured/redacted failure evidence | missing-key, 401/400, redaction tests |

## Design

- `any-llm` owns bare-model-to-Azure routing, upstream credentials, capability
  enforcement, model identity, pricing and credit settlement.
- `naia-agent` owns CLI login loading, Pi custom-provider materialization and
  pre-spawn capability validation. Generated Pi configuration stores
  `$NAIA_API_KEY`, never its value.
- Pi receives provider `naia`, the exact model ID and workdir. DeepSeek also
  receives `--no-tools`; natural-language intent is never used as a security
  decision. The provider base URL defaults to `https://api.nextain.io/v1`; tests
  may use the existing explicit Naia gateway override.
- The Pi child gets a runtime allowlist plus `NAIA_API_KEY`; direct-provider
  secrets are removed. Its isolated `PI_CODING_AGENT_DIR` contains a pinned,
  secret-free `models.json` with Pi's documented `$NAIA_API_KEY` interpolation
  and `X-AnyLLM-Key: Bearer $NAIA_API_KEY`. Tests cover stale global config,
  concurrent runs, interpolation and missing-key behavior.
- The Pi package version is pinned in `package.json`; no floating `npx` package
  may define the acceptance result.
- Gateway configuration resolves an explicit per-model Azure endpoint/deployment
  route. Client cache identity includes the endpoint/config fingerprint, so
  Grok→DeepSeek and DeepSeek→Grok cannot reuse the wrong client.
- Gateway logs/bills `azure:grok-4.3` or `azure:deepseek-v4-pro`. Pi terminal
  parsing retains the provider/model reported by Pi plus token usage; a mismatch
  against the CLI selection fails. Pi 0.83 does not expose the HTTP response
  model separately, so the gateway owns that independent assertion.
- `grok-4.3` and `deepseek-v4-pro` are reserved Naia model IDs: explicit
  `xai:`, `deepseek:` or any non-Azure prefix is rejected before pricing/upstream.
- Both reserved models require an active `ModelPricing` row. Missing pricing is
  a configuration error before upstream, never a successful unbilled request;
  configured decimal rates, usage cost and credit deduction remain a DB-backed
  operational acceptance; without Docker/live credentials they are not claimed.
- `naia-shell` only exposes and calls the same Naia models through its existing
  provider pipeline. For ordinary DeepSeek chat, Agent resolves
  `supportsTools=false` and omits `tools`/`tool_choice`; Grok preserves the
  existing tool policy. Catalog failure cannot turn DeepSeek tools back on.
  Coding/workspace orchestration is deferred.

## Adversarial cases to lock as tests

1. Missing Naia key falls through to a native xAI/DeepSeek key.
2. A key value is serialized into `models.json`, argv, stderr or a report.
3. Bare model inference routes Grok to xAI or DeepSeek to a direct provider.
4. DeepSeek tools are silently removed and the run falsely reports success.
5. Pi uses a stale global provider definition instead of the generated config.
6. Gateway catalog and execution disagree on tool support.
7. An alias changes the billed/logged model key or bypasses credit checks.
8. Parent Codex invocation differs from direct CLI invocation.
9. An upstream failure is replaced by Gemini/OpenCode without consent.
10. The manual passes only because the developer shell has hidden env.

## Manual acceptance artifact

`docs/naia-account-pi-manual.md` contains prerequisites; login; exact direct,
Codex-parent, Grok coding and DeepSeek `--no-tools` commands; expected exit codes;
provider/model/usage/diff/verifier evidence; isolated-HOME instructions; and an
auth/capability/upstream/verification failure table. The non-live commands are
executed by a test, and a context-free reader review checks hidden assumptions.

## Verification order (Harness Book chapters 9–10)

1. Deterministic build, unit, contract, integration, traceability and secret scans.
2. Adversarial planning/development/test/integration reviews; discoveries become tests.
3. Controlled Pi subprocess, then an existing-credential live smoke.
4. Execute the manual in a clean child environment and record model/result.
5. Record tokens/time/rework; do not infer savings from one run.

## Done

All non-live deterministic gates and the manual dry-run pass. Live Azure smoke
runs only when already-provisioned endpoint, deployments and a Naia test account
exist. Until then the real-Azure clause of REQ-NAIA-PI-003 is
`OPERATIONAL_UNVERIFIED`, and P05 cannot claim live routing or cost completion.
Every completed claim is linked in issue #93.

## Implementation verification — 2026-07-30

- Agent build and full regression: PASS — 1,376 passed, 9 opt-in/live skipped.
- Actual CLI process acceptance: PASS — isolated HOME login, fresh direct CLI,
  one-level parent invocation, equal JSON evidence, and DeepSeek missing
  `--no-tools` with upstream call count zero.
- Real Pi 0.83 controlled integration: PASS — Grok `write` tool telemetry and
  one-file workspace boundary; DeepSeek request has no tools.
- Paired Shell ordinary-chat request shaping: PASS — Shell persists the exact
  model and Agent's exact-model provider policy omits DeepSeek tools.
- any-llm deterministic Azure route tests: PASS — reserved route, capability,
  pricing, route ordering/upstream-zero, endpoint/config cache isolation.
- `verify-conflict-markers` and diff whitespace: PASS in all three worktrees.
  `verify-i18n`'s documented locale-table paths do not exist in this Agent
  architecture; new CLI text follows the existing Korean CLI surface and its
  host/report contract tests. No Shell production UI hardcoded string was added.
- Live Azure and DB-backed usage/cost/credit evidence: `OPERATIONAL_UNVERIFIED`.
  No Naia/Azure credential is present and Docker Desktop is not running, so the
  testcontainer suite cannot start. This is not reported as a live success.
