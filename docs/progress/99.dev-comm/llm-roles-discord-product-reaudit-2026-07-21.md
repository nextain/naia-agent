# LLM roles and Discord product re-audit — 2026-07-21

Status: **reopened; implementation must not use the prior Done/Pass labels as acceptance evidence**.

Scope: the naia-agent half of the user's observed product failures: one main-brain setting
must govern the default secondary brain, memory must have a separately visible and effective
LLM configuration, and a Discord connection must have a secure but usable enrollment flow.
The Shell owns the visual controls and keychain UI; this record defines the agent contracts
those controls must be able to satisfy.

## Adversarial finding

The existing checks prove isolated parsers and a secure process entry.  They do **not** prove
that a user can configure the feature in Shell or that all consumers use one resolved role
configuration.  Consequently the former `Done` labels for the legacy memory configuration and
the `Partial` Discord runtime label are not evidence for the requested product flows.

### F1 — two authorities decide the main brain

- `src/main/adapters/naia-settings-store.ts` exposes `loadMain()` from top-level
  `config.json.provider/model`, while `loadLlmRoles()` separately resolves `llmRoles.main/sub/memory`.
- `scripts/builds/compose-agent-deps.mjs` uses `loadMain()` as `defaultConfig` for actual chat,
  then only consumes the resolved `sub` and `memory` roles for `subLlm` and `naia-memory`.
  The resolved `main` role is logged but is not the chat-provider source.
- Therefore a structured `llmRoles.main` can disagree with the model that answers the user.
  The current composition test deliberately gives both paths the same Codex value, so it cannot
  detect this split.

Required correction: one resolver must produce the effective main, sub, and memory configurations;
the chat provider must be built from its effective **main** result.  Legacy top-level fields are an
input migration path, not a second runtime authority.

### F2 — fresh configuration has no usable secondary or memory LLM

The inspected active `naia-settings/config.json` has a main provider/model and offline embedding,
but no `llmRoles`, `subLlm*`, or `memoryLlm*` values.  In
`src/main/domain/llm-roles.ts`, legacy main alone leaves `sub` unresolved; resolution then fails
before a sub or memory runtime can be built.  `compose-agent-deps.mjs` consequently makes
`subLlm=none` and initializes memory without a role LLM.

This matches the reported screen: embedding exists, but the promised memory LLM does not.
It also violates the requested default: a secondary brain must initially be the same configuration
as the primary brain, with a user-visible inheritance provenance and an explicit override action.

Required correction:

1. Defaults must resolve `sub -> main` and `memory -> sub` unless a user chooses an override.
2. An unavailable main-only provider (Codex, Claude Code, direct Anthropic) must yield an explicit
   per-role unavailable state and a usable alternative, never an empty compact control or silent
   downgrade.
3. The UI may keep memory LLM disabled by policy, but it must state that fact as
   `heuristic/embedding only`; it cannot imply that an LLM is configured.

### F3 — structured memory role and memory runtime can disagree

`compose-agent-deps.mjs` gives `memoryRoleRuntime.config` to `makeNaiaMemory`, including the
LLM-backed fact extractor and compaction summarizer.  However `agent-stdio-entry.mjs` reloads
`activeMemoryProcessingConfig` solely with `loadMemoryConfig()` and its Discord processing guard
uses the legacy `memoryLlm*` view for both `memory_llm` and `sub_llm` disclosure/destination.

Thus `llmRoles.memory` can drive memory execution while Discord reports it as heuristic, or a
legacy field can report a different destination.  Processing disclosure is a security contract;
this is not only a display defect.

Required correction: the single resolved role object must be retained/reloaded atomically and be
the source for naia-memory construction, processing-policy endpoint resolution, diagnostics, and
the Shell status payload.

### F4 — Discord protects a secret but has no complete enrollment contract

`scripts/builds/agent-stdio-entry.mjs` correctly accepts a bot token only through the one-shot
stdin secret pipe and deletes the environment marker.  Starting the runtime additionally requires
valid bindings plus generation/authority paths.  Missing inputs intentionally yield
`token_unavailable`, `bindings_invalid`, or `authority_invalid`.

That is a valid backend safety boundary, but it is not a user connection feature.  There is no
agent contract for Shell to submit a bot token to the OS credential store, create/update a binding,
restart/inject the secret, and read an actionable connection state.  Existing tests assert source
text and fake Gateway behavior; they do not exercise enrollment from a secure input to a running
connected bot.

Required correction: define a secret-reference-only enrollment/status port.  The token itself must
never enter config JSON, gRPC request fields, diagnostics, status files, or test fixtures.

## Reopened user scenarios and acceptance contracts

| UC | User-visible acceptance | Agent responsibility | Required proof |
|---|---|---|---|
| UC-ROLE-DEFAULT | Selecting a main brain once makes main chat and secondary brain show the same provider/model with `Inherited from main`; no shortened alternate shell. | Resolve all three roles from one migration-aware source. | Fresh-config composition test and Shell restart E2E. |
| UC-ROLE-OVERRIDE | Changing secondary or memory changes only that role; unsupported provider is shown with an actionable reason. | Return effective config/provenance/capability state, no silent fallback. | Resolver, composition, diagnostics, and Shell interaction tests. |
| UC-MEMORY-LLM | Selecting a memory LLM activates it for fact extraction and compaction; embedding remains independently selectable. | Supply the same effective memory role to naia-memory, disclosures, and diagnostics. | Real adapter-spy integration plus configuration reload test. |
| UC-MEMORY-DEGRADE | With no memory LLM, user sees `heuristic/embedding only`; recall/save remains usable. | Preserve graceful degradation and report it truthfully. | Fresh config + no-secret tests, then Shell status E2E. |
| UC-DISCORD-ENROLL | Settings opens secure bot-token input and required binding fields; Connect reports setup, connecting, ready, or a useful failure. | Consume only host-injected secret and validated bindings; emit redacted status codes. | Shell keychain/injection/restart E2E and agent process smoke. |
| UC-DISCORD-RESTART | A saved credential and binding reconnect after restart; a missing credential/binding visibly asks for setup. | Make missing prerequisite states observable without leaking secrets. | Process test with secret pipe plus Shell Playwright restart test. |

## Test gaps that made the former pass misleading

1. `llm-roles.contract.test.ts` validates standalone role resolution but has no default-main
   inheritance test.
2. `llm-role-composition.integration.test.ts` gives top-level main and `llmRoles.main` identical
   values, so it cannot catch the two-authority defect.
3. No test asserts that the actual chat provider uses resolved `llmRoles.main`.
4. No test asserts that `llmRoles.memory` and the Discord processing destination/disclosure are
   the same configuration before and after reload.
5. `discord-entry-wiring.contract.test.ts` is source-text inspection; it is not a user enrollment
   test. `discord-runtime.integration.test.ts` starts from an already supplied fake token/binding.
6. The documented `T-DISCORD-RT-07` live smoke is opt-in and cannot substitute for a deterministic
   local keychain-to-process contract test or Shell UI E2E.

## Ordered implementation plan

1. **Contract reset (P01–P03):** add the six UCs above and corresponding REQ/TEST registry entries;
   change legacy-only requirements from Done to reopened.  Specify migration precedence and the
   status vocabulary shared with Shell.
2. **Role-resolution core:** replace dual main/runtime sources with a single effective role snapshot;
   encode default inheritance and explicit override/capability outcomes.
3. **Role consumers and reload:** wire that snapshot into chat main provider, sub-agent runtime,
   naia-memory fact extraction/summarization, processing guard, diagnostics, and reload atomically.
4. **Discord agent port:** expose a redacted prerequisite/status contract that Shell can use;
   retain one-shot secret injection and fail closed if Shell has not provisioned token/binding.
5. **Shell FE implementation:** implement full-size role editors, inherited/override controls,
   memory state and model selection, secure Discord token field, binding fields, and status/error
   rendering.  This is a separate Shell issue but is blocked by the contracts above.
6. **Evidence:** run targeted resolver/composition/process tests, then Shell Playwright fresh-state
   and restart flows using an actual agent child.  A real Discord token smoke is optional extra
   evidence, never the only acceptance test.

## Reopen targets

- `REQ-003` / `UC-003` provider provenance: extend from one chat provider to one effective
  role snapshot; do not keep its Done label for role routing.
- `FR-MEM-11` and `FR-MEM-12`: legacy memory configuration is implemented, but structured role
  routing and visible default/degrade state remain open.
- `REQ-014` / `UC-016` / issue #85: runtime hardening remains valuable, but Discord enrollment
  and Shell-visible prerequisite state are missing.
- `REQ-015` / `UC-017`: its Codex delegate work is not the same as the general secondary-brain
  configuration.  Do not claim it closes UC-ROLE-DEFAULT or UC-ROLE-OVERRIDE.

## Completion bar

This re-opened work is complete only when the six UCs pass through the real Shell and agent child,
the resolved role snapshot has one source of truth across all consumers, and redaction assertions
prove no bot token crosses a persisted or observable boundary.  Parser-only, source-string, fake
Gateway-only, or a manually supplied token smoke are insufficient on their own.
