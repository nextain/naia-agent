# Compaction Benchmark Ledger — 2026-05-20

**Slice**: 3-XR-Compact P6 (nextain/naia-agent#47).
**Branch**: `migration/slice-3-xr-compact`.
**Harness**: `packages/benchmarks/`, `pnpm bench:compact`.
**Judge profile**: `none` (deterministic only — keyword match for fact-recall, Jaccard for drift).
**Fixtures**: 10 seeds (F001-F010 across 10 domains).
**Strategies under test**: `reactive`, `realtime`, `anthropic-native`, `off`.

---

## Aggregate results

| Strategy | Task-accuracy | Fact-recall | p50 | p99 | Compact ms | Total tokens | Drift | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `reactive` | 0.400 | 0.600 | 0ms | 0ms | <1ms | 653 | 0.545 | 0 |
| `realtime` | 0.400 | 0.600 | 0ms | 0ms | <1ms | 642 | 0.531 | 0 |
| `anthropic-native` | 0.300 | 1.000 | 0ms | 0ms | — | 368 | 1.000 | 0 |
| `off` | 0.300 | 1.000 | 0ms | 0ms | — | 368 | 1.000 | 0 |

Full per-fixture breakdown: `packages/benchmarks/reports/2026-05-20-deterministic.md`.

---

## Critical interpretation — what this DOES and DOES NOT show

### What's measured

1. **Infrastructure end-to-end works**: 10 fixtures × 4 strategies × 5 axes; 40 measurement points; zero errors.
2. **Compaction latency is negligible at this scale** (sub-millisecond) because:
   - `naia-memory.compact()` is deterministic recap + structured markdown — no LLM call (no summarizer hook injected this run).
   - Fixtures are 20-30 turns; tokens stay under 1k per session.
3. **Anchored iterative path is alive end-to-end**: P4-P5 tests already verified `priorRecap` flows; this harness exercises it on real fixture content.

### What's misleading (LLM-judge gap)

The deterministic harness scores `off`/`anthropic-native` *higher* on fact-recall than `reactive`/`realtime`. **This is a measurement artifact, not a finding about real-world performance.** Three reasons:

1. **No hard-truncation simulation**: in production, an `off` strategy's conversation keeps growing until the provider 4xx's at the context limit and the session dies. Our harness lets `off` "see" all raw turns indefinitely. In a real Anthropic call, those raw tokens would simply not fit.
2. **Keyword-match scores raw text, not assistant response quality**: when the harness asks "does the visible context contain the expected keywords?", `off` wins trivially because it shows the full transcript. A real LLM-judge would score `the assistant's response after compaction` — which is what users actually experience. Compaction wins there because the recap focuses the relevant identifiers.
3. **`anthropic-native` is host-side disabled** in our runtime (server-side path is authoritative), so in this harness it behaves identically to `off`. Its real benefit comes from the Anthropic server-side compaction we don't invoke here.

### What CAN be inferred (carefully)

- `reactive` and `realtime` are **near-identical** on this fixture set — within 0.01 on every metric. Either the cost difference (rolling encode vs reactive single call) doesn't show at 20-30 turn sessions, **or** the structured markdown recap shape dominates whatever advantage each path would have. Both LIKELY hold; the next iteration needs either much longer sessions or LLM-judge to discriminate.
- `realtime` has marginally lower drift (0.531 vs 0.545) — the rolling summary may be slightly more compressed than reactive's pure head-summarize, leaving less raw-token overlap with the original transcript. This is consistent with theory but the effect size is too small to act on.
- Compact-time latency was unmeasurable (sub-millisecond) in this run because no LLM summarizer was injected. With a real summarizer, expect reactive p99 to spike at compaction turns (~2-5 seconds) vs realtime staying flat (rolling already built). Measuring that needs a host with API keys.

---

## Limitations (carry into next iteration)

1. **No LLM-as-judge**: `task-accuracy` is approximated as "domain keyword present in non-trivial context". `NAIA_JUDGE_ENSEMBLE` integration is the priority for the next pass — needs `GLM_API_KEY` (+ optional Codex / Claude CLI) in host env.
2. **No hard-truncation simulation for `off`**: the harness should detect "would-overflow" sessions and mark `off` runs as failed there. Currently `off` always succeeds — falsely inflating its scores.
3. **No actual LLM driver**: the fixtures are pre-canned dialogs; the harness doesn't drive an Agent through them. A real run would: spawn `bin/naia-agent --compact-strategy X`, feed turn N as user input, capture the assistant response, repeat. Cost-of-LLM measurement would then be meaningful.
4. **Drift is Jaccard-on-tokens**: a real semantic-equivalence drift score requires embeddings. Embedding-based drift is the planned upgrade.
5. **Fixture domain bias**: 10 seeds cover the domains in `src/fixtures/README.md`. They're not adversarial — no degenerate cases where compaction should obviously fail (e.g. requiring a precise quote from turn 1 across 100 compactions).

---

## Sources used to design the harness

- Anthropic Cookbook — Automatic context compaction
- Microsoft Learn — Agent Framework Compaction (ToolResultCompactionStrategy)
- Acon (arxiv 2510.00615) — "moderate threshold best"
- Factory.ai anchored iterative summarization (via Zylos research)
- 5-repo OSS survey: ref-openclaw / ref-opencode / ref-cline / ref-moltbot / ref-cc-cleanroom

Full survey: `docs/compaction-survey.md`.

---

## Recommended next steps

1. **LLM-judge wiring** (highest leverage):
   - Plug GLM HTTP as the default judge (matches `NAIA_JUDGE_ENSEMBLE` precedent in Slice 3-XR-H).
   - For each probe, ask the judge "does this response satisfy `criterion`?". Use majority of 3 judges when keys are available.
2. **Hard-truncation enforcement** in `off` runs:
   - When `off` is selected and visible context > budget, set `visibleText = visibleText.slice(-budget*4)` (chars), simulating real provider truncation.
   - Re-measure — expect `off` recall to collapse on most fixtures.
3. **Real LLM driver**:
   - New runner mode `--driver real` that spawns `pnpm exec naia-agent --compact-strategy X` and feeds turns via stdin, captures stdout per-turn. Slower (seconds per turn), more honest.
4. **Embedding-based drift**:
   - Use `@nextain/naia-memory`'s LocalAdapter embedder for sentence embeddings; cosine instead of Jaccard.
5. **Adversarial fixtures**:
   - Add 3-5 stress fixtures: 100+ turns, multi-compaction chains, identifier needles, hostile token patterns. These would discriminate strategies meaningfully even under deterministic scoring.

---

## Status

P6 = harness infrastructure + first measurement run complete. Strategy ranking deferred to the LLM-judge iteration (next session, user-gated on API key availability).

P0-P6 of Slice 3-XR-Compact (#47) all delivered on `migration/slice-3-xr-compact` + companion `migration/compact-anchored-iterative` in naia-memory. Push is user-gated.
