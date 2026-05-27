# Context Integrity Sub-Agent — Architecture Cross-Review

Gate: codex (Reviewer A — security/contract-boundary/design-conformance) +
gemini (Reviewer B — implementation correctness/test validity/robustness).
Read-only review. No code changes.

Architecture doc: `.agents/progress/context-integrity-arch-2026-05-27.md`

## Round Ledger

| R | codex (A) | gemini (B) | action |
|---|-----------|------------|--------|
| 1 | ISSUES — MAJOR: auto-fix underspecified (stale/contradiction/duplicate can destroy valid entries); MAJOR: judgment rule "먼저 정의된 것" unsafe (use file precedence SoT order instead); MAJOR: --workdir isolation insufficient (symlink/abs-path escapes); MINOR: shared scan+write channel = prompt injection; MINOR: Phase 3 scheduler belongs in host/CI not naia-agent | ISSUES — MAJOR: stale detection underspecified (needs git/issue state → scope to text-self-evident only); MAJOR: judgment heuristic brittle (older rule may be wrong legacy); MAJOR: isolation/write contradiction (격리 원칙 vs resolutions field); MINOR: missing broken-internal-ref + outdated-standard types; MINOR: benchmark overfitting risk; MINOR: location/change schema underspecified | fix all MAJOR, address MINOR |

## Resolutions

### MAJOR fixes applied to v2 architecture

- **Auto-fix scope**: Phase 1 = REPORT-ONLY. Auto-fix limited to `broken-ref` (mechanically provable). All other types → `requires_user_input` proposal only.
- **Judgment rule**: Replace heuristic with explicit file precedence: `agents-rules.json > AGENTS.md > project-index.yaml > derived mirrors`. If no machine-readable precedence resolves → `requires_user_input`.
- **Isolation**: Rename "격리 원칙" to include: reject absolute paths, resolve realpaths, deny symlink escapes. Verifier-level path validation required.
- **Stale detection scope**: Limit to text-self-evident markers only (MOOT, RESOLVED, CLOSED, DEPRECATED in text). No external state (git history, issue tracker) in Phase 1.
- **Channel separation**: Scan = read-only. Output = separate `.integrity-report.json` file. System prompt must declare context files as DATA (injection prevention).

### MINOR notes (Phase 2 scope)

- `broken-internal-ref` (intra-file anchor) + `outdated-standard` (conflicts with package.json/tsconfig) → Phase 2 types
- Benchmark: hold-out fixture set + fixture variation for generalization test
- JSON schema: `location: { start_line, end_line }`, `change: unified-diff format`
- Phase 3 scheduler: host/CI runs verifier command, naia-agent exposes runner only
