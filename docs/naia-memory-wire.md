# naia-agent ↔ naia-memory wire spec

> **Languages**: English (this file) · [한국어](../.users/docs/ko/naia-memory-wire.md)
> **Status**: live (`--memory` flag shipped in Slice 3-XR-C-mem, Group A3 + F2 verify cross-process recall LIVE).
> **Upstream refs**: `docs/vision-statement.md` §4b (persona separation), `docs/memory-provider-audit.md` (façade audit).

---

## 1. Responsibility split (user directive, 2026-04-26 reaffirmed 2026-05-08)

> "The module that retrieves or selects memories must live in naia-memory."

| Responsibility | Owner |
|---|---|
| **MemoryProvider interface definition** | naia-agent (`packages/types/src/memory.ts`) |
| **Memory storage (encode)** | **naia-memory** (`LocalAdapter` / Mem0 / Qdrant adapters) |
| **Memory retrieval (recall) + ranking + decay + importance gating** | **naia-memory** |
| **Compaction (compact)** | **naia-memory** (`CompactableCapable` implementations) |
| **`LiteMemoryProvider` (SQLite + embeddings, shipped 2026-05-15)** | **naia-memory** package (re-exported by naia-agent for CLI use) |
| **Interface call + result injection** | naia-agent (CLI `--memory` flag, host injects in service mode) |

→ naia-agent does NOT carry retrieval logic. It calls `provider.recall(opts)` and injects the result as `extraSystemPrompt` (or builds the `<recall>`-loop persona for the CLI memory mode).

---

## 2. Dependency wiring (current = local `file:` dep)

```json
// naia-agent/package.json (devDependencies)
"@nextain/naia-memory": "file:../naia-memory"
```

**No npm publish required** — inside the alpha-adk monorepo the `file:` dep links automatically.

| Environment | Status |
|---|:---:|
| Inside alpha-adk (local dev) | OK — verified (354 PASS, full suite + LIVE memory recall in Group A3 / F2) |
| External user / CI | NOT YET — naia-memory directory absent (would need npm publish first) |

**When to publish**:
- After naia-memory perf testing / stabilization
- When external distribution is needed (not now)
- Permissions: user's own npm account

Once published, switch to `"@nextain/naia-memory": "^0.x.y"`.

---

## 3. Wire pattern (host = alpha-adk or any other host)

### 3.1 CLI mode (`--memory` flag, shipped 2026-05-15)

The bin builds the provider itself via `buildCliMemory(args)` and `LiteMemoryProvider`. The user just adds `--memory`:

```bash
pnpm naia-agent --no-tools --memory "기억해줘: 내 강아지 이름은 코코야."
pnpm naia-agent --no-tools --memory "내 강아지 이름이 뭐였지?"
# → "코코" (cross-process recall verified by Group A3 / F2)
```

Storage path: a `cli.sqlite` file under the user's `.naia-agent/memory/` directory by default. Override with the `NAIA_AGENT_MEMORY_DB` environment variable.

### 3.2 Service-mode / host wire (manifest with `memory.binding: "alpha-memory"`)

```typescript
import { Agent } from "@nextain/agent-core";
import { LocalAdapter, MemorySystem } from "@nextain/naia-memory";

// 1. naia-memory instance (host decides the path)
const adkRoot = process.env["ADK_ROOT"] ?? process.cwd();
const memorySystem = new MemorySystem({
  adapter: new LocalAdapter({
    storagePath: path.join(adkRoot, "data/memory"),  // naia-adk convention
  }),
});

// 2. Wrap as MemoryProvider (see examples/naia-memory-host.ts)
const provider: MemoryProvider = makeNaiaMemoryProvider(memorySystem);

// 3. Inject into naia-agent
const host: HostContext = { llm, memory: provider, ... };
const agent = new Agent(host, ...);

// 4. Supervisor recalls + injects before sending to sub-agent
const hits = await provider.recall({
  query: userPrompt,
  topK: 5,
  minStrength: 0.6,
});
const memoryContext = hits.map((h) => h.content).join("\n");
const taskSpec = {
  prompt: userPrompt,
  workdir,
  extraSystemPrompt: `[memory]\n${memoryContext}\n\n[persona]\n${naiaAdkPersona}`,
};

// 5. Encode the assistant's reply back into memory
await provider.encode({
  content: assistantResponse,
  role: "assistant",
  context: { sessionId },
});
```

---

## 4. What naia-agent NEVER does

- (NO) Vector search / cosine similarity
- (NO) Memory importance scoring
- (NO) Ebbinghaus decay
- (NO) Knowledge graph
- (NO) Direct import of any storage backend

→ All of these are naia-memory's responsibility. naia-agent only **calls the interface and injects results**.

---

## 5. Directory layout vs package name

| | Value |
|---|---|
| **GitHub repo** | `nextain/naia-memory` (renamed from `alpha-memory` in the 4-repo migration, 2026-04-26) |
| **submodule directory** | `projects/naia-memory/` |
| **npm package name** | **`@nextain/naia-memory`** |
| **import** | `import { ... } from "@nextain/naia-memory"` |

The directory has been renamed alongside the package; no legacy `alpha-memory` directory remains in the workspace.

---

## 6. Shipped functionality (vs original Phase 3 plan)

The original spec called this out as "Phase 3 wire (future)". As of 2026-05-15 (Slice 3-XR-C-mem) the following is shipped:

- DONE — `--memory` flag in the CLI (`LiteMemoryProvider`).
- DONE — `<recall>` marker protocol baked into `MEMORY_PERSONA` (default for `--memory`).
- DONE — Cross-process recall verified LIVE in Group A3 + F2 (Slice 3-XR-G + 3-XR-I).
- DONE — `stripRecallResidue` sanitizer on the agent loop (#2 leak fix, Slice 3-XR-F).
- DONE — Service-mode binding (`memory.binding: "alpha-memory"`) in the manifest.

### Still on the roadmap

- `naia-adk` exposing a `getMemoryStoragePath(adkRoot)` convention helper.
- Supervisor-mode `recall → extraSystemPrompt` auto-injection for sub-agents (Phase1Supervisor is host-driven today; the lift to a `MemoryProvider`-aware supervisor is the next step).
- Per-session encode/decay cadence tuning.

---

## 7. Cross-refs

- `docs/memory-provider-audit.md` — interface contract + capabilities.
- `docs/vision-statement.md` — persona-vs-memory layer separation.
- Slice 3-XR-C-mem (2026-05-15) — first ship of `--memory` + recall protocol.
- Slice 3-XR-F / 3-XR-G — black-box scenarios (S8 SQLite probe, A3 cross-process recall, F2 persona + memory composition).
