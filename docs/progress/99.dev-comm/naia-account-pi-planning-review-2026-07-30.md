# Planning review — Naia account Pi/Azure

Stage: planning
Reviewers: independent reviewer A and B (external CLI reviewers were unavailable)
Rounds: 3 document revisions
Result: plan corrected; implementation blockers enumerated

## Evidence ledger

| Finding | Evidence | Status | Plan action |
|---|---|---|---|
| DeepSeek analysis/coding could not be inferred from prose. | Pi help documents `--no-tools`; CLI had no tool-policy flag. | ACCEPTED | require explicit `--no-tools`; omit natural-language inference. |
| Gateway metadata did not prove enforcement. | draft `chat.py:_validate_model_request_capabilities` exists before upstream, but tests/mapping were absent. | ACCEPTED | require HTTP 400 and upstream call count zero. |
| Parent secrets/global Pi config could leak or reroute. | subprocess inherited parent env and Pi default config. | ACCEPTED | isolated config plus child env allowlist and stale-config tests. |
| Two Azure models could share the first cached endpoint. | client cache key was provider-only and config provider-wide. | ACCEPTED | per-model endpoint/deployment plus cache fingerprint and order tests. |
| Reserved model IDs could use explicit direct-provider prefixes. | explicit `provider:model` bypassed bare inference. | ACCEPTED | reject non-Azure prefixes for reserved IDs. |
| Pricing absence could produce a truthful-looking unbilled success. | current Gateway records usage without charge when pricing is missing. | ACCEPTED | reserved Azure models require active pricing before upstream. |
| DeepSeek ordinary Shell chat could still carry tools. | ordinary Agent pipeline may expose tools independently of Shell catalog. | ACCEPTED | Agent request shaping omits tools/tool_choice for DeepSeek; stale catalog test. |
| Manual and live completion claims were vague. | no named artifact/oracle; local credentials absent. | ACCEPTED | named executable manual; live clause remains OPERATIONAL_UNVERIFIED until run. |
| Pi fallback version floated. | fallback used unversioned `npx --yes`. | ACCEPTED | pin package and test offline/missing behavior. |

## Implementation gate

Implementation may start only against the revised contract. Development review
must reject completion until every ACCEPTED finding above is represented by an
executable negative or order-dependent test. Planning convergence does not imply
that the current draft code already satisfies the plan.
