# Issue #97 — Naia Harness Book extraction for the CLI manual

Source: `D:/alpha-adk/data-private/naia-harness-book-en/`
Target: `docs/naia-agent-cli-manual.md`

This is a project-manual extraction, not an ADK-family governance change. No rule, hook, permission,
or fork-chain propagation is proposed.

| Book evidence | Project evidence | Judgment | Manual action |
|---|---|---|---|
| Ch.7:3, 9-13 — boundaries need mechanically checkable input/output contracts | `cli-manage.ts` closed command/config unions; process JSON tests | satisfied | document command grammar, JSON fields, exit codes |
| Ch.7:118-148 — new code files need layer/UC/contract anchors | `module-manifest.json` entry for `cli-manage.ts` | satisfied for new `src/main` file | include trace path and anchor verification |
| Ch.9:3, 34-38 — every design item must be closed by the corresponding test | REQ-020 → UC-023 → SPEC-019 → TEST-S/F | satisfied | manual validation maps user steps to UC/FE evidence |
| Ch.9:42-61 — structure and scenario traceability are orthogonal | global workspace pointer vs workspace `naia-settings/cli.json`; V-model registries | satisfied after correction | explain the two storage scopes and trace chain |
| Ch.10:189-210 — test invariants, not nondeterministic exact outputs | controlled gateway model evidence tests; live smoke checks model/token/exit, not prose | satisfied | live acceptance checks invariants only |
| Ch.10:214-226 — automated verification has limits; do not trust self-report alone | external reviewers were unavailable/invalid; full mechanical suite passed | partial | state reviewer degradation and retain manual inspection checklist |
| Ch.15:138-144 — clear status/errors, explicit permissions, recorded state, independent failure | doctor component status, OS credential store, transcript sessions, command exit isolation | satisfied | organize manual around status/security/history/failure recovery |

Adversarial exclusions:

- The book’s Naia App UI guidance is not imported into this CLI issue; naia-shell coding UI is explicitly deferred.
- No new approval prompts are added to read-only status/config/session commands.
- The book is not treated as proof that the implementation works; executable tests and live model evidence remain the authority.
