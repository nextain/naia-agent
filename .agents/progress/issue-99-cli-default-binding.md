# Issue #99 — bind stored CLI defaults to agent and model

GitHub issue: <https://github.com/nextain/naia-agent/issues/99>

Trace: `REQ-020 → UC-023 → SPEC-019 → TEST-S-020 / TEST-F-019`.

## P01 — user and failure scenario

A user stores `pi/grok-4.3/tools=true|false`, then explicitly selects another agent or model for one
run. The explicit choice must not inherit model capability flags from the stored tuple. Repeated
`--agent` or `--model` options follow the downstream parser's last-option-wins behavior.

## P02 — test coverage

- Pure FE contract: stored tuple, explicit matching/mismatching agent and model, tools true/false,
  explicit tools override, and repeated value options.
- UC process integration: isolated HOME stores a Pi tuple and successfully dispatches an explicit
  Shell child without relying on the Pi defaults.
- Regression: full build/test and real installed CLI DeepSeek guard/smoke.

## P03 — design

`applyCodingDefaults` resolves the final explicit agent/model with `lastIndexOf`. Stored model applies
only when the explicit agent is absent or matches the stored agent. Stored tools applies only when
both explicit agent and explicit model are absent or match their stored values, and neither tools
flag is explicit.

## Adversarial review

- DeepSeek security review returned one usable report plus several rejected false positives. DPAPI
  temp content is encrypted, PowerShell receives the secret through stdin rather than argv,
  `removeEnvLines` preserves unrelated content, and env writes do not overwrite existing values.
- GPT-5.6 Sol independently reproduced three precedence failures: tools leakage across agent,
  tools leakage across model, and first-occurrence handling for repeated agent flags.
- Claude Opus independently reproduced the agent/model tools leakage. Grok was unavailable due to
  Azure rate limiting; Codex review exceeded the bounded review window and was not counted.

Consensus finding: stored `agent/model/tools` must be treated as one bound default tuple.

Post-fix review found a second valid boundary: defaults were applied before downstream parsing, so a
dangling value option could be masked by appended flags, and raw token lookup could confuse an option
value with a real flag. The fix uses an option-consuming scanner, leaves malformed argv unchanged for
the downstream error path, rejects flag-shaped required values, and rejects stored model IDs beginning
with `-`.

The final adversarial pass found that the pure config setter still accepted `workspace=--help`.
Although the CLI host already rejects it as a non-absolute path, the config layer now independently
rejects option-shaped workspace values so both boundaries enforce the same contract.

## Completion

- Development review: GPT-5.6 Sol + Claude Opus consensus findings fixed; final DeepSeek
  adversarial review CLEAN. Evidence:
  `.agents/reviews/issue-99-cli-default-binding-2026-07-31.json`.
- UC/FE tests: build plus 3 targeted files / 53 tests passed.
- Full integration: serialized full suite 128 files / 1,426 tests passed; 9 opt-in environment
  tests skipped. The initial parallel run's single Windows DPAPI exit-78 failure passed alone and
  in the serialized full suite, confirming process-resource contention rather than a regression.
- Policy: traceability dead-link/orphan 0; terminology, logging, compile integrity, CI contracts,
  document graph, conflict markers, and diff checks passed.
- PR CI baseline: `code-gates` fails before tests because the workflow specifies pnpm `10` while
  `packageManager` specifies `pnpm@10.33.0`; OSS readiness reports the unchanged 18-item repository
  baseline. These failures are outside the #99 diff and are recorded rather than represented as clean.
- Installed CLI smoke: pending
