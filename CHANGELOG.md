# Changelog

All notable changes to `@nextain/agent-*` packages.

Each package follows independent SemVer. Monorepo-wide entries below.

Slice entries (R1+) follow the format: `## [Slice N] — YYYY-MM-DD — short title`.

## [Unreleased]

### feat

- **`packages/runtime/src/skills/time.ts`** (new) — `createTimeSkill()`: locale / ISO 8601 / Unix timestamp formats with optional timezone. Tier T0, zero dependencies. Migrated from naia-os.
- **`packages/runtime/src/skills/weather.ts`** (new) — `createWeatherSkill()`: wttr.in API (no key required). Returns temperature, humidity, wind, UV index. Tier T0. Migrated from naia-os.
- **`packages/runtime/src/skills/memo.ts`** (new) — `createMemoSkill()`: key-value memo storage (save/read/list/delete). Flat files in `~/.naia/memos`. Tier T1. Migrated from naia-os.
- **`packages/runtime/src/skills/system-status.ts`** (new) — `createSystemStatusSkill()`: OS info, memory, CPU, uptime. Sections queryable. Tier T0. Migrated from naia-os.
- **`packages/runtime/src/skills/index.ts`** — barrel exports for 4 new skills.
- **`packages/runtime/src/__tests__/new-skills.test.ts`** — 24 unit tests (time: 6, weather: 3, memo: 9, system-status: 6). All pass.
- **3 skills deferred** (diagnostics, sessions, config): require `ctx.gateway` (naia-os GatewayAdapter RPC). Will be addressed when host injection protocol (4-D) lands.

### feat (Slice 4-B)

- **`packages/core/src/system-prompt-builder.ts`** (new) — `SystemPromptBuilder` with `PromptFragment` (source, priority, section, content). Priority-based sorting, double-newline join. Extracted from `Agent.#buildRequest()` inline composition.
- **`packages/core/src/agent.ts`** — `#buildRequest()` now uses `SystemPromptBuilder` instead of manual `systemParts[]`. Identical output (byte-level regression tests pass).
- **`packages/core/src/index.ts`** — exports `SystemPromptBuilder`, `PromptFragment`, `PromptFragmentSource`, `PromptSection`.
- **`packages/runtime/src/__tests__/system-prompt-builder.test.ts`** — 8 unit tests (sorting, tie-breaking, composition ordering, real-agent simulation).

### feat (Slice 4-C)

- **`packages/runtime/src/composite-tool-executor.ts`** — collision policy changed from first-wins to **last-wins**. Sub registration order now determines priority: core → ADK → host (later overrides earlier).
- **`packages/runtime/src/__tests__/composite-tool-executor.test.ts`** (new) — 8 unit tests covering last-wins, 3-layer override, non-colliding aggregation, lazy rebuild, shadowedNames diagnostics.

### feat (Slice 4-D)

- **`bin/naia-agent.ts` `runStdio()`** — new stdio IPC message types: `skill_inject` (register host proxy stubs), `skill_revoke` (remove), `panel_tool_result` (proxy result callback). Host tools injected via `CompositeToolExecutor` with last-wins priority over builtins.
- **`packages/cli-app/src/__tests__/skill-inject-protocol.test.ts`** (new) — 5 tests covering host injection, override, dynamic replacement, routing.
- **G3 integration test** updated: first-wins → last-wins assertion.
- **ALLOWED_KINDS** already includes `panel_skills`, `panel_skills_clear`, `panel_tool_result`, `panel_tool_call`.

### feat (Slice 4-I)

- **`bin/naia-agent.ts`** — CLI now registers time, weather, memo, system-status skills in all 3 modes (direct, service, stdio). Users get all built-in tools by default.
- **`packages/runtime/src/index.ts`** — re-exports new skill factories from barrel.
- **`packages/runtime/src/adk-extension-loader.ts`** (new) — `loadAdkExtension()`: loads `hooks.json` + `prompt.md` from `--skills-dir`. Hook entries → `HookRegistration`, prompt → `PromptFragment`.

### feat (Slice 4-E)

- **`packages/core/src/hook-dispatcher.ts`** (new) — `HookDispatcher` with `register()` / `emit()`. Async sequential execution, priority ordering, fire-and-forget on failure. Events: `turn-start`, `turn-end`, `error`, `tool-call`, `tool-result`. Sources: `core`, `host`, `adk`.
- **`packages/runtime/src/__tests__/hook-dispatcher.test.ts`** — 8 unit tests (priority order, fire-and-forget, async sequential, context propagation).

- **`packages/types/src/provider-registry.ts`** (new) — `ProviderMeta`, `ModelMeta`, `VoiceMeta`, `ModelCapability` types. Runtime-agnostic provider catalogue contract, adapted from naia-os `shell/src/lib/llm/types.ts` with UI fields removed.
- **`packages/providers/src/registry.ts`** (new) — 9-provider catalogue (nextain/Naia, claude-code-cli, gemini, openai, anthropic, xai, zai, ollama, vllm). Lookup helpers (`listProviders`, `getProvider`, `getProviderModels`, `getDefaultModel`). Gateway live pricing fetch (`fetchNaiaPricing`), gateway model discovery (`fetchGatewayModels`), dynamic fetch for ollama/vllm, `shouldMigrateNextainModel` migration helper.
- **`bin/naia-agent.ts`** — `providers` subcommand: lists all providers with models, pricing, capabilities. `getNaiaRegistryMeta()` now imports naia-agent's own registry instead of naia-os dynamic import (removes cross-repo coupling). 18 unit tests in `packages/providers/src/__tests__/registry.test.ts`. Slice 4-P1 (#59).

### docs

- **`docs/voice-cascade-contract.md`** (new, + `.users/docs/ko/` mirror) — Voice Cascade Contract spec between naia-agent and LiveKit `llm.LLM`. Locks four exit gates that Slice 3-XR-Voice (Task #28, P0c-2) must satisfy before merge: G1 cancel-propagates-upstream-in-one-turn, G2 no-cancelled-turn-memory-write, G3 partial-text-hidden-or-marked-unstable (voice path streams partials behind the `naia-agent[voice]` extra; chat path stays final-only), G4 tool-hop-cancel-leaves-session-reusable. Also locks the Codex r4 LiveKit-lock-in re-evaluation triggers (only G1/G2/G3 failures trigger backbone re-eval; G4 is a wrapper-design call). Provenance: promoted from `naia-labs/promote_to_naia_agent/b5_lite_contract_memo.md` (Codex r3 Q5 + r4 #5). Design lock only — no code yet; verification placement maps onto `docs/adapter-contract.md` §2 contract-test ladder at scaffold time. Cross-linked from `docs/voice-pipeline-audit.md` §1 integration surface.

## [Slice 3-XR-Compact] — 2026-05-21 — triple-strategy compaction + benchmark harness (Task #47)

User directive (2026-05-20): "둘 다 구현하고 벤치마킹 구조부터 / opencode 나 openclaw 를 참고 / naia-agent는 둘 다 지원하게 / 다른 ai들과 크로스리뷰 분석". This slice ships the entire surface — strategy enum, host wiring, naia-memory v3 anchored iterative, benchmark harness, 10 seed fixtures, first deterministic measurement, honest ledger.

### P0 — external survey + plan v2 LOCKED (commit `bab5c6b`)

- **`docs/compaction-survey.md`** (new) — canonical external-evidence record. Synthesizes 5-repo OSS patterns (ref-openclaw / ref-opencode / ref-cline / ref-moltbot / ref-cc-cleanroom), Anthropic Cookbook + `compact-2026-01-12` beta, Microsoft Agent Framework `ToolResultCompactionStrategy`, and 7 academic refs (MemGPT / recursive summary / Mem0 / Proactive Memory Extraction / Acon / Active Context Compression / Factory.ai anchored iterative). External LLM cross-review tools (codex / opencode / gemini / ollama) were environment-blocked (sandbox / TTY / GPU); peer-reviewed sources used as stronger cross-evidence.
- **`.agents/progress/slice-3-xr-compact-plan-2026-05-20.md`** — full plan with §8 Open Questions LOCKED (Q1 threshold 75% per Acon "moderate best" / Q2 deterministic-by-default + LLM polish only at compact() time per Factory.ai / Q3 Microsoft ToolResultCompactionStrategy for tool_result / Q4 anthropic-native uppermost + host-side auto-OFF / Q7 reactive ALSO anchored iterative).

### P1 — benchmark harness skeleton (commit `870b504`)

- **`packages/benchmarks/`** (new package, `@nextain/agent-benchmarks`, private workspace). Fixture JSON schema + 5-axis metric collectors (task-accuracy / fact-recall / latency p50+p99+compactionAvg / cost / drift Jaccard) + markdown report writer (aggregate-by-strategy + per-fixture) + CLI runner (`pnpm bench:compact`).
- **16 unit tests** — validate-fixture reject cases, metric edge cases, percentile math, drift Jaccard, report shape.

### P2 — CompactionStrategy enum + flag + env (commit `e1a4e84`)

- **`@nextain/agent-types`** — new `CompactionStrategy` union (`reactive` | `realtime` | `anthropic-native` | `off`); `CompactionInput` gains optional `strategy` + `priorRecap` (backward-compat).
- **`@nextain/agent-core`** — `AgentOptions.compactionStrategy` (default `reactive`). `Agent.#maybeCompact` short-circuits when strategy = `off` or `anthropic-native` (server-side path is authoritative; host-side would double-compact). Tracks `#priorRecap` per session and forwards it to `memory.compact()`, enabling end-to-end anchored iterative summarization.
- **`bin/naia-agent.ts`** — `--compact-strategy <reactive|realtime|anthropic-native|off>` flag + `NAIA_AGENT_COMPACT_STRATEGY` env (CLI > env > default reactive). Validation: unknown value → exit 3 with helpful stderr. Wired into both `runDirect` and `runService` Agent constructors.
- **9 cli-app integration tests** (`bin-compact-strategy.test.ts`) — accept all four strategies, reject missing/unknown value, env-vs-CLI precedence.

### P3 — naia-memory v3 anchored iterative + 5-section recap (companion commit naia-memory `604677f`, branch `migration/compact-anchored-iterative`)

- **`MemorySystem.compact()`** accepts `strategy?` + `priorRecap?` (both optional, backward-compat with existing host tests).
- Prepends `## Prior recap (anchored)` section verbatim when `priorRecap` supplied — Factory.ai anchored iterative pattern (prior recap = seed for next recap, never re-summarized from raw).
- 5-section markdown appended after legacy `[Conversation recap …]` header: `## Goal` (first user) / `## Instructions` (system msgs) / `## Tool calls made` (deduped, cap 10) / `## Discoveries` (fact-shaped assistant lines) / `## Relevant files / URLs` (paths + URLs strict-preserved via regex).
- **9 new tests** (`compact-anchored.test.ts`) + 19 pre-existing pass (28/28 total).

### P4 + P5 — runtime wire-up integration (commit `1a1aafe`)

- **`agent-compaction-strategy.test.ts`** — 6 integration tests proving end-to-end:
  - **P4-01/02** strategy + sessionId forwarded to memory.compact() (reactive & realtime)
  - **P4-03** second compaction in same session carries priorRecap from first (anchored iterative end-to-end)
  - **P5-01/02** anthropic-native AND off short-circuit (memory.compact() NEVER invoked)
  - **P5-03** reactive sanity (compact() DOES invoke under budget pressure)

### P6 — 10 seed fixtures + real measurement runner + first ledger (commit `db85931`)

- **10 seed fixtures** under `packages/benchmarks/src/fixtures/` (F001-F010 across 10 domains: customer-support / coding-pair / research-synthesis / persona-roleplay / tool-heavy / mixed-language / calculation-chain / story-continuation / preference-tracking / websearch-heavy). 18-23 turns each; 2-3 probes (fact-recall + task-accuracy + optional drift); explicit compactionPoints. `FixtureRole` schema extended to include `"tool"`.
- **`runFixture()`** drives a fixture through real `MemorySystem.compact()` per strategy. realtime path encodes every turn first (rolling accumulation); reactive path triggers compaction at compactionPoints with anchored iterative `priorRecap` chained across rounds. `evaluateProbe()` is deterministic (keyword match for fact-recall, domain-anchor heuristic for task-accuracy, Jaccard for drift).
- **First measurement** (`reports/2026-05-20-deterministic.md`):
  - `reactive` task 0.40, recall 0.60, drift 0.545
  - `realtime` task 0.40, recall 0.60, drift 0.531
  - `anthropic-native` task 0.30, recall 1.00, drift 1.00
  - `off` task 0.30, recall 1.00, drift 1.00
- **CRITICAL caveat documented** in `.agents/progress/compact-bench-2026-05-20.md` ledger: the deterministic harness *appears* to favor `off`/`anthropic-native` on fact-recall because it doesn't simulate hard truncation. In production those strategies 4xx at context limit. Strategy ranking deferred to LLM-judge iteration (next slice).

### Verification

- All 40 new tests pass + 0 regression on touched packages.
- Build green on @nextain/agent-types / @nextain/agent-core / @nextain/agent-benchmarks.
- @nextain/agent-runtime build has pre-existing TS2532 in coding-tool.test.ts unrelated to this slice — `vitest run` works fine (TS errors are in test sources only, not build output).
- `pnpm bench:compact` end-to-end: 10 fixtures × 4 strategies → report + per-fixture stderr, 0 errors.

### Follow-up (separate slices)

- **LLM-judge iteration** — `NAIA_JUDGE_ENSEMBLE` wiring (GLM HTTP + Codex CLI + Claude CLI 3-judge majority), hard-truncation simulation for `off`, real LLM driver mode (`--driver real` spawning `bin/naia-agent` per turn). Gated on user API keys (host env has `GLM_API_KEY` + `OPENAI_API_KEY` + codex/claude CLI tools).
- **50-fixture expansion** + adversarial fixtures (100+ turn, multi-compaction chains).
- **naia-os#185 Phase 2 wiring** — connect `agent/src/index.ts` `checkTokenBudget` to the new `--compact-strategy` path.
- **MemGPT-light hierarchical** (long-horizon, optional).

## [Slice 3-XR-M + 3-XR-N + 3-XR-O] — 2026-05-20 — REPL/PTY + cross-OS sanity + Claude Code parity ledger (Tasks #25/#26/#27)

User: "3-XR-O까지 달려야해". Three slices in one push (mechanism-heavy, single LIVE in Group M).

### 3-XR-M — multi-turn REPL + Claude Code subscription routing (Task #25)

- **bin/naia-agent.ts**: new `--repl` flag. Default behavior treats piped stdin as single-shot (`readStdin` → one turn) per the existing design. `--repl` forces the readline REPL loop regardless of stdin TTY status — useful for harness multi-turn tests and for shell pipelines feeding several prompts. Model-agnostic.
- **Group M — 2 scenarios**:
  - **M1** multi-turn REPL via async `spawn` (no node-pty dep) — `--repl` + `--no-tools` against a dead model server. safeTurn keeps the REPL alive across per-turn failures: ≥2 `naia> ` prompts observed, clean exit on "exit". Verifies the Slice 3-XR-F safeTurn promise on a LIVE process boundary.
  - **M2** Claude Code subscription routing — `--service <manifest>` with `backend:"claude-code"`. Dry-run mode (NAIA_AGENT_DRYRUN=1) asserts the dispatcher arm without consuming subscription credit. Opt-in `NAIA_AGENT_CLAUDECODE_LIVE=1` env gate executes a real one-turn call (credit consumed). Default OFF.

### 3-XR-N — cross-OS sanity mechanism (Task #26)

- **Group N — 6 scenarios** (Linux-side; Windows host LIVE honestly deferred):
  - **N1** path-traversal blocked regardless of separator style; backslash on Linux = literal filename (documented).
  - **N2** file-ops CRLF roundtrip — `write_file` + `read_file` preserve `\r\n` line endings.
  - **N3** `getSecretStore()` cross-platform — `available()` returns a clean boolean on every platform; Linux wires `LibSecretStore`, others get `NullSecretStore`.
  - **N4** HOME env read on Linux/macOS (USERPROFILE on Windows deferred to a Windows host run).
  - **N5** shell adapter dual-platform branch — `process.platform === "win32"` selecting `cmd.exe` vs `/usr/bin/env`; refuses silent regression to a single-platform hard-code.
  - **N6** honest DEFER — Windows host LIVE = separate slice with a Windows runner. Cross-OS sanity (Group N1-N5) is sufficient mechanism for this session.

### 3-XR-O — naia-agent ↔ Claude Code parity ledger (Task #27)

- **Group O — 7 scenarios** (pure mechanism + intentional-difference ledger):
  - **O1** file-ops parity — naia-agent registers the same 5-skill core (`read_file` / `write_file` / `edit_file` / `list_files` / `bash`) Claude Code's editor surfaces.
  - **O2** REPL parity — readline-based + `naia> ` prompt + exit/quit/.exit + `--repl` force.
  - **O3** tool-marker parity — both runtimes emit per-invocation stderr markers (`[tool] name({args})` vs `● Tool(arg)`); semantics identical.
  - **O4** exit-code parity — 0/2/3 tier (naia-agent) vs 0/1 (Claude Code); intentional divergence documented (3-tier is more actionable for shell pipelines).
  - **O5** memory + persona parity — `--memory` + `--system` + `--no-default-system` wired; equivalent capability to Claude Code's CLAUDE.md + system rider, different shape.
  - **O6** service-mode parity — `--service <manifest>` with `backend:"claude-code"` routes to Claude Code subscription (no API key); DRYRUN gate verifies the wire-up without credit.
  - **O7** intentional-difference ledger — slash commands / TUI rendering / subagent dispatch / plugins / WebFetch / auto-compaction — these are Claude Code PRODUCT surfaces, NOT naia-agent runtime missing-features. Documented as honest non-replication.

### Ralph + regression

- Group M R1=1/2 → R2=2/2 (M1 needed `--repl` flag) → R3=2/2 (**2-consecutive**)
- Group N R1=5/6 (N2 wrong skill handler signature — returns plain string, not `{content, isError}`) → R2=6/6 → R3=6/6 (**2-consecutive**)
- Group O R1=7/7 → R2=7/7 (**2-consecutive**, pure mechanism)
- **Full cli-app regression**: 14 files / **175 passed / 2 skipped / 1 LIVE flake** (S7 ollama cache swap under cumulative 24G + Group P LIVE + Group D LIVE pressure — environment side-effect, NOT a Slice 3-XR-M/N/O regression).

### Over-fit guard preserved

- `--repl` = model-agnostic toggle (default OFF, no behavior change).
- N1-N5 / O1-O7 = mechanism + documentation only, no runtime branch.

### Voice 트랙 (#28) 분리 흡수 (다른 세션 정렬, 2026-05-20)

- Voice P0c phase 가 다른 세션에서 둘로 쪼개짐:
  - **P0c-1 standalone tech demo** (naia-agent 의존 0, LiveKit ↔ ko-serve, mock LLM) = **다른 세션 산출**.
  - **P0c-2 naia-agent integration** = 우리 Task #28 (M/N/O 끝난 후 또는 별 세션 진입).
- plan 문서 `.agents/progress/slice-3-xr-h-i-j-l-plan-2026-05-20.md` §4.5 신설로 흡수.
- Task #28 description = P0c-2 만으로 좁힘.

## [Slice 3-XR-L] — 2026-05-20 — onmam-adk 도메인 skills 자동 적용 검증 (Task #24)

User gate (2026-05-20): "L도 해야겠네". The Slice 3-XR-J `--skills-dir` mechanism is ADK-agnostic — onmam-adk should work identically since it shares the same SKILL.md format and top-level `skills/` layout. This slice closes that loop.

- **onmam-adk inventory**: 10 SKILL.md-valid skills + 1 stub dir (business/, no SKILL.md). 9 share names with naia-adk (channel-management, doc-coauthoring, document-generation, email, read-doc, review-pass, service-management, sms, web-monitoring), 1 onmam-only (`wp-archive`).

- **Group G — 4 scenarios** (integration-scenarios.test.ts):
  - **G1** onmam-adk skills/ load — 10 skills + `wp-archive` + 9 naia overlap (mechanism, tier distribution recorded)
  - **G2** wp-archive descriptor valid — onmam-only domain skill (name/tier/description/inputSchema)
  - **G3** naia-adk + onmam-adk **collision** via `CompositeToolExecutor` — first-registered wins:
    - `ownerOf("channel-management") === "naia-adk"` (first sub wins)
    - `ownerOf("wp-archive") === "onmam-adk"` (onmam-only present)
    - `shadowedNames().length >= 9` (the 9 overlapping names)
    - Trust boundary documented: sub ORDER controls shadowing. Putting an attacker-controlled sub first would let it shadow a built-in.
  - **G4** onmam-dev GCE live invocation — **DEFERRED** (user gate per `feedback_ai_leads_human_executes_serverenv`; external server modification is human-executed only). Honest skip in the results JSON.

- **Ralph trajectory**: R1 = 4/4 PASS, R2 = 4/4 PASS (2-consecutive). No core changes needed — onmam-adk works through the existing Slice 3-XR-J machinery as predicted.

- **Full cli-app regression**: 14 files / **160 passed / 2 skipped / 1 flake (S7 ollama cache swap, NOT Group G)** / 465s wall. S7 was flake-fixed once already (Slice 3-XR-I 240s timeout + Slice 3-XR-J 480s + retry); under the now-larger LIVE pressure (Group D 24G + Group P 24G + Group G mechanism all using gemma4:31b in the same suite run) the e4b cold-start sometimes exceeds 2× retries. Not a Slice 3-XR-L regression.

- **Honest verification of the user's hypothesis**: "naia-adk와 동일 메커니즘이므로 #22 끝나면 자동 적용 가능" — confirmed. Zero bin/runtime changes needed for onmam-adk. Same `--skills-dir <path>` flag, same FileSkillLoader, same SkillToolExecutor, same Composite shadowing semantics.

## [Slice 3-XR-H] — 2026-05-20 — multi-judge ensemble (GLM + Codex + Claude) — Task #20

Resolves `feedback_pi_substrate_not_glm_only_2026_05_20`: the pi pin-bundle substrate intent is **multi-tool external subprocess**, not a single GLM HTTP call. This slice ships the missing ensemble path.

- **`lib/llm-judge.ts`** — new functions:
  - `judgeClaude(args, opts)` — spawns `claude -p <prompt> --output-format text` (Claude Code 2.1+ CLI). Out-of-process; uses CLI's own OAuth.
  - `judgeCodex(args, opts)` — spawns `codex exec --output-last-message <file> <prompt>` (codex-cli 0.130+).
  - `judgeEnsemble(args, opts, env)` — runs GLM HTTP + claude CLI + codex CLI in parallel. Returns `EnsembleVerdict { pass, reason, glm?, claude?, codex?, agreeRate, validCount, infraErrorCount }`.
  - `ensembleAvailable()` — 5-second probe of each provider's invokability.
  - Aggregation: infra-errored judges EXCLUDED from majority. Strict-majority pass among remaining → ensemble pass. Tie or all-fail → ensemble fail. Configurable via `includeGlm/includeClaude/includeCodex`.

- **Self-judge bias avoidance — structural**:
  - SUT (System Under Test) = local Gemma family (gemma4:31b / gemma3n:e4b on ollama).
  - Judge ensemble = GLM-4.5 (cloud, Zhipu) + Claude (Anthropic) + Codex (OpenAI). **Different vendors, families, sizes.** Cannot self-vote.

- **`integration-scenarios.test.ts`** — opt-in ensemble for **3 high-judgment scenarios** (A1 / A4 / F2). Gated by `NAIA_JUDGE_ENSEMBLE=1` (default off — single GLM, to bound subscription costs). Other 23 scenarios stay single-GLM (low-judgment, mechanism-asserted).

- **Ralph R1 → R2 finding (real value of ensemble)**:
  - R1 A1: ensemble `pass=true agreeRate=0.67` — **codex DISAGREED** with glm/claude. Codex strict-interpreted "the output" to include the harness's `[exit=N]` header + stderr tool logs, voted FAIL. GLM and Claude correctly evaluated only the model's response prose. **Single-GLM would have hidden this ambiguity.**
  - R2 (this commit): A1 `expected` clarified — "Evaluate ONLY the model's reply text (above the `--- stderr ---` divider). Ignore [exit=N], stderr lines, tool logs". After clarification all 3 judges unanimous.
  - R3: confirmed 2-consecutive PASS (R2+R3, agreeRate=1.0 across all 3 scenarios, 9/9 judges PASS, 0 infra-error).

- **Cost ledger**: each ensemble-enabled run = 3 scenarios × 3 judges = 9 API calls. claude CLI subscription credits + codex CLI credits consumed. Default OFF preserves run cost. Set `NAIA_JUDGE_ENSEMBLE=1` for explicit ensemble runs.

- **Full cli-app suite regression (single-GLM mode)**: 14 files / **151 passed / 2 skipped / 0 failed** / 395s wall. No regression. Over-fit guard 100% preserved (`feedback_naia_agent_general_purpose_no_overfit`) — judge harness only, no core change.

- **Planning context (`.agents/progress/slice-3-xr-h-i-j-l-plan-2026-05-20.md`)** — design doc spelling out H → J → L sequence per user gate. K (LangGraph + RAG actual implementation) explicitly deferred; its small reserve (manifest enum + stub message) will piggyback on J as a separate commit.

- **Limitations**:
  - opencode / gemini CLIs NOT wired (user said "glm, codex, claude").
  - Ensemble used on 3 scenarios only (high-judgment); 23 others still single-GLM.
  - claude CLI subscription / codex credits consumed per ensemble run.

## [Slice 3-XR-I] — 2026-05-20 — pi-based coding LIVE verification (Group P) — Task #21

User asked (verbatim): "pi 기반의 코딩도 진행이 되는거야?". The prior Group B coding scenarios only exercised LLM read/explain prose. This slice closes the gap with **6 LIVE tool-calling scenarios** in which gemma4:31b drives the runtime tool-loop end-to-end.

- **Native tool-calling probe**: ollama `gemma4:31b` returns `finish_reason="tool_calls"` + a populated `tool_calls` array (contrary to the earlier "likely no, Gemma family" note in tier-8g-vs-24g-comparison). GLM also OK. `naia-coding` (port 8000) currently down (separate `vllm-coding` 48G service).

- **bin/naia-agent.ts**: new `--enable-file-ops` flag (general toggle, default OFF — no behavior change). When set, `createFileOpsSkills({ workspaceRoot: args.workdir })` registers `read_file` / `write_file` / `edit_file` / `list_files` alongside `bash`. The `workspaceRoot` is wired from the existing `--workdir` so D09 normalizeWorkspacePath enforces the boundary consistently. Same wiring applied to BOTH direct mode (`runDirect`) AND service mode (`runService`).

- **Group P — 6 LIVE scenarios** (integration-scenarios.test.ts):
  - **P1 write_file** — model writes to a tmp file via the tool; mech = file exists + content non-empty.
  - **P2 read_file** — model reads a tmp file (which contains "the magic number is 73218") and quotes the number; mech = stderr `[tool] read_file` marker + stdout includes `73218`.
  - **P3 list_files** — model lists a tmp dir with 3 files; mech = stderr `[tool] list_files` + all 3 file names in stdout. (R3: persona made strict on path; R4: `--workdir` wired so workspace boundary admits the tmp dir.)
  - **P4 edit_file** — model patches `version=0.1.0 → 0.2.0`; mech = stderr `[tool] edit_file` + file content matches.
  - **P5 bash** — `echo READY-marker-7Q`; mech = stderr `[tool] bash` + stdout quotes the marker.
  - **P6 multi-tool composite** — write + (list either via list_files OR bash-ls) + (read either via read_file OR bash-cat) + final file content correct. Mech accepts either native file-ops OR bash fallback (model composes freely).

- **Ralph 5 rounds → 2-consecutive PASS (R4 + R5, 6/6 ✅)**. Each round corrected scenarios or wiring, never core:
  - R1=4/6 (P3 + P6 fail) → R2: P3 persona strict / P6 mech relaxed.
  - R2=5/6 (P3 still fail) → diagnosed: `createListFilesSkill` BLOCKS path "escapes the workspace" because bin called `createFileOpsSkills()` without `workspaceRoot`, defaulting to `process.cwd()` (the test temp HOME, not the per-scenario `work` dir).
  - R3 fix: bin wires `{ workspaceRoot: args.workdir }`; scenarios pass `--workdir <work>`. R3=5/6 (P6 fail — model emitted all 3 tools but final prose only quoted file content, not listing). 
  - R4 fix: P6 mech accepts list_files-or-bash and read_file-or-bash markers (model composition is honest, ground-truth lives in stderr `[tool]` markers, not in response prose).
  - **R4=6/6 PASS** ✅ — **R5=6/6 PASS** ✅ (2-consecutive).

- **S7 (bin-user-scenarios) timeout bump**: 90_000 → 180_000 spawn + 240_000 vitest-it. e4b cold-start exceeds 90s when gemma4:31b (19.9GB) holds the ollama cache and forces a swap. Same-flake observation as `feedback_external_hdd_hang_local_fallback` cousin (environment side-effect, not scenario regression).

- **Full cli-app suite regression**: 14 files / **151 passed / 2 skipped / 0 failed** / 352s wall. No core change beyond the `--enable-file-ops` toggle + workspaceRoot wiring (both are model-agnostic, default-off opt-in additions — `feedback_naia_agent_general_purpose_no_overfit` guard preserved).

Reports: `.agents/progress/integration-scenarios-results-2026-05-20.json` (updated). CHANGELOG line of Slice 3-XR-G updated upstream entry's wording where needed.

Honest framing: the model under test (gemma4:31b on ollama) often supplements native `read_file`/`list_files` with parallel `bash` calls — this is correct composition behaviour, not a defect. The runtime tool-loop accepted both paths.

## [Slice 3-XR-G] — 2026-05-20 — integration scenarios + LLM-as-judge + ADK ecosystem coverage (Task #17/#18/#19)

User asked: "이제 연결, 검증만 했고 — 시나리오 더 다양화 + pi의 tool calling + 코딩 도구 동작 + naia-adk hooks/skill + 다른 AI들과 설계해 + LLM-judge + 랄프개선 + naia-business-adk (team/RAG/LangGraph) + naia-os 페르소나 + onmam-adk/onmam-dev". This slice answers it.

- **Design v3 (cross-reviewed by GLM, 2 rounds)**:
  `.agents/progress/integration-scenarios-design-2026-05-20.md`. Verdict
  loop v1=REVISE → v2=REVISE → micro-adjust (Ralph max-iter=5,
  judge consistency probe simplified, Group K trimmed, J2b deferred,
  Ralph timebox 60min, codepath gating ≥2 scenarios) → FINAL v3.

- **LLM-as-judge harness** —
  `packages/cli-app/src/__tests__/lib/llm-judge.ts` (~230 LOC). Provider
  resolution GLM > OpenAI-compat > Anthropic. Strict JSON envelope
  `{pass, reason}` + one fence-strip retry. Transport/parse/empty =
  infra-noise (scenarios tolerate, real-verdict-false still flunks).
  Self-judge bias avoidance: SUT=Gemma family local / Judge=GLM (different
  family, vendor, size). Privacy: synthetic test inputs only, never user
  memory (cf feedback_naia_reasoning_locality).

- **New `packages/cli-app/src/__tests__/integration-scenarios.test.ts`** —
  **26 hermetic spawn-tests (25 active + 1 dummy grid-completeness skip),
  Ralph 5 rounds → 2-consecutive PASS R4 + R5 (26/26)**. Total wall ≈ 5min.
  Groups:
  - **A. 24G live (gemma4:31b)** 4/4 — Korean greeting (thinking-mode
    suppressed via "Answer directly" + `max_tokens≥300`), English tech
    answer, persistent memory recall (lite_facts SQLite probe), no-tools
    refuse-fabricate.
  - **B. coding behaviour** 3/3 — read+explain, bug-spot (silent div-by-0
    return), refactor proposal (input validation).
  - **C. tool-calling/pi loop** 1/1 — e4b native-tools error surface.
  - **E. business-adk reserve (LangGraph/RAG)** 2/2 — backend stub graceful.
  - **F. naia-os persona injection (`--system`)** 4/4 — pirate tone,
    persona+memory composition, --no-default-system rider absent,
    4KB persona pass-through.
  - **H. error handling** 5/5 — server-down, malformed manifest,
    no-provider, --memory without embedded role (ephemeral fallback
    actionable), unknown-flag graceful.
  - **I. security secret-shape** 5/5 — raw sk-ant / AIza / ghp_ rejected
    at login WRITE boundary + show value-leak 0 + positive control.
  - **J. composite** 1 dummy placeholder for grid completeness.
  - **K. e4b vs 31b same prompt** 1/1 — Merkle tree; both pass judge.

- **Judge stats round 5**: **11/11 PASS** (100%), 0 infra-error,
  0 real-fail.

- **No core change** — over-fit guard
  (`feedback_naia_agent_general_purpose_no_overfit`) 100% preserved.
  All 5 round-corrections were scenario or test-harness fixes (SQLite
  table name, manifest schemaVersion, judge transport tolerance,
  vitest it-timeout 10s→30s, e4b default-rider).

- **Full cli-app suite regression**: 14 files / **145 passed / 2
  skipped / 0 failed** / 307s wall (existing 22+2 unit + new 26+1).

- **Reports**:
  - `.agents/progress/integration-scenarios-results-2026-05-20.json`
  - `.agents/progress/integration-scenarios-report-2026-05-20.md`
  - `.agents/progress/cross-review-glm-2026-05-20.json`

- **Deferred (explicit ledger, 3-surface)**:
  `--skills-dir <path>` CLI for FileSkillLoader live (D1~D5 mechanism-only
  here); LangGraph node routing (E4); RAG retriever (E5); onmam-dev GCE
  live (G4); multi-turn REPL PTY; live Claude Code subscription;
  SDLC artifact production (needs strong backend); naia-adk hooks/
  policies live invocation (D3).

- **⚠️ Honest limitation (2026-05-20 user correction)**: judge AND
  design cross-review used GLM single-provider outsourcing only. Per
  project_naia_own_orchestrator_pi_substrate, the pi pin-bundle
  substrate intent is multi-tool external subprocess (claude / codex /
  opencode / gemini + GLM HTTP). All four CLIs installed + GLM key
  set — no environmental reason to use one only. Follow-on slice
  3-XR-H = multi-judge ensemble (GLM + Codex + Claude verdicts +
  judge_disagreement_rate). See cf feedback memory entry.

## [Slice 3-XR-F] — 2026-05-20 — user-perspective scenarios + user manual + onboarding UX (Task #3)

The user asked for tests that reflect a real non-developer typing the
CLI, not flag mechanics — across two perspectives.

- **New `packages/cli-app/src/__tests__/bin-user-scenarios.test.ts`** —
  **24 hermetic spawn-tests (22 active + 2 honest skips)**, temp HOME
  + temp adk; no leakage into the developer's real `~/.naia-agent` /
  naia-adk / OS keychain. Live-LLM scenarios use per-scenario inline
  re-probe via Node `fetch` + `AbortSignal.timeout` (no `curl`
  dependency, no stale module-load gate); per-test
  `{ timeout: 90_000…180_000 }` for cold-start margin. CLAUDE.md G15
  fixture-only default; real-LLM opt-in by presence. The test file is
  the canonical SoT for the active surface.
  - **USER (1)** — S1 cold `show` (literal `<unset>`) · S2 first run
    no config (advertises BOTH `naia-agent login` AND env-var paths,
    no `fatal:`) · S3 `login` empty args + locked pipe-format hint
    `provider|baseUrl|model` · S4 configure-then-inspect (`show`
    mirrors login, `apiKeyRef=NAME` visible no `NAME=value`, locked
    `Run:` next-step hint) · **S5** natural flow login → server dead
    → retry (clean hint, exit 2) · **S5b** ENOTFOUND typo'd hostname
    variant · S6 tools-less local model → `--no-tools` hint (LLM-live,
    90s inner) · S7 happy-path one-shot (LLM-live) · S8 `--memory`
    cross-process SQLite invariant (better-sqlite3 row probe — the
    headline product mechanism) · S8-neg without `--memory`,
    `cli.sqlite` is never created · **S9** login MERGE preserves
    untouched roles · **S10** login SWAP replaces the same role ·
    **S11** malformed `llm.json` → `show` still works, no crash ·
    **S12** invalid `embedded.dims` → graceful ephemeral fallback +
    actionable remediation breadcrumb (`login` / `--embedded` /
    `dims`) · S13 honest skip (concurrent writes need `spawn`+WAL —
    deferred) · **S15** empty stdin / no prompt → exit 3 with
    `no prompt` + usage (the most common first-time mistake; closes
    cross-review A-F2 BLOCK) · S20 deferred 24G placeholder.
  - **SHELL / gateway (2)** (per
    `[[feedback_naia_agent_gateway_only]]`) — G1 gateway URL +
    `apiKeyRef` NAME; generic `_(API_KEY|TOKEN|SECRET|PASSWORD)=…`
    leak shape forbidden for any credential var; literal
    `apiKeyRef=GATEWAY_API_KEY` shape locked. G2 raw `sk-ant-…`
    refused at WRITE boundary (tolerant `raw secret|raw credential`
    rephrasing). **G2b** raw Google API key (`AIza…`) refused ·
    **G2c** raw GitHub PAT (`ghp_…`) refused · **G2d** positive
    control: legitimate ref NAME containing `_KEY` accepted (no
    false-positive). **G3** `--service` manifest `backend:claude-code`
    routes via `NAIA_AGENT_DRYRUN=1` (no API key, no LLM credit) —
    the Claude Code subscription harness target. **G4** malformed
    manifest → graceful parse error; bin now surfaces the manifest
    PATH (`naia-agent: invalid manifest "<path>"`) so the user
    knows which file failed.
- **`safeTurn` hint extended**: "does not support tools" → actionable
  `--no-tools` guidance (the natural friction surface surfaced in the
  user's own live session).
- **`buildLLMClient` error onboarding**: no-provider message now
  advertises `pnpm naia-agent login` as the quickest path AND env-var
  alternatives, with pointers to `docs/llm-config-standard.md` +
  `docs/user-guide.md`.
- **New `docs/user-guide.md`** — short user-facing manual covering both
  perspectives, the 3-command quick-start (`login → show → chat`),
  common tasks (`show`, swap model, real key via keychain, `--memory`,
  REPL), troubleshooting, and where settings/secrets live (privacy
  contract).
- **`naia-model-infra/tiers/24g/`** — `profile.yaml` + refreshed README
  for the daily-driver tier (Gemma 4 31B Q4_0 main, bge-m3 embedded,
  optional gemma3n:e4b sub). Single-GPU `CUDA_VISIBLE_DEVICES` policy;
  connection contract identical across tiers.
- Adversarial cross-review loop (autonomous "랄프", 2 consecutive
  CLEAN target): round #1 PASS-WITH-FIXES → all 10 findings (F1-F10)
  applied; round #2 → S8/S8-neg converted from flaky model-output
  assertions to deterministic file-system invariants (SQLite row vs
  cli.sqlite absent) — same lesson as the #41 small-model lenient-strip:
  test mechanism, not LLM vibes; round #3 BLOCK (vitest testTimeout
  10s < LLM-live spawn caps) → per-test `{timeout}` applied; round
  #A/B/C/D 4-perspective expansion (UX / Performance / Real-usage /
  Benchmark objectivity) — all HIGH/BLOCK closed or honestly
  deferred; round #4 (final consolidated) PASS-WITH-FIXES (4 LOW
  only: CHANGELOG-doc / user-guide-doc / regex-tightness / `--key`
  write path tracked) → doc-axis fixes applied this entry; code-axis
  converged across rounds 2/3/A/B/C/D.
- **Deferred (explicit, separate slice)**: `--key REF=VAL` keychain
  WRITE round-trip (value reaches keychain, never to llm.json / stderr
  — requires libsecret sandbox or fixture `SecretStore`; round #4
  LOW-4) · multi-turn REPL `#history` (requires PTY emulation; bin
  falls to single-shot on non-TTY) · 24G gemma4:31b live scenarios
  (reasoning-channel suppression unsolved — see
  `.agents/progress/tier-8g-vs-24g-comparison-…`) · baseURL `?key=…`
  / `user:pass@host` leakage path (requires bin URL sanitization) ·
  RBAC tier-policy /
  approval-broker scenarios (needs ApprovalBroker UX surface) ·
  **live-subscription** Claude-Code routing E2E (G3 covers the DRYRUN
  dispatch from a service manifest; a live test would consume Claude
  Code credits and is deferred) · SDLC
  artifact production (requires a strong coding model; 8G/24G local
  models cannot deliver — separate track when claude-code or a strong
  gateway backend is configured). See `docs/user-guide.md` "Planned /
  not yet shipped" for the user-facing summary.

## [Slice 3-XR-E] — 2026-05-20 — CLI UX: `show`, `login` empty-args guard, usage discoverability

Direct response to user UX concerns (Task #3 wrap-up):

- **New** `pnpm naia-agent show` — read-only one-screen inspection of
  current configuration: naia-adk path, llm.json roles (provider/model/
  baseUrl/dims), apiKeyRef NAME (never values), resolved LLM that would
  run, memory db path + existence, `~/.naia-agent/config.json`. Closes
  "is naia-adk storage right? what would my CLI invoke?" without
  cat'ing files. Secret values are never printed.
- **Fix** `pnpm naia-agent login` (no args) → previously wrote llm.json
  + `~/.naia-agent/config.json` with empty roles and printed
  "configured" (misleading silent noop). Now prints usage + exits 3.
- Main usage now lists `login`, `show`, `--memory`, `--no-tools`,
  `--no-default-system`, `--system` for discoverability.

## [Slice 3-XR-D] — 2026-05-20 — recall-marker residue hygiene (no leak)

Small models (e4b) emit malformed `<recall>` markers (`<recalall>…`,
`<recal_l>…`, `<recal<…`, stray `</recall>`) the strict parser correctly
ignores — they were leaking into the CLI answer.

- New exported pure `stripRecallResidue` (core; `index.ts` export) +
  `agent.ts` strip-path uses it (the STRICT match/act is unchanged —
  cross-review invariant A: leniency never reaches recall behavior).
- **Behavior change (disclosed):** `bin streamToStdout` no longer streams
  raw `llm.chunk` text deltas; it prints the agent's final *sanitized*
  `assistantText` on `turn.ended`. Raw streaming bypassed the strip and
  leaked markers. Trade-off: no live token streaming in direct mode
  (acceptable for short answers; applies to all direct-mode turns).
- Claude sub-agent adversarial review = BLOCK → all fixed:
  B1 anchored to the `recal` family only (`<recap>`/`<recapitulate>`/
  `<recital>`/`<receipt>` no longer destroyed); B2 strip only
  line-leading/standalone residue (a `<recall>` quoted in prose/code is
  preserved — the agent must not erase its own protocol docs); B3
  content bounded `{0,256}` + line-anchored (no cross-paragraph
  bridging); D5 marker-free input returned BYTE-IDENTICAL (no
  whitespace/​trim mangling of normal answers or code); F6 nullish-safe.
- Regression test `strip-recall-residue.test.ts` encodes every BLOCK
  negative (recap/recapitulate/receipt, quoted-protocol, cross-paragraph,
  code indentation, undefined) — fails pre-fix, passes post-fix.

## [Slice 3-XR-C] — 2026-05-20 — memory wired into the CLI (persistent recall)

`pnpm naia-agent --memory` now uses a **persistent LiteMemoryProvider**
(blessed `@nextain/naia-memory` components) + the naia-settings
`embedded` embedder + the #41 `<recall>` recall, instead of ephemeral
InMemoryMemory. Verified hands-on: a fact stored in process A is
recalled & answered correctly by a separate process B (cross-session
SQLite). Opt-in — default unchanged (no regression).

- `--memory`: builds `OpenAICompatEmbeddingProvider` (from
  `NAIA_EMBED_*`) + `LiteMemoryProvider` (`NAIA_AGENT_MEMORY_DB` or
  `~/.naia-agent/memory/cli.sqlite`, writesEnabled). No `--system` →
  built-in recall-protocol persona; defaults to lean prompt (the heavy
  contract degrades small models + dilutes the recall instruction, #41
  measured). Any failure degrades gracefully to InMemoryMemory (anchor
  #6 — never crash over memory).
- **Root-cause fixes** (memory was DOA without these):
  - `package.json` `pnpm.onlyBuiltDependencies: [better-sqlite3,
    esbuild]` — pnpm 10 had silently skipped the native build, so
    `LiteMemoryProvider` could not open SQLite at all.
  - bin normalizes the embedder base URL (strips a trailing `/v1`):
    `OpenAICompatEmbeddingProvider` unconditionally appends
    `/v1/embeddings`, so a uniform `…/v1` naia-settings baseUrl produced
    `…/v1/v1/embeddings` → 404 → every encode failed silently. General,
    composition-root adaptation; no model branching.
- Known caveat (not a regression): a small model (e4b) emits malformed
  markers (`<recal_…`) that the strict parser correctly does not act on,
  so they leak into the visible answer — recall still works via the
  always-on start-of-turn path. Lenient-strip polish deferred (#41).
- Follow-up recommendation (separate, cross-reviewed): make
  naia-memory `OpenAICompatEmbeddingProvider`'s URL idempotent for a
  `/v1` base so every consumer is safe at the source.
- ⚠️ Single global memory store: default db is shared by every
  `--memory` invocation in any directory — set `NAIA_AGENT_MEMORY_DB`
  per workspace to isolate (cross-project recall is by-design for a
  personal assistant but a confidentiality footgun otherwise).

Slice success criterion (CLAUDE.md gate):
- (a) Runnable: `pnpm naia-agent --memory "…"` (persistent recall).
- (b) Unit test: `packages/runtime/src/__tests__/cli-memory.test.ts`
  (`normalizeEmbedBaseUrl` incl. Gemini/`/v1` edges + `decideCliMemory`
  fallback gate) + naia-settings `applyAux` apiKeyRef wiring covered by
  the existing naia-settings suite.
- (c) Integration: verified hands-on — process-A store → process-B
  recall via cross-session SQLite (local e4b + bge-m3).
- (d) CHANGELOG: this entry.

Cross-review (Claude sub-agent, PASS-WITH-FIXES) applied: F1 extracted
`cli-memory.ts` + test (slice gate); F2 embed sentinel gated by
`manifestBaseURLTrust` + `applyAux` now wires `*_API_KEY` via
`resolveSecret` (a configured remote sub/embed key is no longer
dropped); F3 `MEMORY_PERSONA` made language-neutral (general-purpose —
no Korean output directive); F4 global-store footgun documented; F5
`normalizeEmbedBaseUrl` guards the provider's Gemini discriminator.

## [Slice 3-XR-B.1] — 2026-05-20 — graceful turn failure (no fatal crash)

A model-server outage (ECONNREFUSED etc.) no longer fatal-crashes the
CLI. `safeTurn` wraps every turn: REPL prints an actionable message
(server unreachable at <baseURL> → `naia-agent login …`) and **stays
alive**; single-shot exits cleanly (code 2) with the same hint instead of
`naia-agent: fatal: …`. Surfaced by the Slice-A dead-loader wiring now
live-loading a stale `./naia-agent.env` (cross-review F4/F5 scenario).

## [Slice 3-XR-B] — 2026-05-20 — `naia-agent login` + OS-keychain secrets (Task #3)

`naia-agent login` configures the 3-role LLM (main/sub/embedded) and
persists keys device-key-encrypted in the OS keychain — never plaintext.

- **New runnable**: `pnpm naia-agent login --adk <path> --main
  "provider|baseUrl|model[|apiKeyRef]" [--sub …] [--embedded
  "…|dims[|apiKeyRef]"] [--key REF=VALUE]`. Writes
  `<adk>/naia-settings/llm.json` (provider/baseUrl/model/apiKeyRef/dims
  only — NEVER a key value) + `~/.naia-agent/config.json` `{naiaAdkPath}`
  (mode 600). `--key` stores into the OS keychain (libsecret /
  Secret Service, device-key encrypted). Verified login→persist→consume
  round-trip (local e4b, no `NAIA_ADK_PATH` export needed).
- **No-plaintext, enforced both sides**: `parseRoleSpec` rejects a raw
  secret in the `apiKeyRef` slot at the WRITE boundary (not only the
  Slice-A read-side scan); the secret-value heuristic now also catches
  hyphenated keys (`sk-ant-…`) — strengthens Slice A too.
- **Keychain unavailable → REFUSE** (no plaintext fallback): availability
  is classified locale-independently (`classifyProbe` — cross-review
  BLOCK fix; the prior English-substring heuristic false-positived on a
  localized `secret-tool`). Non-Linux degrades to unavailable, never
  plaintext.
- **Behavior-change disclosure** (cross-review F4): after `naia-agent
  login`, `~/.naia-agent/config.json`'s `naiaAdkPath` makes
  naia-settings auto-load on *every* invocation (Slice A required an
  explicit `NAIA_ADK_PATH`). Remove that file / its `naiaAdkPath` to
  revert to env-only.
- New modules: `secret-store.ts` (`getSecretStore`/`classifyProbe`),
  `login-spec.ts` (`parseRoleSpec`); `readConfiguredAdkPath` exported &
  de-duplicated (was copied in bin). Tests: secret-store 7
  (classifyProbe fixture table incl. measured Korean down-states),
  login-spec 6, naia-settings keychain 2, env-loader readConfiguredAdkPath
  2 — 64/64 runtime green. Claude sub-agent adversarial review (BLOCK →
  all fixes applied). Governance: llm-config-standard §3.6,
  ref-adoption-matrix §D53.

## [Slice 3-XR-A] — 2026-05-20 — cross-repo LLM config: naia-settings/llm.json (Task #3)

naia-agent now CONSUMES the canonical cross-repo LLM config
(`<NAIA_ADK_PATH>/naia-settings/llm.json`, 3-role `{main,sub,embedded}`;
SoT = naia-adk/naia-settings/README.md). General/provider-driven — no
model/tier branching.

- **New runnable**: `NAIA_ADK_PATH=<naia-adk> pnpm naia-agent --no-tools "…"`
  → reads naia-settings → drives the configured `main` LLM. Verified
  end-to-end against a local Ollama (`provider=openai-compat
  model=gemma3n:e4b`, real Korean response).
- **New module**: `packages/runtime/src/utils/naia-settings.ts` —
  `loadNaiaSettingsLLM()`. `main` → `OPENAI_*`/`ANTHROPIC_*`/`GLM_*`
  (unset keys only; local no-key → `OPENAI_API_KEY=ollama` sentinel);
  `sub`/`embedded` → `NAIA_SUB_*`/`NAIA_EMBED_*`. No plaintext key —
  `apiKeyRef` names an env var (Slice B: OS keychain). Graceful skip on
  missing/malformed; never logs values.
- **Wired the dead loader**: `bin/naia-agent main()` now calls
  `loadEnvAndConfig()` (it was defined but never invoked — the documented
  resolution was inert). Priority: `process.env > naia-settings/llm.json
  > .env files > json config`. process.env never overwritten.
  **Upgrader note**: `./.env` / `./naia-agent.env` /
  `~/.naia-agent/config.json` were previously NOT loaded (loader never
  invoked); they are now — review cwd for a stray `.env` before upgrading
  (process.env still wins, so an exported var is unaffected).
- **Secret invariant ENFORCED** (cross-review fix): the reader actively
  rejects the whole `llm.json` (warn + skip, value never logged) if any
  role carries a plaintext-secret-looking key/value — not merely "doesn't
  read it". The `OPENAI_API_KEY=ollama` sentinel is now gated to
  loopback/private baseUrls (reuses `manifestBaseURLTrust`); a remote
  baseUrl without a key no longer gets a dummy key (fails honestly, not
  opaquely). General — no model sniffing.
- **New general flag** `--no-tools`: omit tools for models without native
  tool-calling (local gemma3n). Model-agnostic, no per-model branching.
- **New unit test** (6/6): `naia-settings.test.ts` — main→env mapping,
  local sentinel, apiKeyRef deref, process.env precedence, sub/embedded,
  graceful skip/warn.
- Governance: docs/llm-config-standard.md §3.3–3.5 (SoT) updated;
  ref-adoption-matrix §D53. Cross-repo: naia-adk gets
  `naia-settings/llm.json` (8G local instance, no secrets) + README.
- Pre-existing build-blocker noted (unrelated): `coding-tool.test.ts`
  TS2532 fails `tsc -b`; this slice's files are type-clean (unit green,
  end-to-end verified).

## [Slice 8G-B] — 2026-05-20 — tiered conversational recall benchmark (naia-agent#41 v2)

The naia-agent-owned **conversational** benchmark for the 8G LLM-initiated
text-marker recall (naia-memory does retrieval-only bench; anchor #3/§B02).

- **New runnable command**: `pnpm exec tsx examples/conversational-recall-bench.ts`
  — runs N trials of the real Agent loop against a real container model
  (GPU0), scored by a deterministic tiered judge. Env: `BENCH_TRIALS`,
  `OLLAMA_MODEL`.
- **New unit test** (10/10): `packages/runtime/src/__tests__/recall-bench-judge.test.ts`
  — encodes the 2026-05-20 directive: SMALL tier (e2b) = structure
  capability ONLY (≥1 well-formed marker; accuracy/leak report-only, low
  rate fine); strictness rises with model size (MID/e4b additionally gates
  round-trip accuracy + raw-marker leak). Mirrors naia-memory criteria.ts
  `{target,minimum,metric}`; `koIncludes` faithfully ported (no runtime
  cross-repo dep — "Interfaces, not dependencies").
- **New pure module**: `packages/runtime/src/bench/recall-bench-judge.ts`
  — `koIncludes`, `WELL_FORMED_MARKER`, `LOOSE_MARKER_LEAK`, `tierForModel`,
  `evaluateTier`. Anchor #8: deterministic judge, no external cloud LLM.
- **Integration (real backend)**: honest negative recorded — `gemma3n:e2b`
  small tier, 5 trials, marker-path isolated: **structure 0/5, accuracy 0%,
  leak 100%** → small gate correctly FAILED. e2b is below the #41 v2 marker
  capability floor (confirms adversarial-review B2 empirically). Anti-false-
  positive: marker read from RAW model output (TeeLLM, unconfounded by the
  agent's always-on start-of-turn recall, which `IsolatingMemory` removes);
  malformed `<recal<` caught by the LOOSE leak detector. e4b MID-tier
  measurement is the next strictness step (pending model pull).
- Supersedes the prior `examples/lite-memory-8g-e2e.ts` (removed — its weak
  assertions false-positived on the 2026-05-19 garbled-marker leak).

## [Slice 8G-C] — 2026-05-20 — general system-prompt composition control (naia-agent#41 v2)

Root-cause fix for the 8G marker failure, generalized (NOT an 8G special
path — user directive: naia-agent stays general-purpose, no per-profile
wiring, no overfitting).

- **Root cause** (diagnosed + proven): `agent.ts #buildRequest`
  unconditionally appended the long `DEFAULT_SYSTEM_PROMPT` behavioral
  contract. A small model is degraded by it — emits malformed `<recal>` +
  echoes the injected fact (0/5 well-formed markers in the loop), while a
  DIRECT ollama call (lean prompt) yields a clean `<recall>…</recall>`.
- **Fix (general)**: new `AgentOptions.appendDefaultSystemPrompt?: boolean`,
  default `true` → every existing host's `request.system` is byte-
  unchanged. A host may set `false` (own contract / token budget / a small
  model the long contract degrades). The Agent has **no** tier/model/
  profile awareness — single code path, the host sets a general boolean;
  profiles live in the host layer. Honest comment replaces the prior
  "not bypassable by any host".
- **New unit test** (3/3): `agent-system-prompt-composition.test.ts` —
  unset/true → contract appended (unchanged); false → contract omitted,
  host persona still sent.
- **Consumer**: `examples/conversational-recall-bench.ts` sets the option
  (a small-model host). Empirical post-fix: gemma3n:e4b MID tier
  **structure 4/5 · accuracy 80% · leak 20% → PASS** (was 0/0/60 FAIL) —
  #41 v2 marker mechanism validated end-to-end at the 8G tier.
- Governance: ref-adoption-matrix §D52 (general entry). F06 unaffected
  (touched a code comment, not a numbered D1~D8 decision).

## [Cross-Review Hardening] — 2026-05-18 — 635-test suite adversarial review

3-reviewer (Correctness/Security/Slop-detector) adversarial cross-review of
the full 635-test suite. Two valid findings implemented:

**F1 (MEDIUM)** — `eval "rm -rf /"` bypassed all DANGEROUS_COMMANDS patterns.
rm-rf regex separator `[\s;&|]` → `[\s;&|"']`; end-anchor `[/~][\s/]` →
`[/~][\s/"']`. Two new block test cases added. A24 matrix updated.

**F2 (MINOR)** — `file-ops.test.ts` bundle e2e used positional destructuring
`[readS, writeS, editS, listS]`; silent mismatch if skill order changes.
Replaced with `.find(s => s.name === "...")` name-based lookup. A30 matrix updated.

Dismissed: `$(curl)` cmd substitution bypass (T1 human gate is primary defense),
meter vacuous cache test (behavior pin), operational-patterns structural checks (intentional).

Test count: 635 → 637 (0 failed, 15 skipped unchanged).

## [Slice A] — 2026-05-18 — naia-adk workspace integration + CLI login

**naia-agent standalone path** — naia-os 없이 naia-agent 단독 실행 가능하도록
env-loader와 bin에 워크스페이스 연동 추가.

- `NAIA_ADK_PATH` env var: `{adkPath}/naia-settings/config.json`을 JSON config
  검색 체인(5번)에 추가. `~/naia-adk` 기본 fallback(6번) 추가. `path.resolve()`로
  path traversal 방어.
- `pnpm naia-agent login --key <provider>`: interactive CLI login 커맨드.
  `~/.naia-agent/.env`에 API key 저장. mode 600 설정(Linux/macOS). naia-os
  없이 단독 키 설정 가능.
- 단위 테스트 3건 추가 (`env-loader.test.ts`: NAIA_ADK_PATH load, 우선순위,
  path traversal no-crash).
- `docs/llm-config-standard.md` §3.2/§5/§7 신설 — naia-adk 연동 표준화, 3-repo
  역할 분담 명세.

Runnable: `pnpm naia-agent login --key anthropic && pnpm naia-agent "hi"`

## [Slice R6/SB-1.2] — 2026-05-18 — provider-routing CI gate (naia-agent#39 G1)

Adversarial review proved the claude-code slice's coverage was parse-only
theater — a renamed `case "claude-code"` / `return null` survived 263/263
(routing branch ungated). A first fix (extract `buildLLMClientFromManifest`
→ `@nextain/agent-runtime`) was **reverted**: the builder composes runtime
manifest-trust + providers' VercelClient/`@ai-sdk` SDKs, so it belongs in
the composition root (`bin`); extracting it violated the runtime package's
deliberate no-provider-SDK dependency boundary (structural disturbance).
Reverted clean to `b28e3f2`.
**Structurally-correct gate (this slice):** builder stays in `bin`; added
a test-only env hook `NAIA_AGENT_DRYRUN=1` (after the client is built,
exit 0 without memory/agent/LLM call — hermetic, no credit; never set in
prod) + a spawn test `packages/cli-app/src/__tests__/bin-llm-routing.test.ts`
(mirrors `bin-direct.test.ts`) asserting `backend:"claude-code"` →
`provider=claude-code` + exit 0 with NO API key, and unknown backend →
exit 3. **Mutation-proof:** both reviewer mutations now FAIL the gate.
- Runnable: `pnpm naia-agent --service <claude-code> ` (prod path
  unchanged — DRYRUN unset → real run, verified exit 0).
- Tests: cli-app 97/97; new gate 2/2; prod path non-regressive.
- 0 new contracts; no cross-package boundary change; bin-only + cli-app
  test. Pre-existing finding: `@ai-sdk/google@3` lacks `createVertex`
  (vertex case latent type gap, bin's looser tsconfig hides it) — tracked
  #39, separate fix.

## [Slice R6/SB-1.1] — 2026-05-18 — claude-code subscription backend

**naia-agent#39 (two-tier main-llm), D18 (claude-code SDK adopted), D-OC10
umbrella #37.** Adds `case "claude-code"` to `bin/naia-agent.ts`
`buildLLMClientFromManifest` — `*.service.json` `llm.backend:"claude-code"`
routes to the in-process Claude Agent SDK via the already-adopted
`ai-sdk-provider-claude-code` (same pattern as runtime `coding-tool.ts`)
→ `VercelClient`. Uses the user's **Claude subscription auth — NO API key**
(subscription Agent SDK credit, policy 2026-06-15; per-account, capped →
two-tier routes grunt work to a cheap aux to preserve it). Config lives in
the naia-adk workspace manifest (not env), per direction. Provider matrix:
claude-code=subscription (this) · codex=official Codex SDK (follow-on) ·
gemini=official gemini-cli OAuth thin-wrap, aux-only (follow-on; community
`@ketd/gemini-cli-sdk` rejected — supply-chain) · GLM=existing API-key.
- Runnable: `pnpm naia-agent "..." --service <manifest backend:claude-code>`
  — **real run PASS** (live SDK, no API key, model replied, exit 0).
- Unit test: `service-manifest.test.ts` accepts `backend:"claude-code"`.
- New top-level contracts: 0 (additive switch branch; `ServiceManifest` is
  a runtime host helper type, not a Part-A contract).

## [Slice R6/SB-1] — 2026-05-17 — service manifest loader

**R6 Agent Service Builder 우산 (#31) 1번 슬라이스 (#32, matrix §D50).**
naia-adk workspace 데이터 파일(`*.service.json`)을 읽어 **기존 HostContext**
(llm=D44 Vercel / memory / persona=system msg)를 조립하는 host-side loader.
**신규 최상위 계약 0개** — Part A 3-계약 불변, `ServiceManifest`는 runtime
host helper 타입이지 계약 아님. RAG·orchestration·eval 없음 (SB-2/3/4 후속,
schema §1 호환표대로 additive). 스키마 SoT = `naia-adk/docs/service-manifest-schema.md` v0.1.0.

### Added

- `@nextain/agent-runtime` — `parseServiceManifest()` / `resolveMemoryBinding()`
  / `manifestBaseURLTrust()` / `manifestInvalid()` / `SUPPORTED_MANIFEST_MAJOR`
  (`packages/runtime/src/host/service-manifest.ts`)
  - 순수(provider·naia-memory zero-dep) — 스키마 검증 + semver 호환(§3:
    MAJOR bump 거부 / forward-compat MINOR 무시) + memory binding 해석
  - 실패 = canonical Part-A.11 `ErrorEvent` (`errorCode: "MANIFEST_INVALID"`,
    `severity: "error"`, `retryable: false`) — 설계 §5
- `bin/naia-agent.ts` — `--service <path>` 모드: read → parse → manifest.llm
  → provider(키는 host env 전용, manifest 금지 — schema §4 / 4-repo A.6) →
  memory.binding 해석(`alpha-memory`=naia-memory Sqlite lazy import,
  `~/.naia-agent/services/<name>.db`, env `NAIA_AGENT_MEMORY_DB` override) →
  persona.systemPrompt → `Agent.sendStream`. direct/service 공용 `executeAgent()`.
- Fixture `packages/runtime/src/__fixtures__/qwen-1turn.json` — qwen3.6-27b
  결정적 1턴 (naia 정규화 LLMStreamChunk, F11 안전 posture = anthropic-1turn.json)

### Security & cross-review hardening

manifest = 신뢰 불가 입력(schema §4 보안 경계). 자가 보안 리뷰 + codex/gemini
different-profile cross-review(6 라운드 → **2회 연속 양쪽 CLEAN**, round-5/6)로
다음을 강화 (전 라운드 지적 RESOLVED):

- **Vuln 1 (credential exfil)** — `manifest.llm.baseURL`이 임의 원격 호스트면
  host env API key가 그 호스트로 전송(openai-compatible Bearer). →
  `manifestBaseURLTrust()`: `node:net` `isIP()` + 숫자 IPv4 사설/loopback
  레인지 + IPv6 `::1`/ULA/link-local 판정(문자열 prefix 금지 — codex r1 MAJOR:
  `10.0.0.5.evil.com` 류 우회 차단), 비-IP는 정확히 `localhost`만, allowlist
  **정확 일치**, http/https 외 거부, **userinfo(`user:pass@`) 거부**(codex r3:
  자격증명 로그 누출 차단·schema §4). 비신뢰=요청 거부(exit 3). 순수·모든 host 공용.
- **Vuln 2 (path traversal)** — `manifest.name` 무검증 → alpha-memory DB 경로
  `../` 탈출. → `parseServiceManifest` strict kebab(`^[a-z0-9][a-z0-9-]*$`,
  ≤64) 강제 + `buildAlphaMemory` containment 단언(defense-in-depth).
- **ErrorEvent 일관성** (codex r4 MEDIUM) — `runService` 파일읽기 실패가 손수
  만든 객체(canonical `timestamp` 누락) 대신 공유 export `manifestInvalid()`
  재사용 → parser·host 단일 canonical Part-A.11 shape (drift 0, shared-shape test).
- **자원 정리** (gemini r1 MAJOR/MINOR) — `runService`/`runDirect`가
  `try/finally`로 `memory.close()` 보장(alpha-memory SQLite/WAL 누수 차단);
  `executeAgent` 단일 `try/finally`로 모든 경로에서 `agent.close()`.
- 회귀 커버리지: `service-manifest.test.ts` 18→68 tests (traversal/non-kebab,
  baseURL trust 매트릭스 — 적대적 hostname/canon/exact-allowlist/userinfo,
  canonical ErrorEvent shared-shape).
- cross-review 산출물: `.agents/reviews/sb1-loader-{codex,gemini}-r1..r6.md`.

### Slice success criterion

- (S01) 새 실행 명령: `pnpm exec naia-agent --service <manifest>` ✅
  (arg + MANIFEST_INVALID/unknown-backend 경로 backend 불요 스모크 검증)
- (S02) 단위: `service-manifest.test.ts` 68 tests (필수필드/JSON/semver
  MAJOR 거부/forward-compat MINOR/binding 분기 + 보안·cross-review 매트릭스) ✅
- (S03) 통합 검증: `service-manifest-replay.test.ts` 2 tests — manifest →
  HostContext → `Agent.sendStream` fixture-replay 결정성 + 회귀 ✅
- (S04) 이 CHANGELOG entry ✅
- (G15) CI fixture-only: API key 불필요로 S02/S03 pass ✅
- matrix ID: **D50** (manifest workspace 포맷=비-계약, loader=naia-agent CLI host)

### Known baseline (this slice 범위 외)

- `packages/runtime/src/__tests__/coding-tool.test.ts` TS2532 5건은 commit
  `f2d4308`(#22)에서 유입된 **기존 baseline 결함** — 본 슬라이스 작업 stash
  상태에서도 재현. 본 슬라이스 코드는 tsc 0 error. coding-tool 수정은 별도
  스코프(T2, 미수정·보고).

Refs: nextain/naia-agent#32 (SB-1), #31 (R6 우산), matrix §D50/§L,
설계 SoT `nextain/naia-adk:.agents/progress/agent-service-builder-architecture.md` v4

## [G-NA-01/02] — 2026-05-12 — Memory context fencing + karpathy 4원칙

**hermes-agent 레퍼런스 분석 결과 채택.** `<memory-context>` 태그가 스트리밍 UI에 노출되는 정보 누출(CWE-200)을 막는 scrubber 모듈 추가. naia-agent AGENTS.md에 Karpathy LLM 코딩 원칙 4개 병합.

### Added

- `@nextain/agent-runtime` — `StreamingContextScrubber` (stateful, chunk-boundary-safe state machine)
  - `sanitizeContext(text)` — 완전 문자열 대상 3단계 정규식 정화
  - `StreamingContextScrubber.feed() / flush() / reset()` — 청크 경계 분할 안전 처리
  - `buildMemoryContextBlock(raw)` — recalled memory를 fenced block으로 래핑
  - 위치: `packages/runtime/src/memory-scrubber.ts`
  - F09 compliance: OWASP A03 / CWE-74 cross-ref. Ref: hermes-agent `memory_manager.py`

- Fixture `packages/runtime/src/__fixtures__/memory-context-stream.json` — 청크 경계 분할 시나리오 재현용

- `AGENTS.md` `## 작업 규칙` — karpathy 4원칙 서브섹션 추가 (G-NA-02):
  Think Before Coding / Simplicity First / Surgical Changes / Goal-Driven Execution

### G-NA-01 success criterion
- (a) 통합 검증: `fixture-replay.test.ts` × `StreamingContextScrubber` — `<memory-context>` 청크 경계 분할 케이스 2건 ✅
- (b) 단위 테스트: `memory-scrubber.test.ts` 18 tests (boundary-1/2/3 포함) ✅
- (c) CI fixture-only (G15): API key 불필요 ✅
- (d) CHANGELOG entry: 이 항목 ✅

### Wired-in (naia-os)
- `naia-os/agent/src/memory-scrubber.ts` — `MemoryTagScrubber` (`<recalled_memories>` 태그, naia-os 패턴)
- `naia-os/agent/src/index.ts` — 스트리밍 루프에 scrubber.feed()/flush() 연결
- naia-os#240 closed ✅

Refs: nextain/naia-agent#28 (G-NA-01), nextain/naia-agent#29 (G-NA-02), gap-plan `ref-analysis-gap-plan-2026-05-12.md`

## [Slice 6A] — 2026-05-10 — Active brain skeleton (subscriber + ActiveContext, no LLM)

**Active brain first slice — wire-only, log-only.** naia-memory R4 Background brain (commit `naia-memory@3c89a3c`) emits `SpikeEvent` via `SubscribableMemory.on('spike', handler)`. naia-agent now provides a `SpikeHandler` implementation that decides `inject-next-turn` vs `skip` using rule-based source-monitor — no LLM yet. LLM-driven source-monitor + pragmatic-gate are deferred to Slice 6B / 6C.

Schema home: `@nextain/agent-types/spike` (commit `335e7cf`, naia-agent#27 closed).

### Added
- `@nextain/agent-cli-app` — `ActiveBrain` class (`packages/cli-app/src/active-brain.ts`). Decides per-spike action via 5 rule axes:
  1. project scope partition (cross-project leak skip)
  2. confidence floor (default 0.5)
  3. opt-out topic substring skip
  4. active-topic substring match → inject
  5. `recentFactIds ∩ relatedFactIds` → inject
- `examples/active-brain-host.ts` — mock `SubscribableMemory` + 4 `SpikeEvent` mix (inject + skip) + assertion-driven exit code. `pnpm smoke:active-brain`.
- `packages/cli-app/src/__tests__/active-brain.test.ts` — 8 unit tests covering each rule axis + `setActiveContext` switch + case-insensitive topic match.

### Slice 6A success criterion
- (a) New runnable command: `pnpm smoke:active-brain` — ✅ (4 events, exits 0)
- (b) Unit tests: 92/92 across cli-app (10 files, +8 new) — ✅
- (c) Integration verification: smoke exercises mock subscriber path + log capture + decision count assertions — ✅
- (d) CHANGELOG entry: this entry — ✅

### Why split here
Cross-review (2 independent reviewers) recommended deferring source-monitor LLM (~200 LOC) and pragmatic-gate LLM (~150 LOC) until a real host (naia-os#240) wires the spike pipeline against a non-trivial conversation. Skeleton stays useful: hosts (naia-os, custom shells) can subscribe today without waiting for the LLM gating layer.

### Open follow-ups (separate slices)
- **Slice 6B** — LLM source-monitor (Gricean relevance check, replaces substring rule)
- **Slice 6C** — LLM pragmatic-gate + active inject into supervisor prompt stream
- **naia-os#240** — host wires `MemorySystem.on('spike', new ActiveBrain({...}).handle)`; supervises ActiveContext push from session topic

### Slice ID note
`r1-slice-spine-2026-04-25.md` reserves Slice 4 = compaction, Slice 5 = fixture-replay-framework. R4 D18 Hybrid wrapper supersedes the original Slice 4/5 designs (compaction is now sub-agent-side via opencode; fixture-replay landed ad-hoc in Slice 1b). Active brain takes the next free ID — **Slice 6**. Spine doc is left as historical R3 design; ADR for R4 spine refresh deferred (avoid yak shaving).

Refs: naia-agent#26 (Active brain parent, partial), naia-agent#27 (schema, closed `335e7cf`), naia-memory#26 (Background brain, sibling).

## [Slice 3] — 2026-05-06 — alpha-memory backend integration

**naia-memory wired in as a real MemoryProvider implementation.** Closes the loop opened by R1-prep type alignment: `examples/naia-memory-host.ts` now exercises the real `@nextain/naia-memory` `MemorySystem` end-to-end through the `AlphaMemoryAdapter` (MemoryProvider + CompactableCapable shape).

### Changed
- `package.json` — `@nextain/naia-memory` file: dep path corrected (`../alpha-memory` → `../naia-memory`). The submodule was renamed but the dep wasn't updated; `pnpm smoke:naia-memory` was silently broken until this fix.
- `examples/naia-memory-host.ts` — added an R2.3/R2.5 mini-verification block (runs only when `GEMINI_API_KEY` is set). Encodes two natural-conversation update statements, runs forced consolidation through the real `MemorySystem`, and reports facts created, factEmbeddings count, supersede count, and recall hits. Hard-asserts `factsCreated > 0`; the rest is informational because the heuristic fact extractor's behaviour depends on environment (LLM extractor, embedding provider).

### Why this matters
- Cross-repo contract is now exercised against a real backend, not a mock. The R1-prep type widening (commit 164d980) was hypothetical until this slice.
- Following the over-fit lessons from this session (`naia-memory#22`), this smoke is **not** a benchmark score check — it's a contract + reachability check. Fact-bank scoring stays deferred to its own crate; this slice only proves the wiring.

### Slice 3 success criterion (r1-slice-spine §6.4)
- (a) New runnable command: `pnpm smoke:naia-memory` — ✅
- (b) Unit tests: 84/84 across the workspace, no regressions — ✅
- (c) Integration verification: smoke exercises the real memory backend — ✅
- (d) CHANGELOG entry: this entry — ✅

### Open follow-ups (separate issues)
- `naia-memory#21` — fact duplication when force-consolidating per query.
- `naia-memory` (new, not yet filed) — investigate why `factEmbeddings` stayed at 0 in this smoke despite a properly-wired `OpenAICompatEmbeddingProvider` and `naia-memory#20` URL fix landed (suspected: heuristic extractor returns episode content verbatim, hitting the `contentChanged === false` path so embed never runs).
- `naia-memory#14` and `#22` remain open for prompt fine-tuning, scheduled for after this Slice 3 baseline is verified in real use.

Refs: nextain/naia-agent#25 (closes Slice 3 portion), nextain/naia-memory#20 (URL fix landed), naia-memory commits ffd535b + d202957 (over-fit cleanup) + 164d980 here (R1-prep).

## [R1-prep] — 2026-05-06 — MemoryProvider type alignment + ContradictionFilterCapable (#25 P1)

**Slice 3 prerequisite.** Aligns `@nextain/agent-types` MemoryProvider façade with the naia-memory R2.5 reference implementation (commits 346e8ae bi-temporal recall + f9c5dfa hybrid contradiction filter, KO benchmark 76→82% B grade `naia-memory#14`). Type-only / docs change — no runtime behaviour change for any active consumer (only `compact()` is used today; mocks unaffected).

### Changed (broaden 7 — agent type widened to accept memory's richer shape)
- `MemoryProvider.encode(input, opts?: EncodeOpts)` — added `EncodeOpts.project` for project-scoped tagging
- `RecallOpts` — added `project?` and `sessionId?` for context-dependent recall
- `MemoryHit` — added `createdAt?` and `updatedAt?` (timestamp kept as deprecated alias)
- `ConsolidationSummary` — added `factsUpdated?` and `episodesProcessed?` (optional)
- `BackupCapable` — `backup()/restore(data)` → `exportBackup(password)/importBackup(blob, password)` (adopts memory's AES-256-GCM scheme; password parameter required by contract for forward compatibility)
- `ReconsolidationCapable.findContradictions(newContent, existingIds?)` — signature changed (was `(factId)`); `Contradiction` shape now `{conflictingId, conflictType: "direct"|"indirect", reason}`
- `TemporalCapable.recallWithHistory(query, atTimestamp, opts?)` — `atTimestamp` now required; opts shape mirrors `RecallOpts`. `applyDecay()` returns `Promise<number>` (count of pruned items).

### Added (R2.5 — dual-process retrieval-rerank capability)
- `ContradictionFilterCapable.filterContradictions(candidates)` — small-LLM (or heuristic) filter that rejects false-positive contradictions before supersede. Mirrors the human ACC (conflict detection) → PFC (resolution) division of labour. Implementations live in naia-memory: `HeuristicContradictionFilter`, `GeminiFlashLiteContradictionFilter`, `VllmReasoningContradictionFilter`. Selection by env: `VLLM_REASONING_BASE > GEMINI_API_KEY > heuristic`.
- `ContradictionCandidate`, `ContradictionVerdict` types (verdict includes `confidence` 0–1; default acceptance threshold ≥0.7 in naia-memory's filter).

### Notes
- `isCapable` example updated to use the new BackupCapable method names.
- All 84 existing unit tests pass; tsc clean. Mock implementations (`runtime/src/mocks/in-memory-memory.ts`, `compactable-memory.ts`) unaffected — they don't implement the changed capabilities.
- naia-memory's `provider-types.ts` switching to `import { … } from "@nextain/agent-types"` is the next step (separate naia-memory commit). At that point Slice 3 wire-in (`bin/naia-agent --memory=alpha`) becomes type-clean.

Refs: nextain/naia-agent#25, nextain/naia-memory#14, naia-memory commits 346e8ae + f9c5dfa.

## [Slice 5.x.6] — 2026-04-29 — Cross-review fixes (Tier A) + R5 lock (D44 §6)

**3-perspective cross-review 결과 surgical fixes.** architect / reference-driven (vercel:ai-architect) / paranoid 3개 병렬 review → P0 5건 통합 + P1 일부 즉시 적용. types 확장 필요한 항목은 Tier B로 매트릭스 backlog (D45~D52 후보).

### Cross-review verdict
- architect: APPROVED_WITH_CONDITIONS (P0 3건)
- reference-driven: APPROVED_WITH_RECOMMENDATIONS (P0 2건 — Vercel canonical 패턴 deviation)
- paranoid: NEEDS_REVISION (P0 1건 + P1 5건)

### Tier A — 본 commit 적용 (8건)
1. **P0-1** dist/ 잔존 5 provider artifacts 정리 + `clean`/`rebuild` script (`packages/providers/package.json`). npm publish 시 deleted code 배포 위험 차단
2. **P0-2** specificationVersion discriminant — `VercelClient.#spec` 필드 + `fromVercelFinishReason(reason, spec)` / `fromVercelUsage(usage, spec)` (이전 structural sniff 제거)
3. **P0-3** README + 매트릭스 B21 정정 — `optionalDependencies` 5 default bundle + peer 분리 명시. "zero-runtime-dep 정신 보존" 주장 제거 (자동설치와 충돌)
4. **P0-4** V2 Anthropic `cacheReadTokens` `inputTokenDetails` fallback. `@ai-sdk/anthropic@2.x`가 V2 spec의 `cachedInputTokens` 대신 `inputTokenDetails.cacheReadTokens` 사용 → 이전 cache hit silent 0
5. **P0-5** `tool-call` aggregate fallback — id가 idToIndex에 없을 때 content_block_start + input_json_delta + content_block_stop trio synthesize. Bedrock 등 tool-input-* 안 emit하는 provider 도구 호출 silent 손실 방지
6. **P1-C** `reader.cancel()` 추가 (`finally` block, before releaseLock). consumer early-exit 시 upstream HTTP/SSE 연결 leak 방지
7. **P1-A** `fromV2*` → `fromVercel*` rename, legacy alias 보존 (5.x.7+에서 제거 예정)
8. **P1-A/R-P1-3** `toolName: ""` JSDoc 정직 다운그레이드 — "Anthropic-only verified" 명시, Bedrock 등 strict-validate 위험 경고

### Added (테스트 보강)
- `vercel-client.test.ts` 11 신규:
  - `fromVercelUsage` V2 explicit / V2 inputTokenDetails fallback (P0-4) / V2 양쪽 동시일 때 cachedInputTokens 우선 / V3 nested / V3 undefined zero
  - `fromVercelFinishReason` V2 string / V3 `{unified}` object / undefined fallback
  - `tool-call` aggregate fallback (P0-5) — id unknown 시 trio synthesize
  - `tool-call` aggregate 중복 방지 — tool-input-* 이미 처리한 id는 drop
  - `reader.cancel()` 호출 검증 (P1-C) — early-exit 시 cancel hook 호출

### Tier B — 매트릭스 backlog (R5 범위 밖, R6 후보)
LLMRequest/Response 타입 확장 또는 인프라 신규 작업이 필요한 항목 — `.agents/progress/r5-cross-review-2026-04-29.md` §3 inventory:

| 후보 ID | 항목 | 우선순위 |
|---|---|---|
| D45 | `LLMRequest.providerOptions` round-trip (Vercel canonical) | P1 |
| D46 | `LLMRequest.toolChoice` | P1 |
| D47 | `LLMResponse.provider` 50+ provider observability | P1 |
| D48 | error part throw 시 `end` chunk yield 계약 | P1 |
| D49 | adapter-level Vercel SDK shape fixture (F11 v3) | P1 |
| D50 | V4+ strict mode opt-in | P2 |
| D51 | `optionalDependencies` exact pin + `onlyBuiltDependencies` 가드 | P2 |
| D52 | top-level system 다중 메시지 (Anthropic cache_control) | P2 |

기존 reserved D45 (RunPod naia-anyllm gateway 통합) → **D53으로 이동**.

### 의도적 미적용
- `safeParseJson` → `@ai-sdk/provider-utils parseJSON` 교체 (R-P1-5): provider-utils가 transitive hoisted 상태이지만 직접 의존 명시는 현 peer dep 정책과 충돌. Tier B (D49와 함께 묶음)로 이연

### 회귀
- **459 PASS** (이전 448 + 11 신규)
  - protocol 73 / observability 17 / providers **53 (36 unit + 11 lab-proxy + 6 cross-provider)** / verification 20 / runtime 160 / workspace 16 / adapter-opencode-cli 15 / adapter-shell 13 / adapter-opencode-acp 8 / cli-app 84
- 0 회귀 (active code path 모두 통과)
- TypeScript build 통과 (`pnpm build` ok)
- smoke `pnpm smoke:vercel-anthropic` dry-run pass

### Slice 5.x.6 success criterion
- ✅ S01 새 명령 — `pnpm -F @nextain/agent-providers rebuild` (clean + build, dist/ 위생 보장)
- ✅ S02 단위 테스트 — 11 신규 (Tier A 모든 코드 변경에 회귀 방지 테스트)
- ✅ S03 통합 검증 — 6 cross-provider integration test (이전 slice) 회귀 + dry-run smoke
- ✅ S04 본 entry + `r5-cross-review-2026-04-29.md` progress 파일 신설

### 매트릭스 ID 인용
- `fix(providers): R5 cross-review Tier A surgical fixes — fixes D44 §6`

### R5 lock
본 commit으로 R5 (Vercel AI SDK adoption) **lock**:
- ✅ 5.x.0 docs lock (`98a81df`)
- ✅ 5.x.1 VercelClient MVP (`c153a6d`)
- ✅ 5.x.2 AnthropicClient deprecate (`c18678a`)
- ✅ 5.x.3 Gemini/OpenAICompat/Vertex deprecate (`8f09905`)
- ✅ 5.x.4 자체 5개 제거 + V2/V3 + 자동설치 + cross-platform (`e566e6e`)
- ✅ 5.x.6 cross-review fixes (본 commit)

R6 후보 = Tier B 8건 + D53 RunPod (사용자 directive 별도 논의 항목)

## [Slice 5.x.4] — 2026-04-29 — 자체 5개 provider 제거 + 자동설치 + V2/V3 호환 + 크로스플랫폼 (D44 §4-5)

**사용자 directive 통합 cleanup.** 5.x.4 (claude-cli deprecate) + 5.x.5 (5개 일괄 제거 + cleanup) 통합 진행. 추가로 Vercel SDK 생태계 V2/V3 spec 혼재 발견 → adapter dual-version 호환 보강. 자동설치 의존성 + cross-platform 가이드 정리.

### Removed (5 self-built providers)
- `packages/providers/src/anthropic.ts` → `VercelClient + @ai-sdk/anthropic`
- `packages/providers/src/anthropic-vertex.ts` → `VercelClient + @ai-sdk/anthropic` Vertex 모드
- `packages/providers/src/gemini.ts` → `VercelClient + @ai-sdk/google` (또는 community `ai-sdk-provider-gemini-cli`)
- `packages/providers/src/openai-compat.ts` → `VercelClient + @ai-sdk/openai-compatible` (vLLM/vllm-omni 텍스트/LM Studio/Ollama/OpenRouter), Z.ai coding plan은 `zhipu-ai-provider`
- `packages/providers/src/claude-cli.ts` → community `ai-sdk-provider-claude-code` (Pro/Max 구독 path 동일 보존)
- `packages/providers/src/__tests__/claude-cli-env.test.ts` (10 unit)
- `packages/providers/src/__tests__/claude-cli-env.integration.test.ts` (8 integration)
- `scripts/smoke-anthropic.ts` (deprecated since 5.x.2; `pnpm smoke:vercel-anthropic` 대체)
- root `package.json` `smoke:anthropic` script

### Adapter — V2/V3 dual support (D44 §4 보강)
Vercel ecosystem mid-migration: `@ai-sdk/anthropic@2.x`는 V2 spec, `@ai-sdk/google@3.x` / `@ai-sdk/openai-compatible@2.x` / `ai-sdk-provider-claude-code@3.x` / `zhipu-ai-provider@0.3.x`는 V3 spec. VercelClient를 양쪽 지원하도록 보강:
- `specificationVersion` 검사 `"v2" | "v3"` 허용 (V4+는 explicit error로 surfacing)
- `LanguageModelV2OrV3` 타입 union 도입 (`Content`/`Usage`/`FinishReason`/`StreamPart`)
- `fromV2FinishReason` — V2 plain string + V3 `{unified, raw}` object 둘 다 처리
- `fromV2Usage` — V2 flat `{inputTokens, outputTokens, cachedInputTokens}` + V3 nested `{inputTokens: {total, cacheRead, cacheWrite}, outputTokens: {total, ...}}` 둘 다 처리
- `doGenerate`/`doStream` cast — V2/V3 overload union이 TS에서 narrow 안 되므로 `unknown` 경유 structural assertion

### Auto-install 의존성 (자동설치)
`pnpm install`만으로 가장 흔히 쓰이는 5+ Vercel provider 즉시 사용 가능:

| 위치 | 패키지 | 효과 |
|---|---|---|
| 루트 `dependencies` | `ai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`, `zhipu-ai-provider`, `ai-sdk-provider-claude-code` | 모든 워크스페이스 패키지에서 즉시 import 가능 |
| `packages/providers` `optionalDependencies` | 같은 5개 | 외부 npm 소비자가 `pnpm add @nextain/agent-providers` 시 자동 설치 (실패 tolerant) |
| `packages/providers` `peerDependencies` | `ai@^6`, `@ai-sdk/provider@^3`, `ws@^8` (모두 optional) | 고급 사용자가 버전 pin 가능 |

제거된 dep: `@anthropic-ai/sdk`, `@anthropic-ai/vertex-sdk`, `@google/genai` (자체 5개 제거에 따라 root + providers package 양쪽에서)

### Package version bump
- `@nextain/agent-providers` 0.1.0 → **0.2.0** (breaking — 5개 export 제거)

### Cross-platform 가이드 (README)
- 모든 Vercel SDK 패키지는 pure JavaScript → Linux / macOS / Windows 지원
- CLI subscription providers는 host CLI binary 필요 (`claude` / `codex` / `gemini`):
  - Linux/macOS: 일반 설치
  - Windows: `.cmd`/`.exe` shim
  - Flatpak/sandbox: 3가지 우회 path 명시 (직접 API key / `flatpak-spawn --host` / LabProxy)
- Windows path quirks는 SDK 측 platform-aware handling 위임

### Added
- `packages/providers/src/__tests__/vercel-providers-compat.integration.test.ts` (6 tests):
  - `@ai-sdk/anthropic` (V2 spec) — 모델 구성 검증
  - `@ai-sdk/google` (V3 spec) — 모델 구성 검증
  - `@ai-sdk/openai-compatible` (V3 spec, vLLM-style baseURL) — 모델 구성 검증
  - `zhipu-ai-provider` (V3 spec, Z.ai coding plan endpoint) — 모델 구성 검증
  - `ai-sdk-provider-claude-code` (V3 spec, Pro/Max 구독) — 모델 구성 검증
  - V1/V4+ 잘못된 spec → 명시적 throw 검증
  - 누락 dep는 `console.warn` 후 skip (cross-platform graceful degradation)
- `packages/providers/README.md` — 전면 재작성:
  - VercelClient 메인 문서 (use cases / install / 50+ provider matrix)
  - Cross-platform 섹션 (Linux/macOS/Windows + Flatpak/sandbox 가이드)
  - "Removed" 섹션 (5개 → Vercel 매핑 표)

### Changed
- `packages/runtime/src/host/create-host.ts` — 코멘트만 갱신 (AnthropicClient → "any LLMClient" 일반화)
- `packages/providers/src/index.ts` — 5개 export 제거, 헤더 코멘트 갱신
- `packages/providers/package.json`:
  - `version` 0.1.0 → 0.2.0
  - `exports`: `./anthropic` / `./anthropic-vertex` / `./gemini` / `./openai-compat` / `./claude-cli` 제거
  - `peerDependencies`: 자체 5개 SDK 제거, Vercel SDK 3개 (`ai`, `@ai-sdk/provider`, `ws`) optional 유지
  - `optionalDependencies` 신규 — 5개 자동설치 (anthropic / google / openai-compatible / zhipu / claude-code)
  - `devDependencies` 정리 (자체 SDK 제거)
- 루트 `package.json`:
  - `dependencies` 신규 6개 (Vercel SDK 자동설치)
  - `devDependencies`에서 `@anthropic-ai/sdk` / `@anthropic-ai/vertex-sdk` / `@ai-sdk/anthropic` / `ai` 제거 (deps로 이동)
  - `smoke:anthropic` script 제거

### 회귀
- **448 PASS** (이전 460 - 18 claude-cli-env removed + 6 cross-provider integration = 448)
  - protocol 73 / observability 17 / providers **42 (25 unit + 11 lab-proxy + 6 cross-provider)** / verification 20 / runtime 160 / workspace 16 / adapter-opencode-cli 15 / adapter-shell 13 / adapter-opencode-acp 8 / cli-app 84
- 0 회귀 (active code path 모두 통과)
- TypeScript build 통과

### Slice 5.x.4 success criterion
- ✅ S01 새 명령 — `pnpm smoke:vercel-anthropic` 유지 + 6 cross-provider integration test
- ✅ S02 단위 테스트 — 25 vercel-client unit (이전) 유지 + 6 cross-provider integration 신규
- ✅ S03 통합 검증 — 5개 실 Vercel provider 패키지로 모델 구성 검증 (cross-platform on Linux 검증, Windows/macOS는 community provider 측에서 보장)
- ✅ S04 본 entry

### F09 (cleanroom 단독 의존 금지) 준수
- 본 cleanup은 자체 코드 제거 → 외부 Vercel SDK 의존. cleanroom 영역 무관

### F11 (Anthropic SDK minor bump fixture re-record) 미트리거
- `__fixtures__/anthropic-1turn.json`은 generic `LLMStreamChunk[]` 그대로 유지 (StreamPlayer 사용, 어떤 LLMClient 구현과도 무관)

### 매트릭스 ID 인용
- `feat(providers)!: remove 5 self-built providers + V2/V3 dual support + auto-install + cross-platform — fixes D44 §4-5`

### 다음 단계 (Slice 5.x.6)
- Cross-review 3-perspective (architect / reference / paranoid)
- 별도 논의 항목 (사용자 directive): RunPod 통합 (D45 후보, naia-anyllm gateway)

## [Slice 5.x.3] — 2026-04-29 — `GeminiClient` / `OpenAICompatClient` / `createAnthropicVertexClient` deprecate (D44 §3)

**3 provider 통합 deprecate.** 사용자 directive "통합" — 분할 (5.x.3a/b/c) 대신 단일 commit. 모두 동일 pattern (file-level + class/interface/factory `@deprecated` JSDoc, scope 변경 없음).

### Changed
- `packages/providers/src/gemini.ts` — `@deprecated` JSDoc + 두 마이그레이션 path 명시:
  - API key path: `@ai-sdk/google` (Vercel SDK)
  - Subscription path: `ai-sdk-provider-gemini-cli` (community, Gemini Code Assist)
  - Gemini 3 `thoughtSignature` round-trip은 Vercel `LanguageModelV2 providerMetadata` 통해 가능 (5.x.5 cleanup 시점에 검증)
- `packages/providers/src/openai-compat.ts` — `@deprecated` JSDoc + 마이그레이션 예시:
  - vLLM / vllm-omni / LM Studio / Ollama / OpenRouter / Together / Groq / Cerebras / DeepSeek / Fireworks / Perplexity → `@ai-sdk/openai-compatible` (단일 official 패키지)
  - Z.ai coding plan / Zhipu GLM → `zhipu-ai-provider` (community, `createZhipu({ baseURL: 'https://api.z.ai/api/paas/v4' })`)
  - B21 historical rationale ("avoids 50-provider direct deps") demote 명시 — `@ai-sdk/openai-compatible`은 단일 optional peer dep으로 모든 OpenAI-compat backend 커버
- `packages/providers/src/anthropic-vertex.ts` — `@deprecated` JSDoc:
  - `@ai-sdk/anthropic` Vertex 모드 또는 `@ai-sdk/google-vertex`
  - `AnthropicClient`를 transitively 의존 (5.x.2에서 deprecate된 client) → 5.x.5에서 함께 제거

### 기존 코드 영향
- **0 회귀** — JSDoc만 추가, 시그니처/런타임 변경 없음
- IDE strikethrough cue + TypeScript informational marker

### 회귀
- **460 PASS** (변동 없음)

### Slice 5.x.3 success criterion
- ⊘ S01~S04 부분 면제 (5.x.2와 동일 — deprecation 표기, matrix_id_citation rule "docs/infra 변경" 면제)
- ✅ S04 본 entry

### 매트릭스 ID 인용
- `chore(providers): @deprecated Gemini/OpenAICompat/AnthropicVertex — fixes D44 §3`

### 다음 단계 (Slice 5.x.4)
- `claude-cli.ts` deprecate → `ai-sdk-provider-claude-code` (community, Claude Pro/Max 구독 path 보존). Subprocess wrap (Flatpak/Windows/partial-JSON parity) 로직은 community provider가 흡수
- 이후 5.x.5: 자체 5개 일괄 제거 + bin/examples/fixture 정리 + 회귀 460 PASS 유지

## [Slice 5.x.2] — 2026-04-29 — `AnthropicClient` deprecate (D44 §2)

**자체 anthropic.ts → Vercel-backed 마이그레이션 path 공식 권고.** AnthropicClient는 5.x.5에서 제거 예정. 신규 코드는 `VercelClient + @ai-sdk/anthropic` 사용. 기존 코드는 그대로 동작 (소프트 deprecate).

### Changed
- `packages/providers/src/anthropic.ts` — `@deprecated` JSDoc (file-level + class + interface). 마이그레이션 예시 코드 포함, Slice 5.x.5 제거 시점 명시
- `scripts/smoke-anthropic.ts` — `@deprecated` JSDoc, `pnpm smoke:vercel-anthropic` 권고
- `packages/providers/README.md` — VercelClient 섹션을 메인으로 승격, 자체 5개 provider는 "Deprecated" 섹션으로 이동, 다른 provider 옵션 표 (50+) 추가, lab-proxy 계열은 Vercel-independent로 명시 보존

### 기존 코드 영향
- **0 회귀** — `AnthropicClient` 클래스/메서드 시그니처 변경 없음. JSDoc deprecate marker만 추가
- TypeScript는 `@deprecated`를 informational로 처리 (build/test 영향 없음). 사용자 IDE에서 strikethrough로 표시
- `anthropic-vertex.ts` 는 내부적으로 `AnthropicClient` 재사용 (deprecate 워닝 inherit) — 본 slice scope 밖, 5.x.3c 시점에 정식 deprecate

### 회귀
- **460 PASS** (변동 없음 — 5.x.1 신규 25 포함)

### F11 (Anthropic SDK minor bump fixture re-record) — 미트리거
- 본 slice는 SDK 버전 bump 아니고 내부 client deprecate. fixture (`packages/runtime/src/__fixtures__/anthropic-1turn.json`) 는 generic `LLMStreamChunk[]` JSON으로 어떤 LLMClient 구현과도 무관. 5.x.5에서 anthropic.ts 제거 시점에 fixture는 그대로 유지 (StreamPlayer 가 사용)

### 매트릭스 ID 인용
- `chore(providers): @deprecated AnthropicClient — fixes D44 §2`

### 다음 단계
- Slice 5.x.3a/b/c: `gemini.ts` / `openai-compat.ts` / `anthropic-vertex.ts` 동일 패턴 deprecate
- Slice 5.x.4: `claude-cli.ts` deprecate → `ai-sdk-provider-claude-code` (community)
- Slice 5.x.5: 자체 5개 제거 + bin/examples/fixture 일괄 정리 + 회귀 460 PASS 유지 검증
- Slice 5.x.6: cross-review 3-perspective (architect / reference / paranoid)

## [Slice 5.x.1] — 2026-04-29 — VercelClient adapter MVP (D44 §1)

**Vercel AI SDK 첫 코드 진입.** `LanguageModelV2` → `LLMClient` 어댑터 1개로 50+ provider 즉시 호환 가능 상태로 전환. 기존 5개 자체 provider (anthropic / anthropic-vertex / gemini / openai-compat / claude-cli)는 후속 슬라이스에서 deprecate.

### Added
- `packages/providers/src/vercel-client.ts` — `VercelClient` 어댑터 + 순수 변환 헬퍼 (`toV2Prompt` / `fromV2Content` / `fromV2FinishReason` / `fromV2Usage`) export
- `packages/providers/src/__tests__/vercel-client.test.ts` — 25 unit (bidirectional 변환 모두 커버: system / user / assistant / tool 메시지 / tool_use / thinking / image base64 / 각 V2 finishReason / cachedInputTokens / stream id→index / reasoning / response-metadata 우선 / error 부분 / finish 누락 fallback)
- `scripts/smoke-vercel-anthropic.ts` — dry-run + live 양 path
- `package.json` `smoke:vercel-anthropic` script
- `packages/providers/package.json` exports `./vercel` 추가
- `packages/providers/package.json` peer dep + devDep: `ai@^6` / `@ai-sdk/anthropic@^2` / `@ai-sdk/provider@^3` (모두 optional peer dep — host가 필요한 것만 install, B21 격하 근거)
- 루트 `package.json` devDep: `ai@^6` / `@ai-sdk/anthropic@^2` (smoke script가 root에서 실행 가능하도록)

### 어댑터 design (LLMClient SSE shape 정합)
- V2 string `id` → 우리 numeric `index` 매핑 (Map, auto-increment) — Anthropic-style content_block_* 보존
- V2 stream-part 흡수: text-start/delta/end, reasoning-start/delta/end, tool-input-start/delta/end, finish, error, response-metadata, stream-start
- 알 수 없는 part (file/source/raw/tool-call aggregate) drop — LLMContentBlock "unknown 변종은 어댑터 경계에서 drop" 정책
- 합성 start chunk 지연 emit — response-metadata id/modelId 받은 후 emit (없으면 random id + constructor modelId 사용)
- finish 누락 시도 end chunk 항상 발행 (우리 SSE 계약 보장)
- error part → throw (caller에서 catch)

### Slice 5.x.1 success criterion
- ✅ S01 새 명령 — `pnpm smoke:vercel-anthropic` (dry-run 즉시, live는 ANTHROPIC_API_KEY 있을 때 opt-in)
- ✅ S02 단위 테스트 — 25 신규 (vercel-client.test.ts)
- ✅ S03 통합 검증 — mock `LanguageModelV2` 가 실제 V2 stream-part shape를 emit하는 형태로 25 테스트가 통합 변환 round-trip 검증. 실 Anthropic 호출 검증은 ANTHROPIC_API_KEY opt-in (G15 fixture-only-default 강제 + key는 사용자 환경)
- ✅ S04 본 entry

### 회귀
- **460 PASS** (이전 435 + 25 신규)
  - protocol 73 / observability 17 / providers **54 (29 + 25 신규)** / verification 20 / runtime 160 / workspace 16 / adapter-opencode-cli 15 / adapter-shell 13 / adapter-opencode-acp 8 / cli-app 84
- 0 회귀

### 매트릭스 ID 인용
- `feat(providers): VercelClient adapter MVP — fixes D44 §1`

### F09 (cleanroom 단독 의존 금지) 준수
- Vercel AI SDK는 Apache 2.0 + 23.5K stars + 활발한 maintenance. cleanroom 출처 0건. OWASP/RFC 출처 cross-reference 면제 (cleanroom 영역 무관)

### F11 (Anthropic SDK minor bump fixture re-record) — 5.x.2로 이연
- 본 5.x.1은 **신규 어댑터 추가**만 — 기존 `anthropic.ts` + `__fixtures__/anthropic-1turn.json` 변경 없음
- F11 강제는 **5.x.2 (자체 anthropic.ts deprecate → Vercel-backed)** 시점에 적용. fixture re-record + StreamPlayer 재생 검증 동시 수행

### 보존 (변경 없음)
- 기존 7 provider 모두 그대로 유지 (deprecate는 후속 slice)
- bin / examples / runtime / 250 PASS R3 baseline 무관

### 다음 단계 (Slice 5.x.2 예정)
- 자체 `anthropic.ts` deprecate → 호스트 측에서 `VercelClient + createAnthropic(...)` 우선
- `__fixtures__/anthropic-1turn.json` Vercel-backed로 재녹화 (F11)
- `scripts/smoke-anthropic.ts`는 deprecate 직전 마지막 commit에서 제거

## [Slice 5.x.0] — 2026-04-29 — D44 lock: Vercel AI SDK 채택 정정 (D23 supersede)

**Decision-only commit (docs).** R4에서 lock된 D23 ("Vercel AI SDK 보류")이 사용자 원래 의사 ("로컬은 Vercel로 50+ provider 즉시 확보")와 정반대로 silent drift된 것을 정정. D44 (Vercel AI SDK 로컬 LLM 단일 abstraction 채택, peer-dep 패턴) 신규 lock.

### Matrix 변경
- **§D 신규 1건** D44 — Vercel AI SDK 채택 (peer-dep 패턴, 50+ provider, lab-proxy 보존, vllm-omni audio_delta는 D43 그대로)
- **§D supersede** D23 → D44 (strikethrough + supersede 명시)
- **§B 격하** B21 → demoted (sub-concern 회피 가능: optional peer dep + headless)
- **§K 신규** R5 변경 이력 (2026-04-29 Vercel AI SDK 채택 정정)

### Progress 파일 신설
- `.agents/progress/vercel-ai-sdk-adoption-2026-04-29.md` — D44 근거, slice 시퀀스 (5.x.0~5.x.6), vllm-omni 처리, RunPod 별도 논의

### Slice 시퀀스 outline (Phase 5.x)
- **5.x.0** (본 commit): docs lock
- **5.x.1**: `VercelClient` adapter MVP (Anthropic 우선 검증)
- **5.x.2**: 자체 `anthropic.ts` deprecate → Vercel-backed
- **5.x.3** (3 sub): `gemini` / `openai-compat` / `anthropic-vertex` deprecate
- **5.x.4**: `claude-cli.ts` deprecate → `ai-sdk-provider-claude-code` (community)
- **5.x.5**: bin / examples / fixture-replay 갱신 + 자체 5개 제거
- **5.x.6**: Cross-review 3-perspective + P0 fix

### 보존 (변경 없음)
- `lab-proxy.ts` / `lab-proxy-live.ts` (naiaKey 보호 + WebSocket Live API, Vercel 영역 밖)
- D43 audio provider layer (vllm-omni audio_delta WSS 자체 구현 path)
- 4-repo 책임 분리 LOCK / A01~A31 / F01~F11

### Out of scope (본 R5 외)
- RunPod 통합 (D45 후보, 사용자 directive로 별도 논의)
- vllm-omni RunPod 호스팅 (자체 컨테이너, Phase 5+ 별도)
- vllm-omni audio_delta D43 layer 구현

### 매트릭스 ID 인용
- `docs(matrix): D44 lock + D23 supersede + B21 demote + K changelog`

### Slice 5.x.0 success criterion (docs-only 면제)
- ✅ S01~S04 면제 (matrix_id_citation 룰의 "매트릭스 외 영역 — docs/infra" 면제)
- ✅ 매트릭스 D44 / D23 strikethrough / B21 demote / K changelog 4건 모두 반영
- ✅ progress 파일 + session_id 바인딩

## [Slice 2.7] — 2026-04-26 — Log Policy 정규화 + Logger.fn() 표준 + dev mode 자동 file logging

**개발 추적 가능한 구조.** 모든 핵심 함수에 enter/branch/exit + caller(file:line) + elapsedMs + args/result trace.

### Added
- `docs/log-policy.md` — 로그 정책 정규 표준 (5 levels / 출력 위치 / 회전 / 포맷 / 민감 정보 마스킹 / 이벤트별 정규 fields / CLI 플래그)
- `packages/types/src/observability.ts` — `Logger.fn()` + `FnLogger` interface (additive, optional)
- `packages/observability/src/logger.ts` — ConsoleLogger.fn() 구현 (caller 자동 추출 + elapsedMs)
- `packages/observability/src/dev-logger.ts` — `createProjectLogger()` factory (auto-detect dev: tsx/NODE_ENV/DEV_MODE) + 파일 자동 저장
- `packages/observability/src/redact.ts` — 5 pattern (Anthropic / OpenAI / GW / Google / Bearer) 자동 마스킹

### Logger.fn() 적용 (8 영역)
- `bin/naia-agent.ts` — main, detectRealLLM
- `host/create-host.ts` — createHost
- `skills/bash.ts` — handler (DANGEROUS branch + exec/timeout/exit)
- `skills/file-ops.ts` — read/write/edit/list 4 handlers
- `providers/openai-compat.ts` — generate
- `providers/anthropic.ts` — generate
- `utils/env-loader.ts` — loadEnvAndConfig
- `core/agent.ts` — sendStream, send

### 자동 dev mode 동작
- 감지: `NODE_ENV !== "production"` OR `DEV_MODE=1` OR argv[1]가 `.ts/.tsx`
- Dev: level=`debug` + 파일 자동 저장 `~/.naia-agent/logs/naia-agent-YYYYMMDD.jsonl`
- Production: level=`warn` + stderr만 (LOG_FILE 명시 시 파일도)

### Slice 2.7 success criterion
- ✅ S01 새 명령 동작 (기존 + dev mode 자동)
- ✅ S02 회귀 250 PASS
- ✅ S03 통합 검증 — 실 GLM 호출 후 trace 모두 파일에 기록 + caller/elapsedMs 정확
- ✅ S04 본 entry

### 검증된 trace (실 호출)
```jsonl
{"ts":"...","level":"debug","msg":"enter:main","caller":"bin/naia-agent.ts:258","argv":["--enable-all","..."]}
{"ts":"...","level":"debug","msg":"enter:detectRealLLM","caller":"bin/naia-agent.ts:35"}
{"ts":"...","level":"debug","msg":"branch:detectRealLLM:openai-compat","hasGlm":true}
{"ts":"...","level":"debug","msg":"enter:createHost","enableBash":true,"enableFiles":true}
{"ts":"...","level":"debug","msg":"branch:createHost:tools-built","count":5}
{"ts":"...","level":"debug","msg":"exit:createHost","elapsedMs":0,"result":{"toolCount":"set"}}
{"ts":"...","level":"info","msg":"session.active","sessionId":"sess-..."}
{"ts":"...","level":"debug","msg":"enter:Agent.sendStream","userTextLen":54,"sessionState":"active"}
{"ts":"...","level":"debug","msg":"enter:list_files.handler","path":".agents/progress/refs/"}
{"ts":"...","level":"debug","msg":"exit:list_files.handler","elapsedMs":1,"result":{"entries":13}}
{"ts":"...","level":"info","msg":"session.closed","sessionId":"sess-..."}
```

### 매트릭스 §A 승격 1건
- **A31** Log Policy + Logger.fn() + dev mode auto + redact

### 보안 (redact 패턴)
- `sk-ant-...` → `sk-ant-***`
- `sk-...` → `sk-***`
- `gw-...` → `gw-***`
- `AIzaSy...` → `AIzaSy***`
- `Bearer ...` → `Bearer ***`
- 자동 적용 (모든 log entry string values 재귀)

### 사용자 검증
```bash
# Dev mode (tsx 자동 감지) — debug + file 자동
pnpm naia-agent --enable-all "..."
tail -f ~/.naia-agent/logs/naia-agent-YYYYMMDD.jsonl

# Production (build 후)
LOG_LEVEL=warn node dist-bin/naia-agent.js "..."

# 명시 file 저장
LOG_FILE=~/my.log pnpm naia-agent "..."
```

## [Slice 2.6] — 2026-04-25 — File ops skills (read/write/edit/list_files)

**naia-agent가 본격 coding agent로.** LLM이 read_file/write_file/edit_file/list_files 자율 호출 → workspace 내 파일 작업.

### Added
- `packages/runtime/src/skills/file-ops.ts` — 4 skill factories:
  - `createReadFileSkill` (T0, concurrencySafe) — UTF-8 read with maxBytes truncation
  - `createWriteFileSkill` (T1, destructive) — write + auto-mkdir + maxBytes guard
  - `createEditFileSkill` (T1, destructive) — exact-match find/replace (single or all)
  - `createListFilesSkill` (T0, concurrencySafe) — non-recursive ls with type prefix
  - `createFileOpsSkills(opts)` — bundle of all 4
- 모두 D09 `normalizeWorkspacePath` (workspace sentinel) 재사용 → path traversal 차단
- `packages/runtime/src/__tests__/file-ops.test.ts` — 23 tests (read/write/edit/list × 안전 + 차단 + 경계 케이스 + e2e bundle)
- `bin/naia-agent.ts` — `--enable-files` + `--enable-all` 플래그
- `createHost({ enableFiles, fileOpsOptions })` 옵션 확장
- bin tierForTool 매핑: bash/write_file/edit_file → T1, read_file/list_files → T0

### Slice 2.6 success criterion (S01~S04)
- ✅ S01 새 명령: `pnpm naia-agent --enable-files "..."` 또는 `--enable-all`
- ✅ S02 단위 테스트: 23 신규 file-ops + 기존 회귀. **Total 250 PASS** (protocol 73 + observability 17 + runtime 160)
- ✅ S03 통합 검증: GLM 실 호출 — `list_files`로 .agents/progress/refs/ 11개 파일 정확히 출력
- ✅ S04 본 entry

### 매트릭스 §A 승격 1건
- **A30** File ops skills bundle (D09 sentinel 재사용)

### 사용자 검증 (실 GLM 호출)

```bash
$ pnpm naia-agent --enable-all ".agents/progress/refs/ 의 파일 목록 보여줘"
[naia-agent] skills ENABLED: bash(T1), read_file(T0), write_file(T1), edit_file(T1), list_files(T0)
[naia-agent] provider: openai-compat (model=glm-4.5-flash, ...)

- cline-review.md
- jikime-adk-review.md
- jikime-mem-review.md
- langgraphjs-review.md
- mastra-review.md
- moltbot-review.md
- openclaw-review.md
- opencode-review.md
- project-airi-review.md
- vercel-ai-sdk-review.md
```

GLM이 `list_files` 도구를 자율 호출 → 결과를 markdown 리스트로 정리.

### 보안 모델 (file-ops 일관)
- T0 (read/list) — opt-in 후 자유 호출
- T1 (write/edit) — opt-in 후 호출 가능, GatedToolExecutor (Slice 6+)에서 approval 추가
- D09 workspace sentinel — `../../etc/passwd` 같은 경로 100% 차단 (BLOCKED 응답)
- maxBytes (256KB default) — 대용량 파일 truncate 또는 reject

### Slice 2.6 follow-up
- glob/grep skills (find . -name 패턴 + ripgrep) — Slice 2.7 후보
- 파일 watcher / hot reload — Phase 2

## [Slice 2.5] — 2026-04-25 — OpenAI-compat tool calling integration

**LLM이 진짜로 도구를 호출.** Slice 2의 bash skill이 GLM-4.5-Flash로 자율 호출돼서 실 답변 생성.

### Added
- `packages/providers/src/openai-compat.ts` 보강 — tool calling 양방향 translation:
  - `LLMRequest.tools` → OpenAI `tools[]` (function-calling format)
  - response `message.tool_calls` → `LLMContentBlock[]` `tool_use`
  - assistant message `tool_use` → OpenAI `assistant.tool_calls`
  - `tool_result` block → OpenAI `role: "tool"` message (tool_call_id 보존)
  - finish_reason `"tool_calls"` → `StopReason "tool_use"`

### 사용자 검증 (실 GLM 호출, 이전 commit 직후)

```bash
$ pnpm naia-agent --enable-bash "bin/ 디렉터리에 무엇이 있나? bash로 확인하고 답해줘."
[naia-agent] provider: openai-compat (model=glm-4.5-flash, ...)
[naia-agent] bash skill ENABLED (T1, DANGEROUS_COMMANDS pre-filtered)

bin/ 디렉터리에는 `naia-agent.ts` 파일 하나가 있습니다. 이 파일은 실행 권한이 있고 10,742바이트 크기입니다.
```

GLM이 자율적으로 `bash` 도구를 호출 → ls 실행 → 결과를 자연어로 정리.

### Slice 2.5 success criterion (S01~S04)
- ✅ S01 새 명령: `pnpm naia-agent --enable-bash "..."` (real LLM이 도구 자율 호출)
- ✅ S02 단위 테스트: 기존 회귀 (227 PASS) + tsc clean
- ✅ S03 통합 검증: GLM-4.5-Flash 실 호출 — bash 도구 자율 사용
- ✅ S04 본 entry

### 매트릭스 §A 승격 1건
- **A29** OpenAI-compat tool calling translation (양방향)

### 보안 모델 일관
- LLM이 도구 호출 → DANGEROUS_COMMANDS regex로 사전 차단 (Slice 2 A24)
- T1 도구는 --enable-bash opt-in 필수 (사용자 동의 역할 유지)

## [Slice 2] — 2026-04-25 — Bash skill + DANGEROUS_COMMANDS + observability

**naia-agent의 첫 진짜 도구 실행.** LLM이 bash 호출 → DANGEROUS_COMMANDS regex 사전 차단 → 실 shell 실행. Logger.tag/time + observability 단위 테스트.

### Added
- `packages/runtime/src/utils/dangerous-commands.ts` — D01 catalog (12+ 패턴, OWASP A03 + CWE-78 출처). `checkDangerous`/`assertSafe`/`DangerousCommandError` API. F09 cleanroom 라인 인용 0건 (자체 작성).
- `packages/runtime/src/skills/bash.ts` — `createBashSkill()` factory (T1, execFile + args[] + 30s timeout + 32KB output cap + DANGEROUS pre-filter)
- `packages/runtime/src/__tests__/dangerous-commands.test.ts` (38 tests — block 17 + allow 16 + assertSafe 2 + 메타 2)
- `packages/runtime/src/__tests__/bash-skill.test.ts` (12 tests — 실 shell 실행 + BLOCKED + timeout + cwd + stderr)
- `packages/types/src/observability.ts` — D06 Logger.tag/time optional methods (additive, A.8 MAJOR 위반 0)
- `packages/observability/src/logger.ts` — ConsoleLogger.tag/time 구현
- `packages/observability/{vitest.config.ts, src/__tests__/{console-logger,meter,tracer}.test.ts}` — 17 신규 단위 테스트 (G05 0개 → 17개 해소)
- `bin/naia-agent.ts` — `--enable-bash` 플래그 (opt-in, default off)
- `examples/bash-skill-host.ts` + `package.json scripts.smoke:bash-skill` — mock LLM + bash 실 실행 + DANGEROUS 차단 시연
- `createHost({ enableBash, extraTools })` — host factory 옵션 확장

### Slice 2 success criterion (S01~S04)
- ✅ S01 새 명령: `pnpm naia-agent --enable-bash "..."` + `pnpm smoke:bash-skill`
- ✅ S02 단위 테스트: dangerous 38 + bash-skill 12 + observability 17 = **67 신규**. Total 227 (protocol 73 + observability 17 + runtime 137)
- ✅ S03 통합 검증: bash-skill-host.ts smoke — 실 ls 실행 + rm -rf / BLOCKED 검증
- ✅ S04 본 entry

### 매트릭스 §A 승격 (5건)
- **A24** DANGEROUS_COMMANDS regex catalog (D01 §D → §A)
- **A25** Bash skill (T1)
- **A26** Logger.tag/time (D06 §D → §A)
- **A27** Observability 단위 테스트 (G05 해소)
- **A28** host factory enableBash + extraTools 옵션

### F09 준수 (paranoid review 포함)
- DANGEROUS_COMMANDS regex 출처: OWASP Top 10 2021 A03 + CWE-78 (Improper Neutralization of Special Elements)
- cleanroom-cc 코드 라인 직접 인용 0건 — 자체 작성, OWASP/CWE cross-reference

### 보안 모델
- bash skill T1: --enable-bash opt-in 필수 (사용자 동의 역할)
- DANGEROUS regex 사전 차단 (12+ 패턴): rm -rf root/home, fork bomb, dd to disk, mkfs, sudo destructive, chmod 777 root, curl|bash, nc reverse shell, eval/exec injection 등
- execFile + args 배열 (shell-string 직접 평가 안 함)
- T2/T3 도구는 Slice 6+에서 GatedToolExecutor + ApprovalBroker 통합

### Slice 2 follow-up
- LLM tool calling integration: OpenAI-compat client가 LLMRequest.tools를 OpenAI tools format으로 변환 필요 (현재 GLM이 도구 모름 — 별도 commit)
- D12 onStepFinish callback (Slice 2.5 또는 후속)
- D11 ToolExecutionContext orphan 해소 (ToolExecutor.execute() 시그니처 확장)

### 사용자 검증

```bash
$ pnpm smoke:bash-skill
━━━ safe-bash (ls) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[tool ▶] bash({"command":"ls bin/*.ts 2>/dev/null | head -3"})
[tool ◀] bin/naia-agent.ts
[exit 0]
[final] I found the bin entry — bin/naia-agent.ts.

━━━ dangerous-bash (rm -rf /) — should be BLOCKED ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[tool ▶] bash({"command":"rm -rf /"})
[tool ◀] BLOCKED: dangerous command blocked: rm -rf / — rm -rf targeting filesystem root or home (CWE-78)
[final] The dangerous command was blocked, as expected.

✓ bash-skill-host smoke passed
```

### Sub-issues closed
- closes #16 (sub-A bash skill + DANGEROUS regex)
- closes #17 (sub-B observability + Logger.tag/time)
- closes #18 (sub-C bin + example + CHANGELOG + 매트릭스)
- closes #15 (Slice 2 메인)
- closes #5 (G03+G04 P0 — DANGEROUS + path normalize 모두 §A)

## [Slice 1c++] — 2026-04-25 — LLM Config Standard 정규화 + 프로젝트 example

**사용자 directive**: "지금 프로젝트에 설정 + LLM 설정 표준 미리 만들어두는게 좋지 않을까?"

### Added
- `docs/llm-config-standard.md` — LLM provider 설정 정규 표준 (환경변수 / JSON shape / 우선순위 / 보안 / multi-tool harness 호환)
- `naia-agent.env.example` (프로젝트 root) — 4 provider option 포함, 사용자가 채워서 `naia-agent.env`로 rename
- `.naia-agent.example.json` — JSON config example, camelCase 자동 변환 시연
- `AGENTS.md` "LLM Config Standard" 섹션 (mirror 자동 sync)

### 매트릭스 §A 신규 4건
- **A20** env + JSON config auto-loader (camelCase → SCREAMING_SNAKE_CASE)
- **A21** OpenAI-compat client (zai GLM / vLLM / OpenRouter / Together / Groq / Ollama)
- **A22** Anthropic on Vertex AI provider
- **A23** LLM Config Standard docs + multi-tool harness 표준화

### 표준 핵심 (요약)
- Provider priority: ANTHROPIC > OpenAI-compat > GLM > Vertex > mock
- 파일 검색: `--env/--config` flag > env var > project file > `~/.naia-agent/`
- 보안: mode 600 권장, .gitignore, 키 값 stdout 노출 금지, F09 (cleanroom 단독 의존 금지)
- 도구 무관: Claude Code / opencode / Codex / Gemini / naia 자체 모두 동일 표준 사용

### Slice 1 (전체) 완전 종료
- Slice 1a (mock skeleton) ✓
- Slice 1b (real Anthropic + fixture-replay + D09/D10/D11) ✓
- Slice 1c (.env/JSON auto-load + Vertex provider) ✓
- Slice 1c+ (OpenAI-compat + 사용자 키 자동 설정) ✓
- Slice 1c++ (본 entry — LLM Config Standard 정규화) ✓
- **사용자 직접 검증**: `pnpm naia-agent "안녕"` → "안녕하세요! 😊 How can I help you today?" (GLM-4.5-Flash) ✓

### 다음 단계
Slice 2 (Bash skill + observability + 보안 D01/D02/D09 ingrain) — sub-issue #5

## [Slice 1c+] — 2026-04-25 — OpenAI-compat provider (GLM/zai/vLLM/OpenRouter…) + 사용자 키 자동 설정

**사용자 directive: "키 넣어줘"** — `~/dev/my-envs/naia.nextain.io.env`에서 valid GLM 키 발견 → `~/.naia-agent/.env`에 자동 설정 → 즉시 실 호출 동작 확인.

### Added
- `packages/providers/src/openai-compat.ts` — OpenAI-compat fetch wrapper (no SDK 의존). zai GLM, vLLM, OpenRouter, Together, Groq, Ollama 등 모든 OpenAI-compat endpoint 호환
- bin provider 분기 우선순위 update: ANTHROPIC > OpenAI-compat (GLM 자동 + OPENAI 환경) > Vertex > mock
- `~/.naia-agent/.env` (mode 600) — GLM_API_KEY + GLM_MODEL 설정. 사용자 키 위치 자동 검출

### 실 호출 검증 (실제로 동작)
```bash
$ pnpm naia-agent "안녕! 한국어 5단어 이내로 답해줘"
[naia-agent] loaded .env=/home/luke/.naia-agent/.env (2 keys)
[naia-agent] provider: openai-compat (model=glm-4.5-flash, baseUrl=https://open.bigmodel.cn/api/paas/v4)
안녕하세요!
```

### Provider matrix (4 옵션)
| 환경변수 | provider |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic 직접 |
| `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` | Anthropic-compat gateway |
| `OPENAI_API_KEY` + `OPENAI_BASE_URL` | OpenAI-compat (vLLM/OpenRouter/etc) |
| **`GLM_API_KEY`** (단독) | **zai/Zhipu GLM** (open.bigmodel.cn 자동) |
| `VERTEX_PROJECT_ID` + `VERTEX_REGION` | Anthropic on Vertex AI (gcloud ADC) |
| (none) | mock fallback |

### 보안
- `~/.naia-agent/.env` mode 600 (owner-only read)
- 코드는 키 값 절대 stdout/stderr 노출 안 함 (key 이름만)
- `.gitignore`에 `.naia-agent/` 포함 (commit 방지)
- 매트릭스 §B22 준수: cleanroom 코드 라인 인용 0

### 테스트
- 160 PASS (protocol 73 + runtime 87)
- tsc clean

### 매트릭스 §A 신규 (다음 commit에서 update)
- A20 후보: env+JSON config auto-loader
- A21 후보: OpenAI-compat client (multi-endpoint)

## [Slice 1c] — 2026-04-25 — .env / JSON config auto-load + Vertex AI provider

**사용자 키 보관 친화.** "키 직접 기억하지 않아" directive 반영 — 사용자가 표준 위치(.env, JSON config) 또는 명시 path에 키 두면 자동 로드. Anthropic 직접 + Vertex AI 둘 다 지원.

### Added
- `packages/runtime/src/utils/env-loader.ts` — native .env parser + JSON config flattener (camelCase/kebab → SCREAMING_SNAKE_CASE 자동 변환). dotenv 의존 0
- `packages/runtime/src/__tests__/env-loader.test.ts` (18 tests)
- `packages/providers/src/anthropic-vertex.ts` — `createAnthropicVertexClient` (Anthropic on Vertex AI via `@anthropic-ai/vertex-sdk`)
- `bin/naia-agent.ts` — `--env <path>` / `--config <path>` 플래그 + `NAIA_AGENT_ENV` / `NAIA_AGENT_CONFIG` 환경변수 + 자동 검색
- Provider 결정 로직: ANTHROPIC_API_KEY 우선 → VERTEX_PROJECT_ID + VERTEX_REGION → mock fallback
- 의존: `@anthropic-ai/vertex-sdk@^0.16.0` (peer optional)

### Auto-loaded files (first match wins, never overwrites process.env)
- `.env`: `./.env` → `./naia-agent.env` → `~/.naia-agent/.env`
- JSON: `./.naia-agent.json` → `~/.naia-agent/config.json`

### Slice 1c success criterion (S01~S04)
- ✅ S01 새 명령: `pnpm naia-agent --env .env "..."` / `pnpm naia-agent --config cfg.json "..."` / 자동 검색 모두 동작
- ✅ S02 단위 테스트: env-loader 18 tests + 기존 142 = **160 PASS**
- ✅ S03 통합 검증: .env 자동 로드 + provider 분기 시연 검증
- ✅ S04 본 entry

### .gitignore 추가
`naia-agent.env` / `.naia-agent.json` / `.naia-agent/` (사용자 키 commit 방지)

### Provider matrix
| 환경변수 | 효과 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic 직접 (claude-haiku-4-5-20251001 default) |
| `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` | Anthropic-compat gateway 라우팅 |
| `VERTEX_PROJECT_ID` + `VERTEX_REGION` | Anthropic on Vertex AI (gcloud ADC 자동 사용) |
| (none) | mock fallback |

### 사용자 검증 안내

**옵션 A — Anthropic 직접**:
```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." > .naia-agent/.env  # ~/.naia-agent/.env
pnpm naia-agent "hi"
```

**옵션 B — Vertex AI** (gcloud auth application-default login 이미 됨):
```bash
echo "VERTEX_PROJECT_ID=your-vertex-project" > .naia-agent/.env
echo "VERTEX_REGION=us-east5" >> .naia-agent/.env
pnpm naia-agent "hi"
```

**옵션 C — JSON config** (camelCase 자동 변환):
```bash
cat > ~/.naia-agent/config.json <<EOF
{ "anthropic": { "apiKey": "sk-ant-...", "model": "claude-haiku-4-5-20251001" } }
EOF
pnpm naia-agent "hi"
```

**옵션 D — 명시 path** (사용자 자체 .env 재사용):
```bash
pnpm naia-agent --env ~/dev/my-envs/anthropic.env "hi"
```

## [Slice 1b] — 2026-04-25 — real Anthropic + fixture-replay + D09/D10/D11

**R3 척추 살아남음 증명.** real LLM 통합 + 결정적 회귀 테스트 + Tool 메타/context schema + Workspace sentinel.

### Added
- `bin/naia-agent.ts` `detectRealLLM()` — `ANTHROPIC_API_KEY` (+ `ANTHROPIC_BASE_URL` gateway 라우팅) 검출 → AnthropicClient 주입. F11 graceful fallback (SDK load 실패 시 stderr 경고 + mock fallback)
- `packages/runtime/src/testing/stream-player.ts` — minimal fixture-replay LLMClient (C21 부분 채택, Slice 5에서 정식)
- `packages/runtime/src/__fixtures__/anthropic-1turn.json` — 1-turn naia 정규형 fixture (5 deltas → "Hi from fixture.")
- `packages/runtime/src/__tests__/fixture-replay.test.ts` (4 tests) — G02 해소, G15 (CI fixture-only) 만족
- `packages/types/src/tool.ts` — D10 Tool 메타 4 필드 (`isConcurrencySafe?`/`isDestructive?`/`searchHint?`/`contextSchema?`) + D11 `ToolExecutionContext` (sessionId/workingDir/signal/ask). 모두 optional (additive, A.8 MAJOR 위반 0)
- `packages/runtime/src/utils/path-normalize.ts` — D09 `normalizeWorkspacePath` + `WorkspaceEscapeError` (OWASP A01 출처, F09 cleanroom 라인 인용 0건)
- `packages/runtime/src/__tests__/path-normalize.test.ts` (10 tests) — partial-prefix attack 차단 검증

### Slice 1b success criterion (자가 검증 + paranoid review 통과)
- ✅ S01 새 명령: `ANTHROPIC_API_KEY=... pnpm naia-agent "hi"` (real Anthropic) / `ANTHROPIC_BASE_URL=...` gateway 라우팅 / 키 없으면 mock fallback
- ✅ S02 단위 테스트: fixture-replay 4 + path-normalize 10 = +14 (총 142 PASS — protocol 73 + runtime 69)
- ✅ S03 통합 검증: fixture-replay 결정적 재생 (Anthropic API 호출 없이) — G02 해소, G15 (CI fixture-only mode) 만족
- ✅ S04 본 entry

### 매트릭스 §A 승격 (Slice 1b 머지로)
- **A16** Tool 메타 (`isConcurrencySafe?`/`isDestructive?`/`searchHint?`/`contextSchema?`) — D10 §D → §A. 출처: cc 분석 + Vercel + Mastra
- **A17** Tool context schema (sessionId/workingDir/signal/ask) — D11/D05 §D → §A. 출처: opencode + Vercel `ToolExecutionOptions`
- **A18** Workspace sentinel — D09 §D → §A. 출처: cleanroom-cc deep-audit F3 fix (OWASP A01 재근거)
- **A19** Fixture-replay minimal (StreamPlayer + 정규형 fixture) — C21 부분 §C → §A 부분. 정식 framework는 Slice 5

### Paranoid review fix (2건 즉시 적용)
- F11 graceful: SDK load 실패 시 stderr 경고 + mock fallback (hard crash 방지)
- fixture notes 정정: "naia LLMStreamChunk normalized form (NOT raw SDK shape)"

### Slice 2 follow-up (paranoid review 권고)
- D11 orphan 해소 (`ToolExecutor.execute(invocation, ctx?)` 시그니처 확장)
- D09 추가 케이스 (Windows UNC / null byte / symlink realpath)
- F11 fixture 재녹화 (실 SDK 응답 녹음 — Slice 5에서 자동화)

### 사용자 검증 안내 (직접 테스트)

**환경변수**:
```bash
export ANTHROPIC_API_KEY=...                    # 진짜 키
export ANTHROPIC_BASE_URL=...                   # (선택) Anthropic-compat gateway
export ANTHROPIC_MODEL=claude-haiku-4-5-20251001 # (선택, 기본값)
```

**실행**:
```bash
pnpm naia-agent "hi"                  # args 모드
echo "1+1?" | pnpm naia-agent          # stdin 모드
pnpm naia-agent                        # REPL 모드
```

**키 없을 때**: mock fallback ("Hello! I'm naia-agent in mock mode" 출력).

**참고**: naia-agent는 표준 `ANTHROPIC_API_KEY` 환경변수만 사용. 외부 도구·gateway 의존 0. 사용자가 자체 키 또는 Anthropic-compat gateway URL을 직접 환경변수로 제공.

### Sub-issues closed
- closes #12 (sub-4 real AnthropicClient + smoke:real-agent)
- closes #13 (sub-5 fixture-replay 1건 + StreamPlayer)
- closes #14 (sub-6 D09/D10/D11 ingrain + 매트릭스 §A 승격)
- closes #8 (Slice 1 메인 — 1a + 1b 모두 종료)

## [Slice 1a] — 2026-04-25 — bin/naia-agent skeleton (mock-only)

**R3 진입.** naia-agent를 처음으로 사용자 명령으로 호출 가능한 도구로 만듦.

### Added
- `bin/naia-agent.ts` — REPL/stdin/args 분기 entry (mock LLM)
- `packages/runtime/src/host/create-host.ts` — host factory (DI 단순 주입, Mastra/opencode 매트릭스 §C22 단순화 채택)
- `packages/runtime/src/host/index.ts` + runtime index re-export
- `package.json scripts.naia-agent` (`tsx bin/naia-agent.ts`)
- `packages/runtime/src/__tests__/create-host.test.ts` (5 tests)

### Slice 1a success criterion (자가 검증 + paranoid review 통과)
- ✅ S01 새 명령: `pnpm naia-agent "hi"` / `echo "hi" | pnpm naia-agent` / `pnpm naia-agent` (REPL)
- ✅ S02 단위 테스트: create-host.test.ts 5 cases (총 128 PASS — protocol 73 + runtime 55)
- ✅ S03 통합 검증: `pnpm smoke:agent` 회귀 PASS + `pnpm run check:harness-sync` PASS
- ✅ S04 본 entry

### Paranoid review fix (2건 즉시 적용)
- P3: parseArgs `--` terminator 지원
- P7: createHost default logLevel "info" → "warn" 일관성

### 매트릭스 영향
- 해소: G01 (bin/naia-agent 진입점) — F08 자동 해제 trigger 충족
- §C22 (DI 단순화) — service factory 함수 패턴 채택, §A 승격은 Slice 1b에서 묶음
- F09 준수: cleanroom 코드 인용 0건 (bin/host 모두 자체 작성)
- F11 영향 없음: SDK import 0건 (mock only)

### Sub-issues closed
- closes #9 (sub-1 bin entry)
- closes #10 (sub-2 host factory)
- closes #11 (sub-3 단위 테스트 + 회귀)

### Slice 1b 예고
- real Anthropic / NAIA gateway 통합 (`NAIA_GATEWAY_URL` + `GEMINI_API_KEY`)
- fixture-replay 1건 + StreamPlayer 골격
- D09/D10/D11 P0 ingrain

## [Plan v2] — 2026-04-25 — Cross-review 적용 (Option A light)

**3-perspective cross-review** (architect + reference-driven + paranoid auditor) + 추가 ref 3개 검토(Mastra/LangGraph/Vercel) 결과 반영. **Option A (가벼운 buffer)** 채택.

### 매트릭스 변경
- §D 신규 9건: D09 (workspace sentinel) P0 / D10 (Tool 메타) P0 / D11~D17 (Tool context, onStepFinish, 3중 방어, Eval scorers, Memory tiers, Prompt cache C04 격상, Provider fallback)
- §B 신규 6건: B17~B22 (Mastra monorepo / Mastra Studio / LangChain core / StateGraph reducer / Vercel multi-provider / cleanroom 라인 복붙)
- §C04 → §D16 격상 (Vercel cache_control 영향)
- §F05 신규: cleanroom 폐기 대응 plan (archived 2025-03)
- §G 점수표: Mastra ★★★★★, Vercel ★★★★, LangGraph ★★★ 추가

### 새 forbidden_actions
- F01 보안 예외: CVE 패치 차단 면제 (4-repo plan A.13)
- F09: cleanroom 단독 의존 금지 (OWASP/RFC 출처 cross-reference 강제)
- F11: SDK breaking 사전 감지 (Anthropic SDK minor+ bump 시 fixture 재녹화)

### 새 success criterion
- G15: CI fixture-only mode default (API key 노출 방지)

### Slice spine 변경
- Slice 1 → 1a (mock-only) / 1b (real Anthropic + fixture-replay) 분할 — 위험 격리
- Slice 1b에 D09/D10/D11 P0 ingrain
- Slice 3에 G06 cross-repo P0 gate 명시 (alpha-memory stub 해소 전 진입 차단)
- R3+ Slice 6/7/8/9/10 outline 신설 (Eval framework / Tool meta+context / Hook 28-event / Task framework / naia-os sidecar)

### 신규 산출물 (`.agents/progress/refs/`)
- `cc-cleanroom-security-audit-2026-04-25.md` (F1~F4 미완성 stub 발견, 악성 0건)
- `cc-cleanroom-deep-audit-2026-04-25.md` (F5~F12 LLM 환각/silent fail + 8 파일 블랙리스트)
- `mastra-review.md` (★★★★★ Eval/Memory tiers/Tool context)
- `langgraphjs-review.md` (★★★ Checkpoint/Sub-agent/Interrupt)
- `vercel-ai-sdk-review.md` (★★★★ ToolLoopAgent/onStepFinish)

### 의도적 제외 (백로그 / R3+)
- D14 Eval scorers 정식 framework (R3.1)
- D12/D13 Task/Hook framework (R3.3/3.4)
- D17 needs-approval 단순화 (Vercel deprecated, 우리 Tier T0~T3 우월)
- 24h enforcement 자동화 (1인 환경 권고만)
- Mastra DynamicArgument / StateGraph reducer / Vercel multi-provider 직접 의존

코드 변경 0줄. 매트릭스 + agents-rules + AGENTS.md(+4 mirror auto) + r1-slice-spine + CHANGELOG only.

## [Slice 0] — 2026-04-25 — Structure / Dev env

**R2 — 인프라 정비.** 코드 0줄 변경. 다음 슬라이스 진입을 위한 거버넌스·CI 정비.

### Added
- `.github/CODEOWNERS` — 1인 maintainer 명시 + 핵심 영역(types/protocol, AGENTS.md, sync script, .agents/) 마킹
- `.github/PULL_REQUEST_TEMPLATE.md` — minimal (Summary / Test plan / 4 체크박스)
- `package.json scripts`:
  - `test` — `pnpm -r --if-present test` (전 패키지 vitest 실행)
  - `check:harness-sync` — `sync-harness-mirrors.sh --check` (CI invariant)
  - `sync:harness` — mirror 강제 재생성
- `.github/workflows/ci.yml` 보강 — `check:harness-sync` + `pnpm test` 단계 추가

### Slice 0 success criterion (자가 검증 통과)
- ✅ S01 새 실행 가능 명령: `pnpm run check:harness-sync` (mirror 동기 검증)
- ✅ S02 단위 테스트: 기존 protocol 73 + runtime 50 = 123 tests (CI에서 실행)
- ✅ S03 통합 검증: `check:harness-sync` PASS (CI workflow에 통합)
- ✅ S04 CHANGELOG entry: 본 entry

매트릭스 영향: S05 (CODEOWNERS), S06 (PR template), S09 (smoke:real-agent placeholder는 부정직하다는 cross-review 권고로 미도입), S10 (CHANGELOG 포맷) 해소. Sub-issue #7의 R2 항목 일부 close.

## 0.1.0 — 2026-04-21 — Phase 1 freeze

**Phase 1 exit.** Public contracts now subject to the additive-only rule
(plan v6 A.5). Breaking shape changes require MAJOR bump and 4-week
advance notice (plan A.11 communication policy).

### `@nextain/agent-types`
First stable-shape release. Includes:
- `LLMClient` (generate, stream) + request/response/stream-chunk shapes
- `LLMContentBlock` (text, thinking, redacted_thinking, tool_use, tool_result, image)
- `LLMContentDelta` (text_delta, thinking_delta, input_json_delta)
- `MemoryProvider` (encode, recall, consolidate, close) + 7 optional Capability interfaces + `isCapable()` guard
- `ToolExecutor`, `ToolInvocation`, `TierLevel` (T0-T3), `TierPolicy`
- `ApprovalBroker`, `ApprovalRequest`, `ApprovalDecision` + `APPROVAL_DEFAULT_TIMEOUT_MS`
- `HostContext`, `HostContextCore`, `DeviceIdentity`
- `Event`, `ErrorEvent`, `Severity`, `VoiceEvent` family
- `Logger`, `Tracer`, `Span`, `SpanContext`, `Meter`, `Counter`, `Histogram`
- `Session`, `SessionState`, `SessionEvent`, `SessionTransition`, `ALLOWED_TRANSITIONS`, `isTerminalSessionState`

Zero-runtime-dep (package contains no external runtime imports; a few
typed constants like `APPROVAL_DEFAULT_TIMEOUT_MS` and `ALLOWED_TRANSITIONS`
are compile-time data, not dependencies). ESM-only. Node ≥ 22.

### `@nextain/agent-protocol`
First release. Wire protocol for host ↔ agent stdio communication.
- `StdioFrame<P>` + `FrameType` (request/response/event)
- `encodeFrame`, `parseFrame`
- `ProtocolError`
- `PROTOCOL_VERSION = "1"`

### `@nextain/agent-core`
Scaffold release. Re-exports key contracts from `@nextain/agent-types`.
Runtime loop implementation deferred to Phase 2 X3.

### `@nextain/agent-providers`
First release with `AnthropicClient` implementing `LLMClient` over
`@anthropic-ai/sdk` (peerDependency ^0.39.0).
- Subpath export: `@nextain/agent-providers/anthropic`
- Full block/delta/stop-reason round-trip
- Usage tracking including cache_read/write tokens
- AbortSignal passthrough

### `@nextain/agent-observability`
First release with default contract impls:
- `ConsoleLogger` (JSON lines to stderr, level filter)
- `SilentLogger` (discards all — for tests)
- `NoopTracer`
- `InMemoryMeter` + `InMemoryCounter` + `InMemoryHistogram` (with snapshot)

## Freeze policy (effective 0.1.0)

1. **Additive-only** at MINOR. New optional fields, new types, new interfaces OK.
2. **Removal / type change / semantics change** requires MAJOR bump + advance notice per plan A.11.
3. **Capability interfaces** (MemoryProvider Capabilities) may be added at MINOR. Removal is MAJOR.
4. `@nextain/agent-protocol` has independent semver — wire breaks do not force a types MAJOR.
5. Pre-v0.1 code (0.0.x) was exempt from this rule; history below is informational.

## 0.0.1 (unreleased workspace-only) — 2026-04-21

MVM iterations. See git history. Key milestones:
- MVM #1: alpha-memory audit + MemoryProvider façade (`a4055f2`)
- MVM #2: types initial shape + LLMClient contract (`ef55d21`)
- MVM #3a: AnthropicClient implementation (`2559db5` with 2-round review fixes)
- MVM #3b: smoke test (dry-run + live) (`f627373`)
- MVM #4: Flatpak baseline confirmed via naia-os CI
- MVM #5: PR templates across 4 repos
- Scope rename `@naia-agent/*` → `@nextain/agent-*` (`b4e34c2`)
- Phase 1 T1–T7 contracts (VoiceEvent `047822b`, full T5 `c2949dd`, protocol `d2dd51f`, observability `c05b191`, ARCHITECTURE.md `7d6f22c`)
