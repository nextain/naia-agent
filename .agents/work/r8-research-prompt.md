# Research — Conversation Compaction Benchmarks + Production-grade Open-Source Implementations

## What I need

I'm building an AI agent's conversation/context compaction system.
**Please research and report**:

### 1. Official / academic benchmarks for conversation compaction

What public, well-known benchmarks exist for measuring conversation
context compaction quality? Examples I know of (please add more):

- **LongMemEval** / LongMemEval-S (HuggingFace dataset, 500 questions × ~115K tokens)
- **LoCoMo** (Long Conversation Memory benchmark, J-score)
- **Mem0 benchmarks** (token-efficient memory)

For each benchmark you list:
- What does it measure? (recall accuracy, abstention, multi-session, etc)
- Published baselines / leaderboard (model name + score)
- Data download URL or HF dataset name
- Whether the **measurement harness is open-source** (so we can run it on our system)

### 2. Production-grade open-source compaction implementations

What real, production-grade open-source compaction implementations
exist that score well on the above benchmarks (or are widely adopted)?

For each implementation:
- Project name + URL
- Compaction approach (LLM-based summarization / pruning / fact extraction / etc)
- License (need permissive for adoption)
- Real-time vs after-the-fact (does it block the user while compacting?)
- Linked to which benchmark scores

Specific projects I want analyzed (please add more):

- **opencode** (`session/compaction.ts` — Effect-based)
- **openclaw** (`agents/compaction.ts` — identifier preserve / retry / token sanitize)
- **Anthropic Cookbook** (`compact_20260112` server-side beta)
- **Vercel AI SDK** (`pruneMessages` cookbook recipe — prune only, no LLM)
- **LangChain `ConversationSummaryMemory`**
- **LangChain `ConversationSummaryBufferMemory`**
- **Mastra working memory** (`@mastra/memory`)
- **Mem0** (fact extraction)
- **MemGPT / Letta** (hierarchical paging)
- **Claude Code `/compact`** (client-side user-initiated)
- **OpenAI Assistants API** memory handling
- **Anyone else relevant**?

### 3. Sort by quality

Among the LLM-based ones (Vercel cookbook prune is NOT one — it
doesn't actually compact, it just removes reasoning/tool blocks),
which is the **best for typical chat / agent conversations** in terms
of:

- **Fact preservation** (after compaction, can the agent still answer
  questions about facts established before the compaction?)
- **User experience** (does the compaction block the user? "wait
  while we compact" UX vs continuous flow)
- **Korean / multilingual support** (we serve Korean users — many
  English-centric algorithms fail on Korean text)
- **License compatibility with Apache-2.0** (our project)

### 4. Anti-pattern I want to avoid

I don't want **after-the-fact "stop the user, run a big LLM summarization,
resume"** because:
- User has to wait
- Big summarization often drops important facts (we've seen this)
- Korean text token-inefficient → budget hit faster → more frequent
  compaction → more frequent waits & more frequent fact loss

What patterns mitigate this? (continuous / per-turn compaction? fact
extraction that runs in background? working memory tool calls?)

### Deliverable

Markdown with sections matching #1-4 above. Cite URLs / paper titles
where you can. If a benchmark or project I named doesn't exist or
I'm confused about it, say so directly.

Be skeptical — if a project's README claims SOTA but you have no
evidence beyond their own claim, mark it that way.

Do NOT be polite or pad — concrete facts only. No "this is a great
question" preamble.
