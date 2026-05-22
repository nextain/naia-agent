# ADVERSARIAL REVIEW — Slice 3-XR-Compact v2 / Phase 1.3 (#56) R1 measurement

You are an **adversarial reviewer**. This is **not** a polite "looks good"
review. Your job is to find every way our measurement is **unfair, biased,
misleading, or invalid**. Be specific, cite line numbers, propose attacks.

If you can describe an attacker scenario where the same code/data produces
the opposite verdict, that's the kind of feedback we need. **Don't be
gentle — the goal is to harden the measurement until you cannot break it.**

## Context

We integrated Vercel AI SDK `pruneMessages` into naia-agent's Agent.sendStream
in Phase 1.2 (commit `60dc9e7`, branch `migration/slice-compact-v2`). Phase
1.3 measures four host-side compaction strategies head-to-head on five
Korean LongMemEval-style fixtures, using a 4-judge LLM ensemble.

### Strategies under test

| Strategy | Body |
|---|---|
| `reactive` | naia-memory `compact()` → 5-section markdown summarization |
| `reactive-vercel` (**NEW**) | Vercel SDK `pruneMessages` cookbook recipe — strips reasoning blocks + older tool_calls |
| `realtime` | per-turn encode + recap via naia-memory rolling summary |
| `anthropic-native` | host-side disabled (server-side compaction would handle it) |
| `off` | no compaction |

### Fixtures (all Korean plain-text)

- `F-KR-IE-01-information-extraction` (32 turns, 1 task probe)
- `F-KR-MS-01-multi-session` (~30 turns)
- `F-KR-TR-01-temporal-reasoning`
- `F-KR-KU-01-knowledge-update`
- `F-KR-AB-01-abstention`

### Judges

GLM HTTP + opencode CLI + codex CLI + gemini CLI (4-judge ensemble,
majority-of-valid verdict).

### Results (R1 — 5 fixtures × 5 strategies × 1 probe × 4 judges)

| Fixture | reactive | reactive-vercel | realtime | anthropic-native | off |
|---|---:|---:|---:|---:|---:|
| F-KR-IE-01-information-extraction | 0.000 | 0.000 | 0.000 | 1.000 | 1.000 |
| F-KR-MS-01-multi-session | 0.000 | 0.000 | 0.000 | 1.000 | 1.000 |
| F-KR-TR-01-temporal-reasoning | 0.000 | 0.000 | 0.000 | 1.000 | 1.000 |
| F-KR-KU-01-knowledge-update | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| F-KR-AB-01-abstention | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| **Mean** | **0.400** | **0.400** | **0.400** | **1.000** | **1.000** |

**Observation that smells wrong**: `reactive`, `reactive-vercel`, and
`realtime` produce **byte-identical PASS rates** across all 5 fixtures.
Either these three strategies are genuinely equivalent on Korean
plain-text histories (unlikely — pruneMessages and 5-section markdown
recap are structurally different outputs), OR our measurement harness
cannot distinguish them.

## Known suspicions WE want you to push on harder

We've already identified several gaps but want adversarial confirmation
they're real (not us hand-waving) and discovery of additional ones:

### S1 — `extractVisibleContext()` in `mini-bench-judge.ts` does NOT use real recap

`packages/benchmarks/scripts/mini-bench-judge.ts:68-95` heuristically slices
fixture turns to build the "post-compaction visible window" shown to
judges. It **does not** reach into `runner.ts`'s actual `recapContent`.

Consequence: judges evaluating `reactive` vs `reactive-vercel` see
identical sliced-fixture text. The verdicts above either understate or
overstate strategy differences — we can't tell which without fixing this.

**Adversarial question**: Given two strategies that produce structurally
different recaps (5-section markdown vs pruned message list), but the
benchmark feeds judges the same sliced tail, what does that say about the
PASS/FAIL columns? Can the headline numbers be trusted at all?

### S2 — All Korean fixtures are plain-text → Vercel path is effectively no-op

The cookbook prune recipe (`reasoning: "all"`, `toolCalls: "before-last-3-messages"`,
`emptyMessages: "remove"`) only removes content that doesn't exist in our
fixtures. Phase 1.2 R2 added a no-op rejection guard
(`packages/runtime/src/compaction/vercel-prepare-step.ts:445-460`): if
neither message-count nor char-count shrinks, return `undefined`. With
plain text, this returns `undefined` every time → `recapContent` stays
empty → `reactive-vercel` is **structurally identical to `off`** for these
fixtures.

**Adversarial question**: Does that make this comparison meaningless?
Should we report "Vercel applicable: 0/5 fixtures" rather than a PASS
rate? What fixture shape would make this an honest measurement?

### S3 — N = 1 probe per fixture per strategy

Each fixture has 1 `task-accuracy` probe. Run × strategy × probe = 1 sample
per cell. Variance unknown, statistical significance impossible.

### S4 — No external baseline comparison

The plan promised head-to-head with **OMEGA / Memoria / RetainDB** numbers
on LongMemEval-S (English, 500 questions). We measured Korean adaptations
of LongMemEval *abilities* on **5 fixtures**. We don't share any prompt or
data with the published baselines, so direct numerical comparison is
indefensible.

### S5 — Deterministic vs LLM-judge disagreement

`evaluateProbe()` in `runner.ts:139-199` uses a coarse heuristic for
`task-accuracy` (visible len > 200 AND domain anchor keyword present →
PASS). Result: `Deterministic task = 0.000` across the board for F-KR-IE,
while LLM ensemble varies. Which signal do we trust? They disagree at
the categorical level.

### S6 — `priorRecap` thread

Only `reactive` / `realtime` accumulate `priorRecap` across compaction
points (`runner.ts:269`). `reactive-vercel` does not — each prune is
independent. Is that a bug or an intentional disadvantage?

### S7 — Judge selection bias

GLM is HTTP, the other three are CLI subprocesses. Different latency
profiles, different tokenizer behaviors, different reasoning depth.
Treating them as one "ensemble" with majority vote weights GLM's
distinct failure modes equal to e.g. codex's.

## Your task

For each of S1–S7, give a hostile verdict (real / fake / overrated /
understated) AND propose the cheapest concrete fix that breaks the
weakness. Add S8+ for any flaw we missed.

Format your response as:

```
S1: <REAL | FAKE | OVERRATED | UNDERSTATED>
  Why: <one paragraph>
  Fix: <one or two sentences, concrete file paths/line numbers>

S2: ...
...

S8: <new flaw we missed>
  Why: ...
  Fix: ...
```

End with a final verdict on **whether the headline numbers are
publishable** or **whether the entire R1 measurement should be considered
preliminary and not cited**. Be harsh — measurement integrity matters more
than us looking good.

Code paths to inspect:
- `packages/benchmarks/scripts/mini-bench-judge.ts`
- `packages/benchmarks/src/runner.ts`
- `packages/benchmarks/src/fixtures/F-KR-*.fixture.json`
- `packages/runtime/src/compaction/vercel-prepare-step.ts` (no-op guard)

Commits: `4b585df` (R1 wire), `60dc9e7` (R2 guards), `ec6e511` (review docs).
