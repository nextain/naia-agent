# Compaction Survey — naia-agent Slice 3-XR-Compact

> **Languages**: English / Korean mixed (canonical for this slice; mirror to `.users/docs/ko/` at slice close)

This document is the canonical external-evidence record for the
triple-strategy compaction design in [#47](https://github.com/nextain/naia-agent/issues/47).
It consolidates patterns from production OSS agent runtimes, Anthropic's
official guidance, Microsoft's Agent Framework, and recent academic
literature, then maps each finding onto naia-agent's three-way strategy
choice (`reactive` / `realtime` / `anthropic-native`).

## 1. Why compaction at all

A conversational / agentic LLM runtime accumulates context faster than
any practical context window — tool calls, file reads, persona riders,
memory recall blocks all add up. Three failure modes if compaction is
absent:

1. **Hard truncation by provider** — the model 4xx's the request, the
   user's session dies.
2. **Quality degradation near the budget** — every modern LLM scores
   worse as it approaches its window limit ("context rot").
3. **Cost explosion** — every turn re-sends the full transcript.

Compaction is the standard mitigation: at some threshold, summarize
the head of the conversation into one compact recap message, keep the
tail verbatim, and continue the session.

## 2. Anthropic's official position

### 2.1 Cookbook — client-side compaction (SDK level)

Source: [Anthropic Cookbook — Automatic context compaction](https://platform.claude.com/cookbook/tool-use-automatic-context-compaction).

| Aspect | Value |
|---|---|
| Trigger | `context_token_threshold` — default **100k tokens** (~50% of a 200k window) |
| Recap role | `user` message wrapping `<summary>...</summary>` |
| Recap shape | Free-form markdown the model generates itself when prompted to summarize progress (no fixed schema) |
| Tool_use/tool_result | **Discarded** in summary — only the textual outcome survives. Tool calling can resume after compaction |
| Tail preservation | Implicit (only the user's new turn after compaction) |
| Failure handling | None defined at SDK level — caller handles |

**Official guidance** (verbatim, paraphrased):

- *"Manual at 60% > auto at 95%"* — earlier compaction produces higher-quality summaries because there is less to compress.
- *Avoid compaction for*: short tasks (< 50k tokens), tasks requiring full audit trails, server-side sampling workflows, "highly iterative refinement where each step critically depends on exact details from all previous steps".

### 2.2 Beta API — `compact-2026-01-12`

Anthropic ships a server-side compaction beta via the API header
`compact-2026-01-12` and the `compact_20260112` strategy on
`context_management.edits`. Opus 4.6+ does this automatically; older
models require explicit opt-in.

**Limitations** (cookbook):

- Server-side sampling loops (web search, server-side extended thinking)
  do not work optimally — cache tokens accumulate and trigger compaction
  prematurely.
- Summaries inherently lose some information.

## 3. Production OSS patterns (5 ref repos)

Surveyed: `ref-openclaw`, `ref-opencode`, `ref-cline`, `ref-moltbot`,
`ref-cc-cleanroom`. ref-cc-cleanroom is "All rights reserved"
(ghuntley) — patterns described structurally only, no verbatim quotes.

### 3.1 Universal patterns (all five)

1. **Dual trigger**: reactive overflow detection + manual `/compact` + preemptive token-reserve check (default reserve ~16k).
2. **Structured recap markdown** with fixed sections. opencode example:
   ```
   ## Goal
   ## Instructions
   ## Discoveries
   ## Accomplished
   ## Relevant files / directories
   ```
   openclaw expands this with `## Constraints & Preferences`,
   `## Progress (Done/InProgress/Blocked)`, `## Key Decisions`,
   `## Next Steps`, `## Critical Context`, plus
   `<read-files>` / `<modified-files>` XML markers tracking cumulative
   file operations.
3. **Tail preservation**: `tail_turns=2` (default) + `preserveRecentTokens` ~25% of usable context (min 2k, max 8k).
4. **Identifier strict-preserve**: UUIDs, URLs, file paths preserved verbatim — never paraphrased.
5. **Chunked fallback**: if the summarization LLM call fails or the head is too large to fit in a single summarize call, split into chunks, summarize each, merge.
6. **Continuity event + synthetic continue**: publish `Event.Compacted` for subscribers; inject a synthetic user message with `metadata: {compaction_continue: true}` if auto-triggered (so the model knows the previous N turns are now compressed).

### 3.2 Multi-repo winners (3/5+)

- **Split-turn logic** (openclaw, pi): if a single turn exceeds the tail budget, cut mid-turn and summarize the turn prefix separately, then merge — prevents dropping partial work mid-exchange.
- **Transcript rotation** (opencode): post-compaction, create a successor transcript file = `[summary, ...tail]`, archive the old transcript. Keeps active JSONL from bloating, enables checkpoint recovery.
- **Model fallback chain** (openclaw): if the compaction LLM fails, retry with the next model in a config-driven chain.
- **PreCompact hook interception** (cline): a `precompact` hook can cancel, inspect, or modify context before summarization runs.

### 3.3 Domain-specific (1-repo)

- **ref-pi**: branch-summarization on `tree` navigation. Multi-branch coding only.
- **ref-openclaw**: explicit "you are the LEADER" model-handoff directive when one model's quota runs out. Multi-hop agent only.
- **ref-opencode**: tool-result pruning as a lightweight pre-step before full compaction. High-churn tool environments.

## 4. Microsoft Agent Framework — `ToolResultCompactionStrategy`

Source: [Microsoft Learn — Compaction](https://learn.microsoft.com/en-us/agent-framework/agents/conversations/compaction).

Microsoft's `ToolResultCompactionStrategy` collapses all-but-newest
tool-call groups, with a default prompt preserving key facts,
decisions, user preferences, and tool-call outcomes. **Key innovation**:
if a `ToolMessage` exceeds 2,000 tokens, it is written to disk and
replaced in-context with a `path` reference + 10-line preview.

This is more nuanced than Anthropic's discard-all-tool-results and
opencode's prune-only-the-largest. It's the pattern naia-agent adopts.

## 5. Academic literature

| Paper | Pattern | Bearing on naia-agent |
|---|---|---|
| **MemGPT** ([arxiv 2310.08560](https://arxiv.org/pdf/2310.08560)) | Hierarchical virtual context (main + external pages, page-fault recall like an OS) | Out of scope for this slice — would require external page store + paging tool. **Deferred** to a hypothetical "MemGPT-light" follow-up slice. |
| **Recursive summarization** ([arxiv 2308.15022](https://arxiv.org/html/2308.15022v3)) | Recursive accumulating summary | Academic origin of the (B) realtime rolling-summary idea. |
| **Mem0** ([arxiv 2504.19413](https://arxiv.org/html/2504.19413v1)) | LLM-driven fact extraction + scalable recall | Already adopted by naia-memory at the R2.5 layer (separate from compaction). |
| **Proactive Memory Extraction** ([arxiv 2601.04463](https://arxiv.org/pdf/2601.04463)) | Dynamic extraction beyond static summary | Future direction for (B); not implemented this slice. |
| **Acon — Optimizing Context Compression for Long-horizon LLM Agents** ([arxiv 2510.00615](https://arxiv.org/html/2510.00615v1)) | Empirical threshold tuning: "smaller=freq+accuracy↓, larger=cost↑, **moderate best**" — 4096 history / 1024 observation in their setup | Direct evidence for our 75% default threshold (between Anthropic 60% and OSS 80-95%). |
| **Active Context Compression** ([arxiv 2601.07190](https://arxiv.org/pdf/2601.07190)) | Agent itself calls a compress tool at natural task boundaries | Out of scope — naia-agent does NOT expose `compact_context` as a model-callable tool this slice. |
| **Factory.ai anchored iterative summarization** (via [Zylos research](https://zylos.ai/research/2026-02-28-ai-agent-context-compression-strategies)) | Merging new summaries into a persistent state outperforms full-reconstruction at every metric (accuracy / completeness / continuity) | **Decisive** — both our (A') reactive and (B) realtime must be *anchored iterative*, not naive head-summarize. Prior recap → seed for new recap. |
| **LongMemEval** | Long-term memory benchmark | Fixture format reference for our `packages/benchmarks/fixtures/`. License audit pending. |

## 6. naia-agent's three-way mapping

### 6.1 Strategy A' — `reactive` (default)

Adopts **opencode 5-section recap + openclaw chunked fallback + Microsoft tool-result pattern + Factory.ai anchored iterative**.

- Trigger: 75% of model context window OR provider raises context-length error.
- Recap shape: opencode 5-section markdown (`## Goal / ## Instructions / ## Discoveries / ## Accomplished / ## Relevant files`). System-role injection.
- **Anchored iterative**: first compaction summarizes head from scratch; subsequent compactions take the previous recap as the seed and merge new head messages into it. Prior recap is NEVER re-summarized from raw — it is preserved verbatim as the anchor.
- Tail: `tail_turns=2` + `preserveRecentTokens=2000`.
- Tool_use/tool_result: Microsoft pattern — `tool_result` > 2k tokens → disk write + path + 10-line preview. Smaller tool_results preserved inline. tool_use IDs always preserved so subsequent re-references work. Recap body includes a `## Tool calls made` mini-section listing tool names + targets.
- Identifier strict-preserve (UUIDs, URLs, file paths).
- Failure: LLM summarizer fails → chunked fallback (head split into N, summarize each, merge). Two consecutive failures → naia-memory deterministic v0 recap. Three failures → emit error event, refuse to continue (caller decides).
- Continuity: `EmitCompactionEvent({type:'reactive', droppedCount, recapTokens, tookMs, anchored:boolean})`.

### 6.2 Strategy B — `realtime`

Activates naia-memory's v2 rolling-summary fast path.

- Trigger: same 75% threshold.
- Recap shape: rolling deterministic accumulation every `encode()` (no LLM call). At `compact()` time, ONE LLM polish call reformats the rolling seed into the 5-section markdown. **Per-turn LLM polish is OFF by default** (Factory.ai: anchored iterative beats per-turn polish at fraction of cost). Opt-in via `compaction.realtimePolish=true`.
- Tail: same.
- Tool_use/tool_result: same Microsoft pattern.
- Failure: rolling seed missing → auto-fallback to (A') reactive path.
- Continuity: `EmitCompactionEvent({type:'realtime', realtime:true, tookMs})`.

### 6.3 Strategy A'' — `anthropic-native`

Passthrough to Anthropic's `context_management.edits` with the
`compact-2026-01-12` beta header. Opus 4.6+ does this automatically.

- Trigger: Anthropic-side decision.
- Recap shape: model's own `<summary>` tag content.
- Tail: cookbook defaults.
- Failure: Anthropic-side.
- **Uppermost**: if backend = `anthropic` AND model ≥ `claude-opus-4-6`, anthropic-native auto-activates and our host-side `(A')`/`(B)` strategies are warn-logged + automatically disabled. Override via `compaction.anthropicNativeOverride=false`.
- Continuity: usage response surfaces compaction events; we re-emit them as `EmitCompactionEvent({type:'anthropic-native'})`.

## 7. Open limitations (carried into measurement)

1. **Server-side sampling-loop incompatibility** — Anthropic-documented limitation. We mirror it: when tools like web-search are heavily used, all three strategies may show cache-token accumulation. Measured by P6 fixture `F010-websearch-heavy`.
2. **Single-tier rolling vs MemGPT hierarchical** — our (B) is single-tier rolling. Hierarchical (MemGPT) is academically superior but a separate slice.
3. **Fixture domain coverage** — 10 seed fixtures cannot match LongMemEval's domain breadth. P6 ledger explicitly bounds claims.

## 8. Naming & cross-reference

- This document is referenced by `nextain/naia-agent#47` (Slice 3-XR-Compact).
- naia-memory's `MemorySystem.compact()` (v0/v1/v2) is the **implementation** of (A') and (B). Wire-up happens in `packages/runtime/src/compaction-strategy.ts` (P2).
- naia-os's `agent/src/index.ts` `checkTokenBudget` warn-only loop will be wired to this strategy in a follow-up slice gated on [nextain/naia-os#185](https://github.com/nextain/naia-os/issues/185) Phase 2.

## 9. Sources

- [Anthropic Cookbook — Automatic context compaction](https://platform.claude.com/cookbook/tool-use-automatic-context-compaction)
- [Anthropic Docs — Compaction (beta)](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Microsoft Learn — Agent Framework Compaction](https://learn.microsoft.com/en-us/agent-framework/agents/conversations/compaction)
- [Acon — Optimizing Context Compression for Long-horizon LLM Agents](https://arxiv.org/html/2510.00615v1)
- [Zylos research — anchored iterative summarization](https://zylos.ai/research/2026-02-28-ai-agent-context-compression-strategies)
- [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/pdf/2310.08560)
- [Recursively Summarizing Enables Long-Term Dialogue Memory](https://arxiv.org/html/2308.15022v3)
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/html/2504.19413v1)
- [Active Context Compression: Autonomous Memory Management in LLM Agents](https://arxiv.org/pdf/2601.07190)
- [Beyond Static Summarization: Proactive Memory Extraction for LLM Agents](https://arxiv.org/pdf/2601.04463)
- [Claude Code auto-compact mechanics](https://claudelog.com/faqs/what-is-claude-code-auto-compact/)
- 5-repo internal survey: ref-openclaw / ref-opencode / ref-cline / ref-moltbot / ref-cc-cleanroom (structural only)
