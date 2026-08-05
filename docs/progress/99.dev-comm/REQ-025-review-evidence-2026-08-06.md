# REQ-025 review evidence — 2026-08-06

## Scope

- Naia chat tools for starting, listing, inspecting, answering, and cancelling
  durable coding sessions.
- Trusted host configuration for workspaces, bindings, and model profiles.
- Existing Codex, OpenCode, Pi, and Claude Code issue-team composition.
- CLI wiring through `--coding-config` without changing Discord or Shell entry
  points.

## Automated evidence

- Build: passed.
- Focused contract and integration tests: 55 passed, 1 skipped.
- Complexity preflight: clean, digest
  `sha256:37b69dafa3e8e963b2ffcf7c9e5e26dd54aa33c06cccb5e8402a003123333e77`.
- Structure and CI verification suites: passed.
- Conflict-marker and contract-conformance checks: passed.
- Traceability check: no new dead links; two pre-existing `UC-020` advisories
  remain.
- File-anchor check: the new adapter anchor passed; 30 pre-existing anchor
  findings remain outside this change.

## Independent review attempts

- Gemini reviewer: unavailable because authentication and quota checks failed.
- Default OpenCode reviewers: DeepSeek and Codex attempts exceeded the review
  timeout and produced no usable verdict.
- OpenRouter fallback: `openrouter/inclusionai/ling-3.0-flash:free` passed the
  readiness probe, then inspected the requested implementation and tests, but
  did not return a final verdict before timeout.

No independent reviewer returned a complete CLEAN/NEEDS_CHANGES verdict. This
checkpoint therefore remains **REVIEW_ONLY** and must not be represented as
release-approved or remotely published based on this evidence alone.

## Deterministic benchmark note

The issue-team benchmark intentionally rejects dirty trusted inputs. The
implementation must first be committed locally, after which its evidence can be
regenerated against that exact revision and committed separately.
