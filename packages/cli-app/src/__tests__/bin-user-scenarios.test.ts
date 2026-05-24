// User-perspective scenario tests — Task #3.
//
// Two perspectives, both black-box (spawn the bin as a subprocess):
//  (1) Non-developer USER: simple natural commands (`naia-agent show`,
//      `naia-agent login --adk … --main "…"`, `naia-agent "hi"`) — every
//      scenario is named by the user GOAL it reaches, not by flag mechanics.
//  (2) naia-os SHELL via the any-llm gateway: the shell configures
//      naia-agent for a gateway baseURL + apiKeyRef and consumes its
//      output. The scenarios assert the *configuration contract* (show)
//      and the no-plaintext invariant.
//
// Hermetic by construction: every scenario uses a temp HOME + temp adk
// dir, never touches the user's real ~/.naia-agent or naia-adk submodule.
// Inherits no LLM env vars from the developer shell. Live-LLM scenarios
// auto-skip if the local Ollama container is not reachable (CLAUDE.md G15
// — fixture-only by default, real-LLM is opt-in by presence).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../../");
const binPath = resolve(repoRoot, "bin/naia-agent.ts");

function findTsxCli(): string {
  const pnpmDir = resolve(repoRoot, "node_modules/.pnpm");
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.startsWith("tsx@")) {
        const c = resolve(pnpmDir, entry, "node_modules/tsx/dist/cli.mjs");
        if (existsSync(c)) return c;
      }
    }
  }
  const hoisted = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");
  if (existsSync(hoisted)) return hoisted;
  throw new Error("tsx CLI not found");
}
const tsxCli = findTsxCli();

/**
 * Cold env — start from a minimal shell, strip every LLM/adk variable so
 * each scenario begins as a fresh user. NEVER inherit the developer's
 * keys/URLs/keychain refs.
 */
function coldEnv(home: string, extras: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"],
    HOME: home,
    USER: process.env["USER"],
    SHELL: process.env["SHELL"],
    ...extras,
  };
  if (process.platform === "win32") {
    env["USERPROFILE"] = home;
    env["HOMEDRIVE"] = undefined;
    env["HOMEPATH"] = undefined;
  }
  return env;
}

function runBin(args: string[], env: NodeJS.ProcessEnv, stdin?: string, timeoutMs = 20_000) {
  // Run in the test's temp HOME (not repoRoot) so the developer's local
  // `./naia-agent.env` / `./.env` does NOT leak into a "cold user" run.
  // The bin's path resolution is absolute → cwd does not affect it.
  const cwd =
    typeof env["HOME"] === "string" && existsSync(env["HOME"]) ? env["HOME"] : repoRoot;
  const opts: Parameters<typeof spawnSync>[2] = {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
  };
  if (stdin !== undefined) (opts as { input?: string }).input = stdin;
  return spawnSync(process.execPath, [tsxCli, binPath, ...args], opts);
}

/** Live-LLM gate — opt-in when the local Ollama container is reachable.
 *  Uses Node built-in fetch (no `curl` dependency, cross-review F5). */
async function ollamaReachable(): Promise<boolean> {
  try {
    const r = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(2_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Inline per-scenario probe (F4 — brittleness: state changes mid-run are
// handled at the call site; no stale module-load capture).
async function skipUnlessLlm(): Promise<boolean> {
  return await ollamaReachable();
}

describe("(1) USER perspective — non-developer CLI flow", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-scen-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // S1 — "I just installed naia-agent and typed `pnpm naia-agent show`".
  // Goal: see something honest (no crash), understand nothing is configured.
  it("S1 cold show: untouched user → unset/empty, no crash, no secret-shaped output", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const r = runBin(["show"], coldEnv(home));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/naia-agent show/);
    expect(r.stdout).toMatch(/<unset>|<none>|<n\/a>/);
    // Cross-review #2 #5: pin the adk row to the literal `<unset>` so a
    // silent regression (config.json discovery falling back to real $HOME)
    // cannot pass with `<none>`/`<n/a>` decoration.
    expect(r.stdout).toMatch(/naia-adk:\s+<unset>/);
    // never print a real-secret-shaped token
    expect(r.stdout).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}/);
    expect(r.stdout).not.toMatch(/\bAIza[0-9A-Za-z_-]{10,}/);
  });

  // S2 — "I typed `pnpm naia-agent` (no args) before configuring anything".
  // Goal: clear error + path forward, not a stacktrace.
  it("S2 first run with nothing configured → clear error, exit 3, points to login/env", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const r = runBin(["hi"], coldEnv(home));
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/no LLM provider configured/);
    // Both paths forward must be advertised (cross-review F10).
    expect(r.stderr).toMatch(/naia-agent login/);
    expect(r.stderr).toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY|GLM_API_KEY/);
    expect(r.stderr).not.toMatch(/naia-agent: fatal:/);
  });

  // S3 — "I typed `pnpm naia-agent login` to figure out how it works".
  // Goal: usage shown, NOT a misleading "configured" silent noop.
  it("S3 login with no arguments → usage printed, exit 3, never 'configured'", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const r = runBin(["login"], coldEnv(home));
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/usage:/);
    expect(r.stderr).toMatch(/--adk/);
    // Cross-review A-F6: the pipe-delimited role spec is non-obvious;
    // a user cannot guess this format — lock the example so a regression
    // dropping it is caught.
    expect(r.stderr).toMatch(/provider\|baseUrl\|model/);
    // The exact success-prefix from runLogin MUST NOT appear here
    // (case-insensitive — bin could regress to "Configured.")
    expect(r.stderr).not.toMatch(/login:\s*configured/i);
  });

  // S4 — "I ran `login --adk <path> --main "..."` once, then `show`".
  // Goal: show reflects exactly what I set; secret value never visible.
  it("S4 configure once then inspect: show mirrors my login (no secret value)", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    // include an apiKeyRef NAME so we can prove (a) `show` displays the
    // NAME, (b) the actual value (which we never set) is never invented
    // or echoed (cross-review F3).
    const r1 = runBin(
      [
        "login",
        "--adk",
        adk,
        "--main",
        "openai-compat|http://127.0.0.1:11434/v1|gemma3n:e4b|MY_OPENAI_KEY",
      ],
      coldEnv(home),
    );
    expect(r1.status).toBe(0);
    expect(r1.stderr).toMatch(/configured/);
    // Cross-review A-F7: the post-login `Run:` next-step hint is the
    // most user-actionable line in the success message — lock it.
    expect(r1.stderr).toMatch(/Run:\s+pnpm naia-agent.*--no-tools/);
    const r2 = runBin(["show"], coldEnv(home));
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain(adk);
    expect(r2.stdout).toContain("gemma3n:e4b");
    expect(r2.stdout).toContain("http://127.0.0.1:11434/v1");
    // apiKeyRef NAME visible
    expect(r2.stdout).toMatch(/apiKeyRef=MY_OPENAI_KEY(?:\s|$)/m);
    // values never echoed in any shape
    expect(r2.stdout).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}/);
    expect(r2.stdout).not.toMatch(/MY_OPENAI_KEY\s*=/); // no NAME=value
  });

  // S5 — "I typed something and the model server is down."
  // Goal: clean actionable message, NEVER a `fatal:` crash, non-zero exit.
  // S5 — "I configured naia-agent yesterday but the model server is now
  // down" (the natural user flow, cross-review A-F5 + C-F4). Login first,
  // then a turn against a dead port → clean hint, no fatal.
  it("S5 (natural flow) login → server dies → retry: clean hint, no fatal", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    runBin(
      ["login", "--adk", adk, "--main", "openai-compat|http://127.0.0.1:1/v1|absent"],
      coldEnv(home),
    );
    const r = runBin(["--no-tools", "hi"], coldEnv(home), undefined, 30_000);
    expect(r.stderr).not.toMatch(/naia-agent: fatal:/);
    expect(r.stderr).toMatch(/turn failed/);
    expect(r.stderr).toMatch(/unreachable|server|login/);
    expect(r.status).toBe(2);
  });

  // S5b — same shape, ENOTFOUND variant (typo'd hostname). Distinct
  // network failure mode; assert the same actionable guidance applies.
  it("S5b typo'd hostname (ENOTFOUND) → clean hint, no fatal crash", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    // Remote (non-loopback) base needs an explicit key for the resolver;
    // we inject a dummy key directly via env (the natural failure mode
    // for an apiKeyRef'd remote endpoint with a typo'd host).
    const r = runBin(["--no-tools", "hi"], coldEnv(home, {
      OPENAI_API_KEY: "test",
      OPENAI_BASE_URL: "http://nonexistent.invalid./v1",
      OPENAI_MODEL: "absent",
    }), undefined, 30_000);
    expect(r.stderr).not.toMatch(/naia-agent: fatal:/);
    expect(r.stderr).toMatch(/turn failed/);
    expect(r.status).toBe(2);
  });

  // S15 — "I just typed `pnpm naia-agent` with no prompt and no stdin."
  // Cross-review A-F2 (BLOCK): the most common first-time mistake had
  // zero coverage. Bin's piped-stdin empty path (~line 444) must emit
  // a clean "no prompt" + usage hint, exit 3, never crash.
  it("S15 empty stdin / no prompt → clean error, exit 3, usage hint", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const r = runBin(["--no-tools"], coldEnv(home, {
      OPENAI_API_KEY: "ollama",
      OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
      OPENAI_MODEL: "absent",
    }), "" /* empty stdin */, 15_000);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/no prompt|empty/i);
    expect(r.stderr).not.toMatch(/naia-agent: fatal:/);
  });

  // S6 — "I typed `pnpm naia-agent` against a local model that has no
  // native tool-calling (the most natural mistake)." Goal: clear hint
  // pointing to `--no-tools`, no fatal crash.
  it("S6 bare prompt vs tools-less local model → actionable --no-tools hint (no fatal)", { timeout: 120_000 }, async () => {
    if (!(await skipUnlessLlm())) return;
      const home = mkdtempSync(join(tmp, "home-"));
      const adk = mkdtempSync(join(tmp, "adk-"));
      runBin(
        ["login", "--adk", adk, "--main", "openai-compat|http://127.0.0.1:11434/v1|gemma3:4b"],
        coldEnv(home),
      );
      const r = runBin(["hi"], coldEnv(home), undefined, 90_000); // cross-review B-#2
      expect(r.stderr).not.toMatch(/naia-agent: fatal:/);
      expect(r.stderr).toMatch(/turn failed/);
      expect(r.stderr).toMatch(/no native tool-calling|--no-tools/i);
  });

  // S7 — "I want to chat with my local model" (the happy path).
  // Goal: a real Korean answer; `--no-tools` makes it work.
  // Cross-review (Slice 3-XR-I R5 finding): e4b cold-start can exceed
  // 90s when a bigger model (gemma4:31b 19.9GB) holds GPU cache; raise
  // to 200_000 (vitest it) + 180_000 (spawn) so the natural happy-path
  // does not fail on cache swap.
  it("S7 happy path one-shot with --no-tools → real model answer", { timeout: 480_000 }, async () => {
    if (!(await skipUnlessLlm())) return;
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    runBin(
      ["login", "--adk", adk, "--main", "openai-compat|http://127.0.0.1:11434/v1|gemma3:4b"],
      coldEnv(home),
    );
    // Cross-review (Slice 3-XR-J finding): when bigger models hold the
    // ollama cache, e4b cold-start can exceed 3 min on swap. Retry once
    // to filter out the cache-swap transient; the second attempt almost
    // always benefits from the now-warm slot.
    let r = runBin(
      ["--no-tools", "--no-default-system", "--system", "Reply concisely.", "Say hello in one word."],
      coldEnv(home),
      undefined,
      210_000,
    );
    if (r.status !== 0) {
      r = runBin(
        ["--no-tools", "--no-default-system", "--system", "Reply concisely.", "Say hello in one word."],
        coldEnv(home),
        undefined,
        210_000,
      );
    }
    expect(r.status).toBe(0);
    // some non-empty answer reached stdout; we don't assert language to
    // stay robust to model variance — only that it spoke at all.
    expect((r.stdout ?? "").trim().length).toBeGreaterThan(0);
    expect(r.stderr).not.toMatch(/turn failed|fatal/);
  });

  // S8 — "I told it a fact; the store actually persisted it cross-process."
  // Cross-review #2 #1: assert the MECHANISM (SQLite row), not model
  // output content. Small models are nondeterministic — flaky output
  // assertions are theater. The headline product claim is "the fact
  // persists across processes"; that's a file-system invariant.
  it("S8 --memory: a fact in process A persists to SQLite (cross-process invariant)", { timeout: 180_000 }, async () => {
    if (!(await skipUnlessLlm())) return;
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    runBin(
      [
        "login", "--adk", adk,
        "--main", "openai-compat|http://127.0.0.1:11434/v1|gemma3:4b",
        "--embedded", "ollama-embed|http://127.0.0.1:11434/v1|nomic-embed-text|768",
      ],
      coldEnv(home),
    );
    const a = runBin(
      ["--no-tools", "--memory", "내가 가장 좋아하는 색은 호박색(amber)이야. 기억해."],
      coldEnv(home), undefined, 90_000,
    );
    expect(a.status).toBe(0);
    const memDb = join(home, ".naia-agent", "memory", "cli.sqlite");
    expect(existsSync(memDb)).toBe(true);

    // Open the DB cross-process (the persistence claim) and assert the
    // fact is stored. Independent of the LLM model's recall behavior.
    const req = createRequire(import.meta.url);
    const Database = req("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(memDb, { readonly: true });
    try {
      const row = db
        .prepare<unknown[], { c: number }>("SELECT COUNT(*) AS c FROM lite_facts WHERE content LIKE ?")
        .get("%amber%");
      expect((row?.c ?? 0)).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  // S8-neg — without --memory, NO persistent store is ever created.
  // Cross-review #2 #4: file-system invariant, not model output.
  it("S8-neg without --memory: no persistent SQLite store is created", { timeout: 120_000 }, async () => {
    if (!(await skipUnlessLlm())) return;
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    runBin(
      ["login", "--adk", adk, "--main", "openai-compat|http://127.0.0.1:11434/v1|gemma3n:e4b"],
      coldEnv(home),
    );
    runBin(
      ["--no-tools", "내가 가장 좋아하는 색은 호박색(amber)이야."],
      coldEnv(home), undefined, 60_000,
    );
    const memDb = join(home, ".naia-agent", "memory", "cli.sqlite");
    expect(existsSync(memDb)).toBe(false); // ephemeral InMemoryMemory only
  });

  // ─── Expansion (round #3+, "신뢰성 높여줘"): deterministic mechanism tests ──

  // S9 — "I configured main yesterday; today I add sub without re-typing main."
  // Goal: a second `login` MERGES (does not clobber) untouched roles.
  it("S9 login merge: a second login preserves untouched roles", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    runBin(["login", "--adk", adk, "--main", "openai-compat|http://127.0.0.1:11434/v1|gemma3n:e4b"], coldEnv(home));
    runBin(["login", "--adk", adk, "--sub", "openai-compat|http://127.0.0.1:11434/v1|gemma3n:e2b"], coldEnv(home));
    const llm = JSON.parse(readFileSync(join(adk, "naia-settings", "llm.json"), "utf8"));
    expect(llm.main?.model).toBe("gemma3n:e4b"); // preserved
    expect(llm.sub?.model).toBe("gemma3n:e2b"); // added
  });

  // S10 — "I swapped the main model entirely."
  // Goal: re-login on the SAME role replaces it cleanly.
  it("S10 login swap: re-login on the same role replaces it", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    runBin(["login", "--adk", adk, "--main", "openai-compat|http://127.0.0.1:11434/v1|gemma3n:e4b"], coldEnv(home));
    runBin(["login", "--adk", adk, "--main", "openai-compat|http://127.0.0.1:11434/v1|gemma4:31b"], coldEnv(home));
    const llm = JSON.parse(readFileSync(join(adk, "naia-settings", "llm.json"), "utf8"));
    expect(llm.main?.model).toBe("gemma4:31b"); // swapped, no merge confusion
  });

  // S11 — "My llm.json got corrupted somehow (text editor, bad merge)."
  // Goal: graceful — no crash; show indicates parse failure / falls through.
  it("S11 malformed llm.json → show still works, no crash", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    runBin(["login", "--adk", adk, "--main", "openai-compat|http://127.0.0.1:11434/v1|gemma3n:e4b"], coldEnv(home));
    writeFileSync(join(adk, "naia-settings", "llm.json"), "{ not valid json");
    const r = runBin(["show"], coldEnv(home));
    expect(r.status).toBe(0); // never crashes
    expect(r.stdout).toContain("naia-agent show");
  });

  // S12 — "Someone wrote a bad embedded.dims value into my llm.json."
  // Goal: --memory falls back to ephemeral gracefully with a clear warning.
  it("S12 invalid embedded.dims → graceful ephemeral fallback (no crash)", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    mkdirSync(join(adk, "naia-settings"), { recursive: true });
    // Hand-author a settings with a bad embedded dim (0) — bypasses the
    // login-time guard since the user could edit the file manually.
    writeFileSync(
      join(adk, "naia-settings", "llm.json"),
      JSON.stringify({
        version: 1,
        main: { provider: "openai-compat", baseUrl: "http://127.0.0.1:1/v1", model: "x" },
        embedded: { provider: "ollama-embed", baseUrl: "http://127.0.0.1:1/v1", model: "x", dims: 0 },
      }),
    );
    const r = runBin(["--no-tools", "--memory", "hi"], coldEnv(home, { NAIA_ADK_PATH: adk }), undefined, 30_000);
    expect(r.stderr).toMatch(/falling back to ephemeral memory|embedded.*role/i);
    // Cross-review A-F10: assert the remediation breadcrumb so a user
    // with a hand-broken llm.json gets a clear path forward.
    expect(r.stderr).toMatch(/login|--embedded|dims/i);
    // Whatever happens after, it must NOT be a `fatal:` crash
    expect(r.stderr).not.toMatch(/naia-agent: fatal:/);
  });

  // S13 — "I have two terminals open and both write facts at once."
  // Goal: SQLite invariant — no corruption, both rows persisted.
  it.skipIf(true /* LLM-live + race: marked skip until determinism stabilized — tracked in CHANGELOG Deferred */)(
    "S13 concurrent --memory writes → both facts persist (no SQLite corruption)",
    async () => {
      if (!(await skipUnlessLlm())) return;
      const home = mkdtempSync(join(tmp, "home-"));
      const adk = mkdtempSync(join(tmp, "adk-"));
      runBin(
        ["login", "--adk", adk, "--main", "openai-compat|http://127.0.0.1:11434/v1|gemma3n:e4b",
         "--embedded", "ollama-embed|http://127.0.0.1:11434/v1|bge-m3|1024"],
        coldEnv(home),
      );
      // race the two writes by spawning roughly simultaneously
      const promises = [
        new Promise<void>((resolve) => {
          runBin(["--no-tools", "--memory", "fact-A: I like figs"], coldEnv(home), undefined, 120_000);
          resolve();
        }),
        new Promise<void>((resolve) => {
          runBin(["--no-tools", "--memory", "fact-B: I like dates"], coldEnv(home), undefined, 120_000);
          resolve();
        }),
      ];
      await Promise.all(promises);
      const memDb = join(home, ".naia-agent", "memory", "cli.sqlite");
      const req = createRequire(import.meta.url);
      const Database = req("better-sqlite3") as typeof import("better-sqlite3");
      const db = new Database(memDb, { readonly: true });
      try {
        const all = db
          .prepare<unknown[], { content: string }>("SELECT content FROM lite_facts")
          .all();
        const blob = all.map((r) => r.content).join("\n");
        expect(blob).toMatch(/figs/);
        expect(blob).toMatch(/dates/);
      } finally {
        db.close();
      }
    },
  );

  // ─── Deferred (explicit, honest) — see CHANGELOG [Slice 3-XR-F] ──────────
  // Cross-review C-F2 / A-F1 / D-F10 — these contracts are real but not
  // yet feasible to test as black-box bin scenarios in this harness:
  //   - 24G gemma4:31b live scenarios: reasoning/thinking channel makes
  //     OpenAI-compat content empty unless max_tokens is high; ollama
  //     parameter to suppress thinking is unresolved. Use `it.skipIf` once
  //     the parameter is wired or once a different model serves the 24G
  //     profile. Tracked in `.agents/progress/tier-8g-vs-24g-comparison-…`.
  //   - REPL multi-turn (`#history` threading): requires PTY emulation;
  //     `child_process.spawn` is non-TTY → bin falls to single-shot. A
  //     `node-pty` devDep would unblock this.
  //   - `--key REF=VAL` live keychain refusal under "keychain unavailable":
  //     deterministic ONLY by sandboxing the libsecret backend; deferred.
  //   - baseURL `?key=…` / `user:pass@host` leakage path: requires bin
  //     sanitization of URL before stderr printing; tracked separately.
  //   - Supervisor mode, REPL `exit`/`quit`, Vertex / GLM provider branches.
  it.skipIf(true /* 24G live measurement deferred — see comment above */)(
    "S20 24G gemma4:31b live scenario (reasoning suppression TBD)",
    () => {
      /* placeholder — re-enable once thinking-mode UX is solved */
    },
  );
});

describe("(2) naia-os SHELL perspective — gateway-mediated config", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-gw-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // G1 — Shell configures naia-agent to route through the any-llm gateway
  // (openai-compat URL + apiKeyRef NAME, no key value). Per
  // [[feedback_naia_agent_gateway_only]] the gateway is just an openai-compat
  // endpoint to naia-agent; no naia-agent code change. show must reflect
  // gateway baseURL + the ref NAME — and never the key value.
  it("G1 shell-style gateway config: show reflects gateway URL + apiKeyRef NAME (no value)", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    const r1 = runBin(
      [
        "login",
        "--adk",
        adk,
        "--main",
        "openai-compat|https://gateway.example/v1|naia-coding|GATEWAY_API_KEY",
      ],
      coldEnv(home),
    );
    expect(r1.status).toBe(0);
    const r2 = runBin(["show"], coldEnv(home));
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain("https://gateway.example/v1");
    expect(r2.stdout).toContain("naia-coding");
    expect(r2.stdout).toContain("apiKeyRef=GATEWAY_API_KEY");
    // No real key value — only the ref NAME is visible. Cross-review F2:
    // the prior `[^N]` heuristic was near-vacuous; assert two real
    // invariants instead.
    expect(r2.stdout).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}/);
    // (a) No `*_API_KEY|*_TOKEN|*_SECRET|*_PASSWORD = <value>` shape for
    // ANY env var (cross-review #2 #9 — generic suffix covers new
    // credentials added later, consistent w/ bin SENSITIVE_ENV_PATTERNS).
    expect(r2.stdout).not.toMatch(/_(API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S/);
    // (b) The ref NAME is shown exactly as `apiKeyRef=GATEWAY_API_KEY` with
    // nothing trailing after the name (newline/end-of-output, no `=value`).
    expect(r2.stdout).toMatch(/apiKeyRef=GATEWAY_API_KEY(?:\s|$)/m);
  });

  // G2 — Shell must not accidentally write a key into the git-tracked
  // llm.json (the no-plaintext invariant from the user's hard line).
  // If the shell passes a raw secret in the apiKeyRef slot, login REFUSES.
  it("G2 shell cannot footgun a raw secret into the apiKeyRef slot (login refuses)", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    const r = runBin(
      [
        "login",
        "--adk",
        adk,
        "--main",
        "anthropic|https://api.anthropic.com|claude-x|sk-ant-REALSECRET0123456789",
      ],
      coldEnv(home),
    );
    expect(r.status).toBe(3);
    // Cross-review C-F13: tolerant of rephrasing (RAW SECRET / RAW CREDENTIAL /
    // "looks like a secret") so cosmetic changes don't break the test, but
    // still requires the semantic anchor of "raw secret/credential".
    expect(r.stderr).toMatch(/raw.{0,12}(secret|credential)|looks like.{0,20}(secret|credential)/i);
    // llm.json must NOT have been written with the raw secret
    const llmPath = join(adk, "naia-settings", "llm.json");
    if (existsSync(llmPath)) {
      const content = readFileSync(llmPath, "utf8");
      expect(content).not.toContain("sk-ant-REALSECRET");
    }
  });

  // ─── Expansion: adk target — Claude Code-compatible harness routing ──

  // G3 — "The naia-os shell hands the user a service manifest with
  // `backend: claude-code` (the subscription path)." Goal: the bin
  // routes to the claude-code provider WITHOUT requiring an API key
  // (Claude Code CLI's own OAuth handles auth). NAIA_AGENT_DRYRUN=1 skips
  // the actual model invocation — we verify the routing dispatch only.
  // Deterministic; no live LLM required.
  it("G3 service manifest backend=claude-code → bin routes to claude-code provider (no API key)", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const manifestDir = mkdtempSync(join(tmp, "mfst-"));
    const manifestPath = join(manifestDir, "cc.service.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: "0.1.0",
        name: "test-cc",
        persona: { systemPrompt: "terse" },
        llm: { backend: "claude-code", model: "sonnet" },
        memory: { binding: "in-memory" },
      }),
    );
    const r = runBin(
      ["hi", "--service", manifestPath],
      coldEnv(home, { NAIA_AGENT_DRYRUN: "1" }),
    );
    expect(r.status).toBe(0); // DRYRUN exits 0 after routing
    expect(r.stderr).toContain("provider=claude-code"); // routed correctly
    expect(r.stderr).not.toMatch(/no LLM provider configured/); // not the fallback path
  });

  // G4 — "The shell wrote a broken manifest (typo, partial save)."
  // Goal: bin reports a clean parse error and exits 3 (usage class),
  // does NOT crash with `fatal:`.
  it("G4 malformed service manifest → graceful parse error, no crash", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const manifestDir = mkdtempSync(join(tmp, "mfst-"));
    const manifestPath = join(manifestDir, "broken.service.json");
    writeFileSync(manifestPath, "{ not valid json"); // syntactically broken
    const r = runBin(["hi", "--service", manifestPath], coldEnv(home));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/manifest|invalid|json|parse/i);
    expect(r.stderr).not.toMatch(/naia-agent: fatal:/);
    // Cross-review A-F8: the user with multiple manifests must know
    // WHICH one parsed wrong — path must appear in the error.
    expect(r.stderr).toContain(manifestPath);
  });

  // G2b — broader raw-secret coverage (cross-review C-F8 + D-F5):
  // login refuses other realistic secret shapes (AIza Google API key,
  // ghp_ GitHub PAT) — symmetric with G2's sk-ant case.
  it("G2b raw Google API key (AIza…) in apiKeyRef slot → refused", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    const r = runBin(
      ["login", "--adk", adk, "--main", "openai-compat|https://gw.example/v1|m|AIzaSyA0123456789ABCDEFGHIJK"],
      coldEnv(home),
    );
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/raw.{0,12}(secret|credential)|looks like.{0,20}(secret|credential)/i);
  });
  it("G2c raw GitHub PAT (ghp_…) in apiKeyRef slot → refused", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    const r = runBin(
      ["login", "--adk", adk, "--main", "openai-compat|https://gw.example/v1|m|ghp_0123456789abcdef0123456789abcdef0123"],
      coldEnv(home),
    );
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/raw.{0,12}(secret|credential)|looks like.{0,20}(secret|credential)/i);
  });
  // G2d (positive control) — a legitimate ref NAME containing `_KEY`
  // must NOT be confused with a secret (boundary check, no false-positive).
  it("G2d legitimate apiKeyRef NAME (containing _KEY) is accepted", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    const r = runBin(
      ["login", "--adk", adk, "--main", "anthropic|https://api.anthropic.com|claude-x|MY_LEGITIMATE_KEY_NAME"],
      coldEnv(home),
    );
    expect(r.status).toBe(0); // accepted — name boundary preserved
    const llm = JSON.parse(readFileSync(join(adk, "naia-settings", "llm.json"), "utf8"));
    expect(llm.main?.apiKeyRef).toBe("MY_LEGITIMATE_KEY_NAME");
  });
});
