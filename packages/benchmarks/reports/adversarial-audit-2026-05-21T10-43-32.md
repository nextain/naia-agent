# Adversarial Audit — R7-Phase-A2+B+C+D-final — 2026-05-21T10-43-32

**Files audited**: 11
**Prompt size**: 3518 chars
**AIs queried**: 4
**Valid responses**: 2/4

## Files

- `packages/benchmarks/src/visible-context.ts`
- `packages/benchmarks/src/fixture.ts`
- `packages/benchmarks/src/runner.ts`
- `packages/benchmarks/scripts/mini-bench-judge.ts`
- `packages/benchmarks/scripts/adversarial-audit.ts`
- `packages/benchmarks/src/judges/prompt.ts`
- `packages/benchmarks/src/__tests__/visible-context.test.ts`
- `packages/benchmarks/src/__tests__/harness-smoke.test.ts`
- `packages/benchmarks/src/fixtures/F-KR-TR-01-temporal-reasoning.fixture.json`
- `packages/benchmarks/src/fixtures/F-LME-test-002.fixture.json`
- `packages/runtime/src/compaction/vercel-prepare-step.ts`

## glm — ok (102525ms)

```
### SECTION 1 — FINDINGS

**Finding #1**  
Severity: MAJOR  
Location: packages/benchmarks/src/fixture.ts:42-48  
What code does: `validateFixture` silently coerces `preservedTailLength` to a number via `Number()` without validation, accepting invalid values like `null`, `undefined`, or negative numbers.  
Reproduction scenario: Load a fixture with `preservedTailLength: null` or `-5`. Validation passes, but `VisibleContext` later throws errors.  
Why broken: Silent coercion hides authoring bugs and breaks the contract between fixture definition and runtime behavior.  

**Finding #2**  
Severity: HALT  
Location: packages/benchmarks/src/runner.ts:35-40  
What code does: `runStrategy` passes `strategy.currentTurn` to `fixture.getVisibleContext()`, but strategies with identical `currentTurn` values share the same `VisibleContext` object.  
Reproduction scenario: Two strategies with `currentTurn: 2` receive the same context object, enabling cross-strategy state pollution.  
Why broken: Mutable context sharing breaks isolation, making results non-deterministic and meaningless.  

**Finding #3**  
Severity: MAJOR  
Location: packages/benchmarks/src/judges/prompt.ts:15-18  
What
```

## opencode — infra-error (180064ms)

*Infra error*: exit null: 

## codex — infra-error (180049ms)

*Infra error*: empty stdout

## gemini — ok (71088ms)

```
The adversarial audit of the benchmarking harness and compaction logic (R7-Phase-A2+B+C+D-final) is complete. Below are the findings based on a full reading of the specified source files and execution of the "audit loop" in logic.

### SECTION 1 — FINDINGS

**Finding #1: Deterministic Task Accuracy Heuristic is extremely weak and prone to noise.**
*   **Severity:** MAJOR (results misleading)
*   **Location:** `packages/benchmarks/src/runner.ts:167-175`
*   **What code does:** For `task-accuracy` probes, it checks if the first 8 characters of every `factTurn` content (sliced to lower-case) appear anywhere in the visible context.
*   **Reproduction scenario:** A turn starting with "Okay, let's..." or "I see. Ha..." will pass if the recap or tail contains "okay, le" or "i see. h".
*   **Why broken:** An 8-character rolling prefix is a poor proxy for semantic preservation. It creates false positives for boilerplate and false negatives for facts established later in a turn. This makes the deterministic "taskAccuracy" metric a measure of "accidental prefix collision" rather than strategy quality.

**Finding #2: Dead code in probe execution due to over-strict validation.**
*   **Severity:** MINOR (cosmetic / logic drift)
*   **Location:** `packages/benchmarks/src/runner.ts:274-278` vs `packages/benchmarks/src/fixture.ts:145-149`
*   **What code does:** `runner.ts` has a loop to handle probes where `turnNum > fixture.turns.length`. However, `validateFixture` throws an error if `afterTurn > turnsLen`.
*   **Reproduction scenario:** Author a fixture with 10 turns and a probe at `afterTurn: 11`.
*   **Why broken:** The validation logic prevents the runner's "after-the-end" logic from ever executing. While this protects against range errors, it makes the runner's multi-loop structure redundant and confusing for future developers.

**Finding #3: Drift Measurement uses a "Magic Oracle" baseline.**
*   **Severity:** MAJOR (results misleading)
*   **Location:** `packages/benchmarks/src/runner.ts:285-298`
*   **What code does:** `driftScore` is calculated by comparing `compactCtx` and `offCtx`, both explicitly passing `contextWindowChars: 0`.
*   **Why broken:** Real-world performance (and the LLM judge) is measured under a 1200-character cap. By measuring drift on uncapped context, the harness compares the strategy against a "perfect memory" oracle that the model never actually sees. This can hide semantic drift that only triggers when the cap forces the model to choose between the recap and the tail.

**Finding #4: Asymmetric stress classification (All-or-Nothing Tail rule).**
*   **Severity:** MINOR (results misleading)
*   **Location:** `packages/benchmarks/src/fixture.ts:213-214`
*   **What code does:** If ANY turn listed in `factTurns` is in the preserved tail, the probe is classified as `tail-trivial`.
*   **Why broken:** A probe that requires two facts—one from Turn 5 (compacted) and one from Turn 20 (tail)—will be ignored in strategy-quality reporting. This penalizes strategies for preserving the "hard" fact just because the "easy" fact was also available. It leads to under-reporting of valid strategy stress.

**Finding #5: Hard-coded context window in deterministic evaluator.**
*   **Severity:** MINOR (logic drift)
*   **Location:** `packages/benchmarks/src/runner.ts:156`
*   **What code does:** `evaluateProbe` hardcodes `contextWindowChars: 1200`.
*   **Why broken:** While this matches the `BENCH_CONFIG` in `mini-bench-judge.ts`, it is a literal "magic number" in the runner. If the judge config is changed to test a 4000-char window, the deterministic bench runs will continue to judge based on a 1200-char "view," leading to divergent reports.

---

### SECTION 2 — TRUST VERDICT

| Strategy / Measurement | Status | Justification |
|---|---|---|
| **`off` (Task Accuracy)** | **DISTRUST** | As soon as the cap (1200 chars) fires, the 8-char prefix check will fail for any fact in the head, reporting 0% accuracy even if the model (LLM judge) could have guessed correctly from context. |
| **`reactive` (Recap-only)** | **TRUST** | Logic for building recap + tail is sound and unified. Stress classification correctly identifies facts that MUST be in the recap to be seen. |
| **`reactive-vercel` (Recap)** | **TRUST** | Code correctly handles no-op detection and resets `recapContent` to `""` on no-op or error, ensuring no stale data is judged. |
| **`realtime` (Latencies)** | **TRUST** | Encode is called per-turn, and latencies are recorded individually. |
| **`driftScore` (Aggregate)** | **DISTRUST** | Measured on uncapped context; does not reflect the "pressure" of the 1200-char limit on semantic equivalence. |

---

### SECTION 3 — NEXT REQUIRED WORK

1.  **Refactor Deterministic Accuracy:** Replace the 8-character prefix check with a more robust signal (e.g., check for 3-4 distinct keywords or a longer substantive substring, or simply admit `task-accuracy` is LLM-judge-only).
2.  **Unify Context Cap:** Move the `1200` literal into a shared `bench-config.ts` or `fixture.ts` constant so `runner.ts` and `mini-bench-judge.ts` stay in sync.
3.  **Align Drift Baseline:** Update `runner.ts` to measure `driftScore` using the same `contextWindowChars` (1200) used for probes, or report both "Uncapped Drift" and "Capped Drift."
4.  **Fix Dead Code:** Adjust `validateFixture` to allow `afterTurn = turns.length + 1` or remove the unreachable logic in `runner.ts`.

---

### SECTION 4 — IF YOU WERE THE AUTHOR

*   I would move all "Magic Numbers" (1200 chars, 8-char signal, keepTail=2) into a single `BenchmarkContext` object.
*   I would discard the deterministic `task-accuracy` check entirely; it's a "feel-good" metric that currently measures noise.
*   I would add a "Tail Coverage" metric that reports how much of the `factTurns` was truncated by the provider cap vs. how much was saved by the recap.
*   I would change `classifyProbeStress` to return a "Stress Ratio" (percentage of facts in recap vs. tail) rather than a binary classification.
*   I would implement a "Schema Check" test that ensures every fixture in `src/fixtures` passes `validateFixture` at build time.
*   I would rebuild the `driftScore` to use a small local embedding model (e.g., via a local ONNX runner) instead of Jaccard token overlap, which is too sensitive to phrasing changes in summarization.
*   I would explicitly test the "Empty Recap" behavior to ensure the LLM Judge doesn't hallucinate content when the `[recap]` section is blank.
```
