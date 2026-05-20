# naia-agent vision statement (R4 lock 2026-04-26)

> **Languages**: English (this file) · [한국어](../.users/docs/ko/vision-statement.md)

> **One-liner**: "Real-time interruptible multi-agent supervisor with multi-modal stream + honest reporting."

---

## 1. What naia-agent is

The user (luke)'s **AI assistant + task operator**. In a single conversation window the user issues commands, naia-agent runs multiple sub-agents to carry out real work, and **numeric, honest reporting** maintains trust.

Core use cases (R4 motivation):

| # | User pain point | naia-agent's answer |
|---|---|---|
| 1 | Several terminals + several AI agents in parallel is exhausting | Unified into a single conversation window |
| 2 | Things slip through the cracks (cognitive load) | naia-agent runs sub-sessions + delivers consolidated reports |
| 3 | The report does not match reality (a major failure mode) | Automatic verification (test/lint/build) + numeric diff stats |
| 4 | If something goes wrong, stop immediately | "stop stop" voice / Ctrl+C / card [Stop] |
| 5 | Confirm workspace changes immediately | file watcher + diff preview |
| 6 | See sub-session activity | ACP/SDK event-stream card view |

---

## 2. What naia-agent is NOT

| Not | Delegated to or higher layer |
|---|---|
| A coding tool itself (bash/file/git/refactor) | opencode / claude-code (sub-agent) |
| A 50+ provider LLM aggregator | any-llm remote gateway |
| Its own voice / avatar / UI | naia-shell (separate repo) |
| Its own long-term memory | naia-memory (separate repo) |
| Its own skill catalog | naia-adk (separate repo) |
| IDE / file editor / its own git implementation | Uses the user's existing IDE |
| Agent framework for external users | Starts as single-user (luke) only |

---

## 3. Differentiation (3 axes — rare in other frameworks)

| Axis | naia-agent | claude-code / opencode / Mastra / Vercel AI SDK |
|---|:---:|:---:|
| **Multi-modal stream** (audio_delta as a first-class event) | ★★★ | text only |
| **Sub-agent supervisor** (ACP/SDK + audit + interrupt) | ★★★ | standalone (the supervisee, not the supervisor) |
| **Single conversation + honest reporting** (verification + diff + numbers) | ★★★ | report does not match reality (the hallucination problem unchanged) |

→ a **supervisor runtime for the voice-capable + multi-agent operations era**.

(Note: voice = Slice 3-XR-Voice / P0c-2 — LiveKit + VoxCPM2 cascade at the agent layer, separate-session work. The earlier "omni LLM" plan — vllm-omni / MiniCPM-o-4.5 — is deprecated; see `project_minicpm_o_4_5_deprecated_2026_05_20` memory.)

---

## 4. Core responsibilities (priority lock)

| Priority | Responsibility | Source |
|:---:|---|---|
| ★★★ | Single conversation interface | vision motivation #1 |
| ★★★ | Workspace event stream (file watcher + diff) | motivation #5 |
| ★★★ | Sub-session event stream (ACP/SDK capture) | motivation #6 |
| ★★★ | Automatic verification + honest numeric reporting | motivation #3 |
| ★★★ | Real-time interrupt + pause/resume | motivation #4 |
| ★★★ | Sub-agent supervision (multi-orchestration) | motivation #2 |
| ★★ | Continuous context (naia-memory) | "to be assigned work continuously" |
| ★★ | Multi-modal stream protocol (audio/image forwarding) | voice cascade (Slice 3-XR-Voice / P0c-2) |
| ★★ | Interface definitions (SubAgentAdapter / Verifier / WorkspaceWatcher / LLMClient / MemoryProvider / SkillLoader) | DI |

---

## 4b. Naia (engine) vs alpha (persona instance)

| Layer | Name | Definition |
|---|---|---|
| **Runtime engine** (this repo) | **Naia** | Generic, no persona. Default CLI label "[Naia]" |
| **Persona instance** | **alpha** | luke's personal AI = naia-adk (skill + convention) + naia-memory (user context) combined |

**Principle**: naia-agent does not carry a persona. "alpha" is the instance name and is defined by the following two layers:

1. **naia-adk** — the **skills + processes + base context (persona)** for a naia instance
   - skill standard + skill catalog
   - workflow processes (e.g. review → decide → execute patterns)
   - persona system-prompt conventions (character, Korean default, assistant role, conversational style)
   - all static (independent of user, instance-level definition)
2. **naia-memory** — per-user long-term **memory** (dynamic)
   - prior conversation history
   - user preferences / metadata
   - work history / task context

### Persona-placement trade-off (design-decision record)

**Semantic justification**: a persona (personality, identity) is part of "the memory that makes someone who they are" → it naturally belongs in naia-memory.

**Reality (compatibility with existing systems)**: however, all existing agent systems — Claude / opencode / Vercel AI SDK and the rest — inject the persona via a **system prompt** (static spec). Because naia-agent wraps these as sub-agents, having the persona live in the **system-prompt convention layer = naia-adk** is the realistic and compatible choice.

**Decision**: naia-adk holds the persona (static base) + naia-memory holds the user context (dynamic). The two layers combine to define the "alpha" instance.

→ In Phase 3 the simultaneous injection of both layers is formalized: `TaskSpec.extraSystemPrompt = naia-adk persona base + naia-memory.recall() result`

### 4-repo responsibility split LOCK (2026-04-26, user directive)

| Repo | Responsibility |
|---|---|
| **naia-os** (host) | The full host OS — UI + Avatar + audio device IO (mic/speaker via Tauri Rust cpal) + channel adapters + OS-specific skills (Device/Voicewake/Panel/Channels) |
| **naia-agent** (engine) | LLM core + supervisor + sub-agent. Voice = agent-layer cascade via LiveKit (Slice 3-XR-Voice / P0c-2, deferred to a separate session). |
| **naia-adk** | skill **spec/interface only** + a 9-skill generic catalog (Cron/Memo/Time/Weather/Notify/Diagnostics/Sessions/Skill-manager/Config/SystemStatus). Execution lives in naia-agent. |
| **naia-memory** | memory engine (encode/recall/decay/etc.) |

### Voice / multi-modal (deferred — agent-layer cascade, NOT in-model omni)

Voice support is targeted at the **agent layer** (Slice 3-XR-Voice / P0c-2), not at the LLM level. The earlier "omni model" plan (vllm-omni / MiniCPM-o-4.5 in-model audio I/O) is deprecated (cf `project_minicpm_o_4_5_deprecated_2026_05_20` memory).

Replacement architecture (separate-session work):

- **TTS**: VoxCPM2 served by ko-serve over an OpenAI-compatible endpoint.
- **STT**: Whisper-large-v3 (separate endpoint or LiveKit plugin).
- **Orchestration**: LiveKit Agents framework — STT → LLM (any) → TTS cascade with barge-in / turn-detector. Real-time guarantee at the agent layer, not the model.

Splits naia-os = thin device IO + UI / naia-agent = agent-level audio orchestration.

### naia-* / alpha-* prefix scheme (naming consistency)

**Every engine module uses the `naia-` prefix** (user directive 2026-04-26 — alpha-memory → naia-memory rename):

| Prefix | Meaning | Examples |
|---|---|---|
| **naia-** | Generic engine modules (identical for everyone, npm `@nextain/`) | naia-agent / naia-adk / **naia-memory** / naia-os / naia-shell |
| **(personal prefix)** | **User instance** workspace (host repo) | **alpha-adk** (luke's host repo, persona = "alpha") / `bob-adk` (bob's host) etc. |

Therefore:
- **alpha** = the name of luke's AI **persona / instance**
- **alpha-adk** = luke's workspace root (this repo, host) — stores all data for the alpha instance
- **naia-memory** = the generic memory engine (npm pkg `@nextain/naia-memory`)

### alpha-instance backup scenario (user directive)

**Backing up the `alpha-adk` directory alone fully restores the alpha instance**:

```
alpha-adk/                            # ← backing this up restores all of alpha
├── data/                             # instance data (naia-adk convention)
│   ├── memory/                       # ← naia-memory stores here (user memory)
│   ├── skills/                       # ← user-added skill definitions
│   └── persona/                      # ← persona overrides (Korean tone, address forms, …)
├── projects/                         # ← submodule pointers
│   ├── naia-agent/                   # generic engine
│   ├── naia-adk/                     # generic skill + process + persona convention
│   ├── naia-memory/                  # generic memory engine (pkg name `@nextain/naia-memory`)
│   └── naia-os/                      # generic host shell
├── .agents/                          # workspace context/rules
└── ... (other user areas)
```

→ `git push alpha-adk origin main` (or tar backup) = preserves alpha's **skills + context + memory**.
→ Engine modules (naia-agent / naia-memory, etc.) are generic and can be pulled in anywhere to compose.

### naia-adk-defined memory-storage path convention (formalized in Phase 3)

```
${ADK_ROOT}/data/memory/        # naia-adk convention (relative)
```

When `alpha-adk` acts as host:
- `ADK_ROOT` points at the alpha-adk repo (resolved from env)
- `naia-memory` writes its SQLite / vector store under `${ADK_ROOT}/data/memory/`
- backing up the alpha-adk repo automatically includes the memory data

For another user (`bob-adk`):
- `ADK_ROOT` points at the bob-adk repo → store lives under `bob-adk/data/memory/`
- the same `naia-memory` engine, but isolated data.

This convention is formally wired at the Phase 3 naia-memory integration point.

naia-agent only provides the **hooks for injecting the two layers**:

| Hook | When | Phase |
|---|---|---|
| `NAIA_PERSONA_LABEL` env | Overrides the CLI output label (e.g. "Naia" → "alpha") | **Phase 2 (current)** |
| `TaskSpec.extraSystemPrompt` | Injects the persona / memory into the sub-agent's system prompt | Phase 3 (with naia-memory integration) |
| `MemoryProvider.recall()` | Pulls user context at conversation start → extraSystemPrompt | Phase 3 |

**An example of alpha-adk (this workspace) host injection** (Phase 3):
```bash
export NAIA_PERSONA_LABEL=alpha
# alpha-adk loads the persona spec from naia-adk + combines it with the result of naia-memory.recall() →
# fills TaskSpec.extraSystemPrompt and calls naia-agent
pnpm naia-agent "..."
```

→ With the same naia-agent engine you can spin up different persona instances (alpha / per-user / public Naia / …). naia-agent is a "**persona hosting platform**", not the persona itself.

---

## 5. Locked decisions (R4 summary)

| | Decision |
|---|---|
| Path | Hybrid wrapper (B) — ~2,150 LOC in-house + external wrap |
| LLM | any-llm remote gateway as main; voice = LiveKit cascade (Slice 3-XR-Voice / P0c-2, deferred); Vercel AI SDK on hold |
| Sub-agent | opencode (ACP) + claude-code SDK + a simple stdio fallback |
| Memory | naia-memory peer dep |
| Skill | naia-adk peer dep (future) |
| UI | CLI (Phase 1–3) → integrated into naia-shell (Phase 4+) |

---

## 6. Phase outline

| Phase | Window | Verification |
|---|:---:|---|
| **Phase 1** (freeze 2026-04-21) | Week 1 (5 days) | "Add a hello function" → progress visible + diff + "test PASS" report |
| Phase 2 (largely shipped) | Week 2–3 | ACP integration + interrupt + Approval gate (`ApprovalBroker` / `CliApprovalBroker` / `AutoDenyApprovalBroker` shipped in `bin/naia-agent.ts`; T2/T3 `GatedToolExecutor` wiring still in flight) |
| Phase 3 (partially shipped) | Week 4–6 | claude SDK + sub-session card + naia-memory. `--memory` flag and `LiteMemoryProvider` wiring SHIPPED (Slice 3-XR-C / 3-XR-G / 3-XR-I, 2026-05-20); supervisor-side auto-injection of `TaskSpec.extraSystemPrompt` from `MemoryProvider.recall()` still on the roadmap |
| Phase 4 | Week 7–10 | Adversarial review + naia-shell integration + voice cascade (Slice 3-XR-Voice / P0c-2, deferred to a separate session) |

**Phase 1 goal**: 30–50% reduction in user fatigue. If it does not deliver, fall back to Path A (regress to the IDE) or Path C (stay manual) — only one week of effort lost.

---

## 6b. Security stance (per Phase)

| Phase | path traversal | secret redact | approval gate | dangerous bash |
|---|:---:|:---:|:---:|:---:|
| **Phase 1** | **CLI not yet enforced (intent unrealized)** | ✓ at adapter emit time | ✗ skipPermissions | ✗ |
| Phase 2 | runtime BashSkill + workspace sentinel (D09) | ✓ | ✓ T2/T3 ApprovalBroker | ✓ DANGEROUS_COMMANDS regex (D01) |
| Phase 3+ | + 4-repo plan A.13 security lockstep | + | + | + |

**Phase 1 security assumptions** (user trust model):
- The naia-agent CLI is **launched by the user in person** (no untrusted input source)
- The workdir is **explicitly specified by the user** — path-traversal responsibility = the user
- Prompts handed to the sub-agent (opencode) are **written by the user as well** — prompt-injection risk is low
- Therefore Phase 1 carries only redact + workdir-cwd isolation + UnsupportedError throws (consistent with the C1 functional review)

Do not use Phase 1 in untrusted / multi-tenant environments. The proper security layer starts in Phase 2.

---

## 7. Change procedure

To change this vision after the R4 lock:
1. Add a Change-log section to this file
2. Record the rationale in `r4-hybrid-wrapper-2026-04-26.md`
3. Add a new decision in matrix §D, or a new rejection in §B
4. Comment on master issue #2 + cross-review

§A-adopted items are not subject to change (the R0 lock holds).
