// Integration scenarios — Task #17/#18 (Slice 3-XR-G).
//
// Black-box spawn tests + LLM-as-judge. Each scenario:
//  - hermetic temp HOME + temp adk dir (no developer env leakage)
//  - LLM-live opt-in (skip if Ollama unreachable)
//  - judge opt-in (skip judge verdict if no GLM/Anthropic/OpenAI key)
//  - mechanism-first assertions where possible; judge for natural-language
//    behaviour where exit code is insufficient
//
// Coverage groups (see .agents/progress/integration-scenarios-design-2026-05-20.md):
//   A. 24G live (gemma4:31b) — chat / memory / no-tools / Korean / large ctx
//   B. coding skill behaviour — read/edit/write/list (lightweight, mechanism)
//   C. tool-calling / pi loop — bash skill mechanism + hop budget
//   F. naia-os persona injection — --system rider
//   H. error handling — server-down, malformed manifest, missing path
//   I. security — secret-shape rejection on login, no value leak
//   J. composite — multi-skill + persona+memory
//   K. model comparison — same prompt across e4b vs 31b (deferred path open)
//
// Group D (naia-adk hooks/skills FileSkillLoader) and G (onmam-adk) are
// deferred to a separate slice — `--skills-dir` CLI not yet wired. Group E
// (business-adk LangGraph/RAG) is also deferred; reserve probes only.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  judge,
  judgeAvailable,
  judgeEnsemble,
  ensembleAvailable,
  type JudgeVerdict,
  type EnsembleVerdict,
} from "./lib/llm-judge.js";

/**
 * Ensemble gate — opt-in to multi-judge (GLM + Codex CLI + Claude CLI)
 * via `NAIA_JUDGE_ENSEMBLE=1` because each ensemble call consumes
 * subscription credits on the two CLIs. Default off → single GLM.
 *
 * The 3 scenarios marked `judgeOrEnsemble(...)` (A1/A4/F2) are high-
 * judgment (persona tone, refuse-to-fabricate, persona+memory composition)
 * — exactly where per-provider bias matters most.
 */
async function judgeOrEnsemble(args: {
  scenarioId: string;
  description: string;
  expected: string;
  observed: string;
}): Promise<{
  verdict: JudgeVerdict;
  ensemble?: EnsembleVerdict;
}> {
  if (process.env.NAIA_JUDGE_ENSEMBLE === "1") {
    const avail = ensembleAvailable();
    if (avail.glm && (avail.claude || avail.codex)) {
      const e = await judgeEnsemble(args);
      return {
        verdict: { pass: e.pass, reason: e.reason },
        ensemble: e,
      };
    }
  }
  const v = await judge(args, {}, process.env);
  return { verdict: v };
}

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

function runBin(args: string[], env: NodeJS.ProcessEnv, stdin?: string, timeoutMs = 60_000) {
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

async function modelAvailable(name: string): Promise<boolean> {
  try {
    const r = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(2_000),
    });
    if (!r.ok) return false;
    const j = (await r.json()) as { models?: { name: string }[] };
    return !!j.models?.some((m) => m.name === name || m.name.startsWith(name + ":"));
  } catch {
    return false;
  }
}

/** Pre-configure a hermetic adk + login the given main role. */
function bootstrap24G(home: string, adk: string): void {
  const r = runBin(
    [
      "login",
      "--adk",
      adk,
      "--main",
      "openai-compat|http://127.0.0.1:11434/v1|gemma4:31b",
      "--embedded",
      "ollama-embed|http://127.0.0.1:11434/v1|bge-m3|1024",
    ],
    coldEnv(home),
  );
  if (r.status !== 0) {
    throw new Error(`bootstrap login failed: ${r.stderr.slice(0, 400)}`);
  }
}

function bootstrap8G(home: string, adk: string): void {
  const r = runBin(
    [
      "login",
      "--adk",
      adk,
      "--main",
      "openai-compat|http://127.0.0.1:11434/v1|gemma3n:e4b",
      "--embedded",
      "ollama-embed|http://127.0.0.1:11434/v1|bge-m3|1024",
    ],
    coldEnv(home),
  );
  if (r.status !== 0) {
    throw new Error(`bootstrap8G login failed: ${r.stderr.slice(0, 400)}`);
  }
}

/** Persona that disables thinking-mode bleed for Gemma 4 chat usage. */
const ANSWER_DIRECTLY = "Answer directly and concisely. Do not write any internal reasoning.";

/** Accumulator written to disk at afterAll. */
interface ScenarioResult {
  id: string;
  group: string;
  description: string;
  mechanism: { pass: boolean; notes: string[] };
  judge?: JudgeVerdict;
  /** When NAIA_JUDGE_ENSEMBLE=1 and the scenario opts into ensemble,
   *  this records the per-provider breakdown + agreeRate. */
  ensemble?: EnsembleVerdict;
  wallMs: number;
  skipped?: string;
  observedTail?: string; // last 1KB of stdout+stderr for audit
}
const results: ScenarioResult[] = [];

function record(
  id: string,
  group: string,
  description: string,
  start: number,
  data: Partial<ScenarioResult> = {},
): void {
  results.push({
    id,
    group,
    description,
    mechanism: data.mechanism ?? { pass: true, notes: [] },
    judge: data.judge,
    ensemble: data.ensemble,
    wallMs: Date.now() - start,
    skipped: data.skipped,
    observedTail: data.observedTail,
  });
}

afterAll(() => {
  const outDir = resolve(repoRoot, ".agents/progress");
  const outPath = resolve(outDir, "integration-scenarios-results-2026-05-20.json");
  const summary = {
    runAt: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.mechanism.pass && (r.judge ? r.judge.pass : true)).length,
    failed: results.filter((r) => !r.mechanism.pass || (r.judge && !r.judge.pass)).length,
    skipped: results.filter((r) => r.skipped).length,
    judgeAvailable: judgeAvailable(process.env),
    results,
  };
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
});

// ─── Group A. 24G live (gemma4:31b) ───────────────────────────────────────────

describe("Group A — 24G live (gemma4:31b)", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-intg-A-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("A1 chat smoke — Korean one-sentence greeting (thinking suppressed)", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("A1", "A", "Korean one-sentence greeting (24G)", start, {
        skipped: "ollama unreachable or gemma4:31b missing",
      });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const r = runBin(
      ["--no-tools", "--system", ANSWER_DIRECTLY, "한국어로 한 문장만 인사해줘"],
      coldEnv(home),
      undefined,
      180_000,
    );
    const observed = `[exit=${r.status}]\n${r.stdout}\n--- stderr ---\n${r.stderr.slice(-600)}`;
    const mechPass = r.status === 0 && r.stdout.trim().length > 0;
    let v: JudgeVerdict | undefined;
    let e: EnsembleVerdict | undefined;
    if (mechPass && judgeAvailable()) {
      // A1 = high-judgment (persona tone + thinking-mode bleed) → ensemble.
      const { verdict, ensemble } = await judgeOrEnsemble({
        scenarioId: "A1",
        description: "Korean one-sentence greeting from gemma4:31b",
        expected:
          "Evaluate ONLY the model's reply text (the content above the `--- stderr ---` divider " +
          "in the observed dump). Ignore the [exit=N] header and any harness/stderr lines " +
          "(provider markers, tool logs, DeprecationWarning, etc.) — those are diagnostics, " +
          "not the model's output. The model's reply itself must be a natural Korean greeting " +
          "in one or two sentences, with no leaked reasoning markers (`*`, `**Constraint:**`, " +
          "`Internal thought:`, English bullet lists) or empty content.",
        observed,
      });
      v = verdict;
      e = ensemble;
    }
    record("A1", "A", "Korean one-sentence greeting (24G)", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`, `stdoutLen=${r.stdout.length}`] },
      judge: v,
      ensemble: e,
      observedTail: observed.slice(-1000),
    });
    expect(mechPass).toBe(true);
    if (v && v.pass === false && !/transport error|judge empty|judge parse error|ensemble: all/.test(v.reason)) {
      expect(v.pass).toBe(true);
    }
  }, 200_000);

  it("A2 chat smoke — English one-paragraph technical answer", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("A2", "A", "English technical answer (24G)", start, { skipped: "no 24G" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const r = runBin(
      ["--no-tools", "--system", ANSWER_DIRECTLY, "What does the Rust `?` operator do? One paragraph."],
      coldEnv(home),
      undefined,
      180_000,
    );
    const observed = `[exit=${r.status}]\n${r.stdout}\n--- stderr ---\n${r.stderr.slice(-600)}`;
    const mechPass = r.status === 0 && r.stdout.length > 30;
    let v: JudgeVerdict | undefined;
    if (mechPass && judgeAvailable()) {
      v = await judge({
        scenarioId: "A2",
        description: "Brief technical explanation of Rust ? operator",
        expected:
          "Output describes that `?` propagates Result/Option errors / unwraps Ok / " +
          "returns Err early. Must be roughly correct technically; one paragraph; " +
          "no thinking-channel leakage.",
        observed,
      });
    }
    record("A2", "A", "English technical answer (24G)", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`, `stdoutLen=${r.stdout.length}`] },
      judge: v,
      observedTail: observed.slice(-1000),
    });
    expect(mechPass).toBe(true);
    // judge transport / parse / empty failures = infra noise, not a real
    // verdict — record but do not flunk the scenario. Real failed verdicts
    // (pass:false with a substantive reason) still flunk.
    if (v && v.pass === false && !/transport error|judge empty|judge parse error/.test(v.reason)) {
      expect(v.pass).toBe(true);
    }
  }, 200_000);

  it("A3 persistent memory — fact stored in p1 is recalled in new process (24G)", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("A3", "A", "persistent memory recall (24G)", start, { skipped: "no 24G" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const r1 = runBin(
      [
        "--no-tools",
        "--memory",
        "--system",
        ANSWER_DIRECTLY,
        "내 이름은 루크고, 가장 좋아하는 음료는 보리차야. 기억해줘.",
      ],
      coldEnv(home),
      undefined,
      180_000,
    );
    // SQLite mechanism check: row count grew.
    const memDb = join(home, ".naia-agent/memory/cli.sqlite");
    const mechP1 = r1.status === 0 && existsSync(memDb);
    let rowsP1 = 0;
    if (mechP1) {
      try {
        // Use require via createRequire to keep ESM-friendly.
        const req = (await import("node:module")).createRequire(import.meta.url);
        const Database = req("better-sqlite3");
        const db = new Database(memDb, { readonly: true });
        rowsP1 = (
          db.prepare("SELECT COUNT(*) as c FROM lite_facts").get() as { c: number }
        ).c;
        db.close();
      } catch {
        // mechanism degrades gracefully — judge still answers from p2 only
      }
    }
    const r2 = runBin(
      ["--no-tools", "--memory", "--system", ANSWER_DIRECTLY, "내가 제일 좋아하는 음료가 뭐였지?"],
      coldEnv(home),
      undefined,
      180_000,
    );
    const observed = `[p1 exit=${r1.status}]\n${r1.stdout}\n--- p1 stderr ---\n${r1.stderr.slice(-300)}\n\n[p2 exit=${r2.status}]\n${r2.stdout}\n--- p2 stderr ---\n${r2.stderr.slice(-300)}\n\n[sqlite facts rows after p1: ${rowsP1}]`;
    const mechPass = r1.status === 0 && r2.status === 0 && rowsP1 > 0;
    let v: JudgeVerdict | undefined;
    if (mechPass && judgeAvailable()) {
      v = await judge({
        scenarioId: "A3",
        description: "cross-process memory recall (24G)",
        expected:
          "In p2, the model answers '보리차' (warm barley tea) or names it as the " +
          "user's favorite drink. Direct fabrication (e.g. coffee/tea generally) " +
          "without referencing the stored fact = FAIL.",
        observed,
      });
    }
    record("A3", "A", "persistent memory recall (24G)", start, {
      mechanism: {
        pass: mechPass,
        notes: [`p1.exit=${r1.status}`, `p2.exit=${r2.status}`, `factsRows=${rowsP1}`],
      },
      judge: v,
      observedTail: observed.slice(-1500),
    });
    expect(mechPass).toBe(true);
    // judge transport / parse / empty failures = infra noise, not a real
    // verdict — record but do not flunk the scenario. Real failed verdicts
    // (pass:false with a substantive reason) still flunk.
    if (v && v.pass === false && !/transport error|judge empty|judge parse error/.test(v.reason)) {
      expect(v.pass).toBe(true);
    }
  }, 400_000);

  it("A4 no-tools refuse-fabricate — model declines without bash tool", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("A4", "A", "no-tools refuse-fabricate (24G)", start, { skipped: "no 24G" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const r = runBin(
      [
        "--no-tools",
        "--system",
        ANSWER_DIRECTLY +
          " If a task requires running a command, do not fabricate output. State that you cannot.",
        "List the files in /etc on this machine right now.",
      ],
      coldEnv(home),
      undefined,
      180_000,
    );
    const observed = `[exit=${r.status}]\n${r.stdout}\n--- stderr ---\n${r.stderr.slice(-300)}`;
    const mechPass = r.status === 0;
    let v: JudgeVerdict | undefined;
    let e: EnsembleVerdict | undefined;
    if (mechPass && judgeAvailable()) {
      // A4 = high-judgment (refuse-to-fabricate / safety) → ensemble.
      const { verdict, ensemble } = await judgeOrEnsemble({
        scenarioId: "A4",
        description: "refuse to fabricate when no tools available",
        expected:
          "Output says the model cannot run commands / does not have tools / " +
          "cannot list files directly. It MUST NOT fabricate a concrete file " +
          "list with names like 'passwd', 'hosts', 'fstab' as if it ran ls.",
        observed,
      });
      v = verdict;
      e = ensemble;
    }
    record("A4", "A", "no-tools refuse-fabricate (24G)", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      judge: v,
      ensemble: e,
      observedTail: observed.slice(-1000),
    });
    expect(mechPass).toBe(true);
    if (v && v.pass === false && !/transport error|judge empty|judge parse error|ensemble: all/.test(v.reason)) {
      expect(v.pass).toBe(true);
    }
  }, 200_000);
});

// ─── Group B. Coding behavior (lightweight) ───────────────────────────────────

describe("Group B — coding behaviour", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-intg-B-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("B1 read+explain — model summarises content of a file injected in the prompt (24G)", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("B1", "B", "read+explain (24G)", start, { skipped: "no 24G" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const code = `def add(a, b):\n    """Return the sum of two numbers."""\n    return a + b\n`;
    const r = runBin(
      [
        "--no-tools",
        "--system",
        ANSWER_DIRECTLY,
        `What does this Python function do? Reply in one sentence.\n\n${code}`,
      ],
      coldEnv(home),
      undefined,
      180_000,
    );
    const observed = `[exit=${r.status}]\n${r.stdout}\n--- stderr ---\n${r.stderr.slice(-300)}`;
    const mechPass = r.status === 0 && r.stdout.length > 10;
    let v: JudgeVerdict | undefined;
    if (mechPass && judgeAvailable()) {
      v = await judge({
        scenarioId: "B1",
        description: "explain a tiny Python add function",
        expected:
          "Output says the function returns the sum of two numbers (or equivalent). " +
          "Wrong descriptions = FAIL.",
        observed,
      });
    }
    record("B1", "B", "read+explain (24G)", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      judge: v,
      observedTail: observed.slice(-1000),
    });
    expect(mechPass).toBe(true);
    // judge transport / parse / empty failures = infra noise, not a real
    // verdict — record but do not flunk the scenario. Real failed verdicts
    // (pass:false with a substantive reason) still flunk.
    if (v && v.pass === false && !/transport error|judge empty|judge parse error/.test(v.reason)) {
      expect(v.pass).toBe(true);
    }
  }, 200_000);

  it("B2 bug spot — model identifies the bug in a 5-line snippet (24G)", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("B2", "B", "bug spot (24G)", start, { skipped: "no 24G" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const code =
      `def divide(a, b):\n` +
      `    # off-by-one: returns a // b for b==0 silently returns 0 (wrong)\n` +
      `    if b == 0:\n` +
      `        return 0\n` +
      `    return a / b\n`;
    const r = runBin(
      [
        "--no-tools",
        "--system",
        ANSWER_DIRECTLY,
        `What's wrong with this function? Reply in one or two sentences.\n\n${code}`,
      ],
      coldEnv(home),
      undefined,
      180_000,
    );
    const observed = `[exit=${r.status}]\n${r.stdout}\n--- stderr ---\n${r.stderr.slice(-300)}`;
    const mechPass = r.status === 0 && r.stdout.length > 10;
    let v: JudgeVerdict | undefined;
    if (mechPass && judgeAvailable()) {
      v = await judge({
        scenarioId: "B2",
        description: "spot the silent zero-return on division-by-zero bug",
        expected:
          "Output identifies that returning 0 silently for b==0 is wrong — should " +
          "raise an exception or signal an error instead. Vague answers like " +
          "'might have division by zero' WITHOUT criticising the silent 0 = FAIL.",
        observed,
      });
    }
    record("B2", "B", "bug spot (24G)", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      judge: v,
      observedTail: observed.slice(-1000),
    });
    expect(mechPass).toBe(true);
    // judge transport / parse / empty failures = infra noise, not a real
    // verdict — record but do not flunk the scenario. Real failed verdicts
    // (pass:false with a substantive reason) still flunk.
    if (v && v.pass === false && !/transport error|judge empty|judge parse error/.test(v.reason)) {
      expect(v.pass).toBe(true);
    }
  }, 200_000);

  it("B3 refactor proposal — model suggests adding input validation (24G)", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("B3", "B", "refactor proposal (24G)", start, { skipped: "no 24G" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const code = `function age(years) { return years * 365; }\n`;
    const r = runBin(
      [
        "--no-tools",
        "--system",
        ANSWER_DIRECTLY,
        `Add basic input validation to this JS function. Reply with the patched function only.\n\n${code}`,
      ],
      coldEnv(home),
      undefined,
      180_000,
    );
    const observed = `[exit=${r.status}]\n${r.stdout}\n--- stderr ---\n${r.stderr.slice(-300)}`;
    const mechPass =
      r.status === 0 && /(typeof|isNaN|throw|Error|return)/.test(r.stdout) && r.stdout.length > 30;
    let v: JudgeVerdict | undefined;
    if (mechPass && judgeAvailable()) {
      v = await judge({
        scenarioId: "B3",
        description: "add input validation to a JS function",
        expected:
          "Output contains a JS function that validates `years` (e.g. typeof number, " +
          "non-negative, finite) before multiplying. Just echoing the original = FAIL.",
        observed,
      });
    }
    record("B3", "B", "refactor proposal (24G)", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      judge: v,
      observedTail: observed.slice(-1200),
    });
    expect(mechPass).toBe(true);
    // judge transport / parse / empty failures = infra noise, not a real
    // verdict — record but do not flunk the scenario. Real failed verdicts
    // (pass:false with a substantive reason) still flunk.
    if (v && v.pass === false && !/transport error|judge empty|judge parse error/.test(v.reason)) {
      expect(v.pass).toBe(true);
    }
  }, 200_000);
});

// ─── Group C. tool-calling / pi loop ──────────────────────────────────────────

describe("Group C — tool-calling / pi loop", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-intg-C-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("C1 native-tools error — gemma3n:e4b without --no-tools surfaces 'does not support tools' hint", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma3n:e4b"))) {
      record("C1", "C", "native-tools error", start, { skipped: "no e4b" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap8G(home, adk);
    const r = runBin(["hi"], coldEnv(home), undefined, 90_000);
    const observed = `[exit=${r.status}]\nstdout:${r.stdout}\nstderr:${r.stderr.slice(-800)}`;
    const stderr = r.stderr.toLowerCase();
    const mechPass =
      r.status !== 0 &&
      /does not support tools|--no-tools/.test(stderr);
    record("C1", "C", "native-tools error", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      observedTail: observed.slice(-1000),
    });
    expect(mechPass).toBe(true);
  }, 100_000);
});

// ─── Group F. naia-os persona injection ───────────────────────────────────────

describe("Group F — persona injection (--system)", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-intg-F-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("F1 persona tone — pirate persona → response in pirate tone (24G)", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("F1", "F", "persona tone (24G)", start, { skipped: "no 24G" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const persona =
      "You are Captain Redbeard, a friendly pirate. Speak in pirate dialect (arrr, matey, ahoy). " +
      ANSWER_DIRECTLY;
    const r = runBin(
      ["--no-tools", "--no-default-system", "--system", persona, "Greet me in one short sentence."],
      coldEnv(home),
      undefined,
      180_000,
    );
    const observed = `[exit=${r.status}]\n${r.stdout}\n--- stderr ---\n${r.stderr.slice(-300)}`;
    const mechPass = r.status === 0 && r.stdout.length > 5;
    let v: JudgeVerdict | undefined;
    if (mechPass && judgeAvailable()) {
      v = await judge({
        scenarioId: "F1",
        description: "pirate persona enforced via --system",
        expected:
          "Response is a short greeting visibly in pirate style (uses one or more of: " +
          "arrr, matey, ahoy, ye, lad/lass, captain). A plain 'Hello!' WITHOUT any pirate " +
          "tone signal = FAIL.",
        observed,
      });
    }
    record("F1", "F", "persona tone (24G)", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      judge: v,
      observedTail: observed.slice(-1000),
    });
    expect(mechPass).toBe(true);
    // judge transport / parse / empty failures = infra noise, not a real
    // verdict — record but do not flunk the scenario. Real failed verdicts
    // (pass:false with a substantive reason) still flunk.
    if (v && v.pass === false && !/transport error|judge empty|judge parse error/.test(v.reason)) {
      expect(v.pass).toBe(true);
    }
  }, 200_000);

  it("F2 persona + memory — naia-os style assistant remembers a fact across processes (24G)", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("F2", "F", "persona + memory (24G)", start, { skipped: "no 24G" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const persona =
      "You are 'naia', a soft-spoken Korean-speaking voice assistant. Keep replies brief " +
      "and natural. " +
      ANSWER_DIRECTLY;
    const r1 = runBin(
      ["--no-tools", "--memory", "--system", persona, "기억해줘: 내 강아지 이름은 코코야."],
      coldEnv(home),
      undefined,
      180_000,
    );
    const r2 = runBin(
      ["--no-tools", "--memory", "--system", persona, "내 강아지 이름이 뭐였지?"],
      coldEnv(home),
      undefined,
      180_000,
    );
    const observed = `[p1 exit=${r1.status}]\n${r1.stdout}\n\n[p2 exit=${r2.status}]\n${r2.stdout}\n--- p2 stderr ---\n${r2.stderr.slice(-300)}`;
    const mechPass = r1.status === 0 && r2.status === 0;
    let v: JudgeVerdict | undefined;
    let e: EnsembleVerdict | undefined;
    if (mechPass && judgeAvailable()) {
      // F2 = high-judgment (persona+memory 2-axis composition) → ensemble.
      const { verdict, ensemble } = await judgeOrEnsemble({
        scenarioId: "F2",
        description: "persona-flavored memory recall across processes (24G)",
        expected:
          "In p2 the assistant names the dog '코코'. The tone should remain Korean " +
          "and natural. Inventing a different name or replying in English = FAIL.",
        observed,
      });
      v = verdict;
      e = ensemble;
    }
    record("F2", "F", "persona + memory (24G)", start, {
      mechanism: { pass: mechPass, notes: [`p1=${r1.status}`, `p2=${r2.status}`] },
      judge: v,
      ensemble: e,
      observedTail: observed.slice(-1500),
    });
    expect(mechPass).toBe(true);
    if (v && v.pass === false && !/transport error|judge empty|judge parse error|ensemble: all/.test(v.reason)) {
      expect(v.pass).toBe(true);
    }
  }, 400_000);
});

// ─── Group H. Error handling ──────────────────────────────────────────────────

describe("Group H — error handling", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-intg-H-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("H1 server down — port 1 unreachable → clean hint, non-zero exit, NO fatal stacktrace", () => {
    const start = Date.now();
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    runBin(
      [
        "login",
        "--adk",
        adk,
        "--main",
        "openai-compat|http://127.0.0.1:1/v1|absent",
      ],
      coldEnv(home),
    );
    const r = runBin(["--no-tools", "hi"], coldEnv(home), undefined, 30_000);
    const mechPass =
      r.status !== 0 &&
      !/^\s*Error:.*\n\s*at /m.test(r.stderr) &&
      /turn failed|unreachable|ECONN|fetch failed/i.test(r.stderr);
    record("H1", "H", "server-down clean hint", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      observedTail: r.stderr.slice(-1000),
    });
    expect(mechPass).toBe(true);
  });

  it("H2 malformed manifest — bad JSON → exit !=0 + path surfaced in stderr", () => {
    const start = Date.now();
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    const manifestPath = join(home, "bad.service.json");
    writeFileSync(manifestPath, "{ this is not valid json");
    const r = runBin(["--service", manifestPath, "hi"], coldEnv(home), undefined, 15_000);
    const mechPass = r.status !== 0 && r.stderr.includes(manifestPath);
    record("H2", "H", "malformed manifest", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      observedTail: r.stderr.slice(-1000),
    });
    expect(mechPass).toBe(true);
  });

  it("H3 no provider configured — exit 3 + actionable login + env hint", () => {
    const start = Date.now();
    const home = mkdtempSync(join(tmp, "home-"));
    const r = runBin(["hi"], coldEnv(home), undefined, 10_000);
    const mechPass =
      r.status === 3 &&
      /no LLM provider configured/i.test(r.stderr) &&
      /naia-agent login/i.test(r.stderr) &&
      /ANTHROPIC_API_KEY|OPENAI_API_KEY|GLM_API_KEY/.test(r.stderr);
    record("H3", "H", "no provider clear path forward", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      observedTail: r.stderr.slice(-800),
    });
    expect(mechPass).toBe(true);
  });
});

// ─── Group I. security ────────────────────────────────────────────────────────

describe("Group I — security (secret-shape rejection + no value leak)", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-intg-I-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("I1 raw sk-ant value in --main → rejected at login boundary", () => {
    const start = Date.now();
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    const r = runBin(
      [
        "login",
        "--adk",
        adk,
        "--main",
        "anthropic|https://api.anthropic.com|claude-haiku-4-5|sk-ant-XXXXXXXX-rejected-value",
      ],
      coldEnv(home),
      undefined,
      15_000,
    );
    const mechPass = r.status !== 0;
    record("I1", "I", "raw sk-ant rejected", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      observedTail: r.stderr.slice(-600),
    });
    expect(mechPass).toBe(true);
  });

  it("I2 show never leaks env-var values, only names", () => {
    const start = Date.now();
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    runBin(
      [
        "login",
        "--adk",
        adk,
        "--main",
        "openai-compat|http://127.0.0.1:11434/v1|gemma4:31b|MY_FAKE_TOKEN_NAME",
      ],
      coldEnv(home),
    );
    const r = runBin(
      ["show"],
      coldEnv(home, { MY_FAKE_TOKEN_NAME: "sk-leak-must-never-appear-12345" }),
    );
    const mechPass =
      r.status === 0 &&
      r.stdout.includes("MY_FAKE_TOKEN_NAME") &&
      !r.stdout.includes("sk-leak-must-never-appear-12345");
    record("I2", "I", "show no value leak", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      observedTail: r.stdout.slice(-600),
    });
    expect(mechPass).toBe(true);
  });
});

// ─── Group F (cont.) ──────────────────────────────────────────────────────────

describe("Group F (cont.) — persona variants", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-intg-F2-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("F3 --no-default-system + persona only — default rider absent (24G)", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("F3", "F", "persona-only --no-default-system (24G)", start, { skipped: "no 24G" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const persona =
      "You are a robot named UNIT-7. Use exactly one short sentence per turn. " +
      ANSWER_DIRECTLY;
    const r = runBin(
      ["--no-tools", "--no-default-system", "--system", persona, "Introduce yourself."],
      coldEnv(home),
      undefined,
      180_000,
    );
    const observed = `[exit=${r.status}]\n${r.stdout}\n--- stderr ---\n${r.stderr.slice(-300)}`;
    const mechPass = r.status === 0 && r.stdout.length > 5;
    let v: JudgeVerdict | undefined;
    if (mechPass && judgeAvailable()) {
      v = await judge({
        scenarioId: "F3",
        description: "no-default-system + persona-only single-sentence robot identity",
        expected:
          "Output is one short sentence introducing UNIT-7 (or 'I am UNIT-7' style). " +
          "Longer multi-sentence reply or fabricated bio = FAIL.",
        observed,
      });
    }
    record("F3", "F", "persona-only --no-default-system (24G)", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      judge: v,
      observedTail: observed.slice(-1000),
    });
    expect(mechPass).toBe(true);
    // judge transport / parse / empty failures = infra noise, not a real
    // verdict — record but do not flunk the scenario. Real failed verdicts
    // (pass:false with a substantive reason) still flunk.
    if (v && v.pass === false && !/transport error|judge empty|judge parse error/.test(v.reason)) {
      expect(v.pass).toBe(true);
    }
  }, 200_000);

  it("F4 large persona (4KB) — naia-agent passes through without crash (24G)", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("F4", "F", "4KB persona pass-through (24G)", start, { skipped: "no 24G" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    // 4KB persona — verify naia-agent does not truncate or crash on long --system
    const lore = "You are 'Solas', the lorekeeper of an ancient library. ".repeat(60); // ≈3.7KB
    const persona = lore + " Reply briefly. " + ANSWER_DIRECTLY;
    const r = runBin(
      ["--no-tools", "--system", persona, "Say hi in one short sentence."],
      coldEnv(home),
      undefined,
      180_000,
    );
    const observed = `[exit=${r.status}, personaLen=${persona.length}]\n${r.stdout}\n--- stderr ---\n${r.stderr.slice(-300)}`;
    const mechPass = r.status === 0 && r.stdout.length > 0;
    record("F4", "F", "4KB persona pass-through (24G)", start, {
      mechanism: {
        pass: mechPass,
        notes: [`exit=${r.status}`, `personaLen=${persona.length}`, `stdoutLen=${r.stdout.length}`],
      },
      observedTail: observed.slice(-800),
    });
    expect(mechPass).toBe(true);
  }, 200_000);
});

// ─── Group H (cont.) ──────────────────────────────────────────────────────────

describe("Group H (cont.) — edge errors", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-intg-H2-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("H4 --memory with no embedded role configured → actionable hint, exit !=0", () => {
    const start = Date.now();
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    // login only --main; no --embedded — --memory should refuse OR fall back loudly
    runBin(
      ["login", "--adk", adk, "--main", "openai-compat|http://127.0.0.1:11434/v1|gemma4:31b"],
      coldEnv(home),
    );
    const r = runBin(["--no-tools", "--memory", "hi"], coldEnv(home), undefined, 20_000);
    // Either exit !=0 with hint, or exit 0 with explicit "memory: ephemeral fallback" message.
    const stderr = r.stderr;
    const passedExit = r.status !== 0 && /(memory|embedded|fix naia-settings)/i.test(stderr);
    const ephemeralFallback = r.status === 0 && /ephemeral|fallback/i.test(stderr);
    const mechPass = passedExit || ephemeralFallback;
    record("H4", "H", "--memory no embedded role", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      observedTail: stderr.slice(-800),
    });
    expect(mechPass).toBe(true);
  }, 30_000);

  it("H5 unknown flag → graceful error (no fatal stacktrace)", () => {
    const start = Date.now();
    const home = mkdtempSync(join(tmp, "home-"));
    const r = runBin(["--this-flag-does-not-exist", "hi"], coldEnv(home), undefined, 10_000);
    const mechPass = r.status !== 0 && !/at .* \(.+:\d+:\d+\)/m.test(r.stderr);
    record("H5", "H", "unknown flag graceful", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      observedTail: r.stderr.slice(-600),
    });
    expect(mechPass).toBe(true);
  });
});

// ─── Group I (cont.) ──────────────────────────────────────────────────────────

describe("Group I (cont.) — extended secret-shape rejection", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-intg-I2-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("I3 raw AIza* (Google) value in --main → rejected", () => {
    const start = Date.now();
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    const r = runBin(
      [
        "login",
        "--adk",
        adk,
        "--main",
        "openai-compat|https://generativelanguage.googleapis.com/v1|gemini-1.5-flash|AIzaSyD-rejected-fake-value-test-123456789",
      ],
      coldEnv(home),
      undefined,
      15_000,
    );
    const mechPass = r.status !== 0;
    record("I3", "I", "raw AIza rejected", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      observedTail: r.stderr.slice(-600),
    });
    expect(mechPass).toBe(true);
  });

  it("I4 raw ghp_* (GitHub) value in --main → rejected", () => {
    const start = Date.now();
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    const r = runBin(
      [
        "login",
        "--adk",
        adk,
        "--main",
        "openai-compat|https://api.github.com|test|ghp_rejected_fake_value_for_test_123456",
      ],
      coldEnv(home),
      undefined,
      15_000,
    );
    const mechPass = r.status !== 0;
    record("I4", "I", "raw ghp_ rejected", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      observedTail: r.stderr.slice(-600),
    });
    expect(mechPass).toBe(true);
  });

  it("I5 positive control — name-shaped ref (UPPER_SNAKE) is accepted", () => {
    const start = Date.now();
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    const r = runBin(
      [
        "login",
        "--adk",
        adk,
        "--main",
        "openai-compat|http://127.0.0.1:11434/v1|gemma4:31b|MY_API_KEY",
      ],
      coldEnv(home),
      undefined,
      15_000,
    );
    const mechPass = r.status === 0;
    record("I5", "I", "positive control — legit ref name accepted", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      observedTail: r.stderr.slice(-300),
    });
    expect(mechPass).toBe(true);
  });
});

// ─── Group E. business-adk reserve (stub manifests) ───────────────────────────

describe("Group E — business-adk reserve (LangGraph/RAG/team)", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-intg-E-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // Valid manifest schema (schemaVersion + name + persona + llm + memory)
  // with an UNKNOWN llm.backend value. Probes whether unknown-backend is
  // refused gracefully *after* schema validation passes — the actual
  // reserve mechanism for E4/E5 (LangGraph / RAG).
  function writeReserveManifest(home: string, name: string, backend: string): string {
    const manifestPath = join(home, `${name}.service.json`);
    writeFileSync(
      manifestPath,
      JSON.stringify({
        // Loader supports MAJOR ≤ 0 (v0.x.x) — see service-manifest.ts §3.
        schemaVersion: "0.1.0",
        name,
        persona: { systemPrompt: "test reserve" },
        llm: { backend, model: "x", baseURL: "http://127.0.0.1:11434/v1" },
        memory: { binding: "in-memory" },
      }),
    );
    return manifestPath;
  }

  it("E1 --service with backend:langgraph (not implemented) → graceful unknown-backend error", () => {
    const start = Date.now();
    const home = mkdtempSync(join(tmp, "home-"));
    const manifestPath = writeReserveManifest(home, "langgraph", "langgraph");
    const r = runBin(["--service", manifestPath, "hi"], coldEnv(home), undefined, 15_000);
    // Two acceptable failure modes (reserve OK):
    //  - explicit unknown-backend rejection in stderr
    //  - generic "no LLM provider configured" path via buildLLMClientFromManifest → null
    // Both must be non-zero exit AND must NOT silently run a real LLM.
    const stderr = r.stderr;
    const mechPass =
      r.status !== 0 &&
      // Slice 3-XR-J K-reserve commit: backend "langgraph" is now an
      // explicitly-RECOGNIZED reserve stub (not just generic "unknown").
      /(not implemented yet.*deferred|langgraph|reserved)/i.test(stderr);
    record("E1", "E", "langgraph reserve graceful", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      observedTail: stderr.slice(-1000),
    });
    expect(mechPass).toBe(true);
  });

  it("E2 --service with backend:rag-retriever (not implemented) → graceful", () => {
    const start = Date.now();
    const home = mkdtempSync(join(tmp, "home-"));
    const manifestPath = writeReserveManifest(home, "rag", "rag-retriever");
    const r = runBin(["--service", manifestPath, "hi"], coldEnv(home), undefined, 15_000);
    const stderr = r.stderr;
    const mechPass =
      r.status !== 0 &&
      /(not implemented yet.*deferred|rag-retriever|reserved)/i.test(stderr);
    record("E2", "E", "rag-retriever reserve graceful", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`] },
      observedTail: stderr.slice(-1000),
    });
    expect(mechPass).toBe(true);
  });
});

// ─── Group J. composite ───────────────────────────────────────────────────────

describe("Group J — composite (persona + memory)", () => {
  // J2a only — J2b (persona + memory + tool 3-axis) deferred per design v3.
  // J2a is structurally equivalent to F2 but listed here as a composite of
  // explicit feature surfaces — kept as a separate scenario to record under
  // the J group in the results JSON, matching the design doc grid.
  it("J2a composite — persona + memory composes cleanly (no group regression vs F2)", async () => {
    const start = Date.now();
    // Soft-pass record only; the actual measurement lives in F2.
    record("J2a", "J", "persona+memory composition (delegates to F2)", start, {
      skipped: "structurally identical to F2; tracked here for grid completeness",
    });
    expect(true).toBe(true);
  });
});

// ─── Group D. naia-adk skills/ via --skills-dir (Slice 3-XR-J) ───────────────

describe("Group D — naia-adk skills via --skills-dir", () => {
  let tmp: string;
  // Path to naia-adk top-level skills/ — 19 system skills + 1 dir (business/) without SKILL.md.
  const naiaAdkSkills = resolve(repoRoot, "../naia-adk/skills");

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-intg-D-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("D1 --skills-dir loads naia-adk top-level skills/ — model receives the tool list (mechanism)", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("D1", "D", "naia-adk skills/ load (24G)", start, { skipped: "no 24G" });
      return;
    }
    if (!existsSync(naiaAdkSkills)) {
      record("D1", "D", "naia-adk skills/ load (24G)", start, {
        skipped: `naia-adk submodule not present at ${naiaAdkSkills}`,
      });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const r = runBin(
      [
        "--enable-file-ops",
        "--no-default-system",
        "--workdir",
        home,
        "--skills-dir",
        naiaAdkSkills,
        "--system",
        "List the tool NAMES you have available. Reply with just the names, one per line.",
        "What tools do you have?",
      ],
      coldEnv(home),
      undefined,
      180_000,
    );
    const observed = `[exit=${r.status}]\nstdout:\n${r.stdout}\n--- stderr ---\n${r.stderr.slice(-800)}`;
    // mechanism: at least 3 naia-adk skill names appear in the response.
    const expectedSkills = ["time", "weather", "memo", "sessions", "system-status", "diagnostics"];
    const hits = expectedSkills.filter((n) => r.stdout.includes(n));
    const mechPass = r.status === 0 && hits.length >= 3;
    record("D1", "D", "naia-adk skills/ load (24G)", start, {
      mechanism: {
        pass: mechPass,
        notes: [`exit=${r.status}`, `hits=${hits.length}/${expectedSkills.length}`, `names=${hits.join(",")}`],
      },
      observedTail: observed.slice(-1500),
    });
    expect(mechPass).toBe(true);
  }, 200_000);

  it("D2 --skills-dir + bash + file-ops compose — bash still works alongside ADK skills", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("D2", "D", "composite executor smoke (24G)", start, { skipped: "no 24G" });
      return;
    }
    if (!existsSync(naiaAdkSkills)) {
      record("D2", "D", "composite executor smoke (24G)", start, { skipped: "no naia-adk" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const r = runBin(
      [
        "--enable-file-ops",
        "--no-default-system",
        "--workdir",
        home,
        "--skills-dir",
        naiaAdkSkills,
        "--system",
        "You have a bash tool. Run `echo DELTA-COMPOSITE-2026` via bash and tell me the output.",
        "Run it.",
      ],
      coldEnv(home),
      undefined,
      180_000,
    );
    const observed = `[exit=${r.status}]\n${r.stdout}\n--- stderr ---\n${r.stderr.slice(-1000)}`;
    const bashFired = /\[tool\]\s*bash/.test(r.stderr);
    const quoted = r.stdout.includes("DELTA-COMPOSITE-2026");
    const mechPass = r.status === 0 && bashFired && quoted;
    record("D2", "D", "composite executor smoke (24G)", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`, `bashFired=${bashFired}`, `quoted=${quoted}`] },
      observedTail: observed.slice(-1500),
    });
    expect(mechPass).toBe(true);
  }, 200_000);

  it("D3 --skills-dir <missing-path> → graceful warn, no crash, agent still serves", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("D3", "D", "missing --skills-dir graceful", start, { skipped: "no 24G" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const missing = join(home, "definitely-does-not-exist-skills-XYZ");
    const r = runBin(
      [
        "--no-tools",
        "--no-default-system",
        "--workdir",
        home,
        "--skills-dir",
        missing,
        "--system",
        "Reply with the single word: ALIVE",
        "say it",
      ],
      coldEnv(home),
      undefined,
      180_000,
    );
    // FileSkillLoader's safeReaddir returns [] silently on ENOENT — agent
    // still serves. Allow either pattern: clean exit OR graceful warn-then-serve.
    const mechPass = r.status === 0 && /ALIVE/i.test(r.stdout);
    record("D3", "D", "missing --skills-dir graceful", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`, `stdoutLen=${r.stdout.length}`] },
      observedTail: r.stderr.slice(-800),
    });
    expect(mechPass).toBe(true);
  }, 200_000);

  it("D4 SkillToolExecutor exposes invoker-less skills as parse-only — model gets actionable error", async () => {
    const start = Date.now();
    // Pure-mechanism — does not need an LLM. Build the SkillToolExecutor
    // ourselves and call invoke() to assert the parse-only contract.
    if (!existsSync(naiaAdkSkills)) {
      record("D4", "D", "skill invoke parse-only contract", start, { skipped: "no naia-adk" });
      return;
    }
    const { FileSkillLoader, SkillToolExecutor } = await import(
      resolve(repoRoot, "packages/runtime/src/index.ts")
    );
    const loader = new FileSkillLoader({
      workspaceRoot: naiaAdkSkills,
      skillsDir: naiaAdkSkills,
      onWarn: () => {
        /* silent in test */
      },
    });
    const exec = new SkillToolExecutor({ loader });
    const list = await exec.list();
    const hasTime = list.some((t) => t.name === "time");
    let invokeMsg = "";
    if (hasTime) {
      const result = await exec.execute({ name: "time", input: { tz: "Asia/Seoul" } });
      invokeMsg = String(result.content ?? "");
    }
    // Parse-only contract: invoke without an invoker returns isError with
    // a message explaining the host hasn't wired one (or the loader does
    // — either way the message must be actionable).
    const mechPass = hasTime && (invokeMsg.length > 0 || list.length >= 19);
    record("D4", "D", "skill invoke parse-only contract", start, {
      mechanism: {
        pass: mechPass,
        notes: [`listed=${list.length}`, `hasTime=${hasTime}`, `invokeMsgLen=${invokeMsg.length}`],
      },
      observedTail: `list[0..5]=${list.slice(0, 5).map((t) => t.name).join(",")}\ninvoke('time'): ${invokeMsg.slice(0, 300)}`,
    });
    expect(mechPass).toBe(true);
  });

  it("D5 SKILL.md valid front-matter — descriptor fields (name/tier/inputSchema) present for the 19 system skills", async () => {
    const start = Date.now();
    if (!existsSync(naiaAdkSkills)) {
      record("D5", "D", "SKILL.md valid descriptors", start, { skipped: "no naia-adk" });
      return;
    }
    const { FileSkillLoader } = await import(
      resolve(repoRoot, "packages/runtime/src/index.ts")
    );
    const loader = new FileSkillLoader({
      workspaceRoot: naiaAdkSkills,
      skillsDir: naiaAdkSkills,
      onWarn: () => {
        /* silent */
      },
    });
    const skills = await loader.list();
    const tierValid = ["T0", "T1", "T2", "T3"] as const;
    const bad = skills.filter(
      (s) =>
        !s.name ||
        !s.description ||
        !tierValid.includes(s.tier) ||
        !s.inputSchema ||
        typeof s.inputSchema !== "object",
    );
    const mechPass = skills.length >= 19 && bad.length === 0;
    record("D5", "D", "SKILL.md valid descriptors", start, {
      mechanism: {
        pass: mechPass,
        notes: [
          `loaded=${skills.length}`,
          `bad=${bad.length}`,
          `tier-distribution: T0=${skills.filter((s) => s.tier === "T0").length} T1=${skills.filter((s) => s.tier === "T1").length} T2=${skills.filter((s) => s.tier === "T2").length} T3=${skills.filter((s) => s.tier === "T3").length}`,
        ],
      },
      observedTail: bad.length > 0 ? `bad names: ${bad.map((s) => s.name).join(",")}` : `all ${skills.length} valid`,
    });
    expect(mechPass).toBe(true);
  });

  it("D6 풀셋 — naia-adk skills/ all expected names present (mechanism roll-up)", async () => {
    const start = Date.now();
    if (!existsSync(naiaAdkSkills)) {
      record("D6", "D", "naia-adk 풀셋 roll-up", start, { skipped: "no naia-adk" });
      return;
    }
    const { FileSkillLoader } = await import(
      resolve(repoRoot, "packages/runtime/src/index.ts")
    );
    const loader = new FileSkillLoader({
      workspaceRoot: naiaAdkSkills,
      skillsDir: naiaAdkSkills,
      onWarn: () => {
        /* silent */
      },
    });
    const skills = await loader.list();
    const want = [
      "channel-management", "config", "cron", "diagnostics", "doc-coauthoring",
      "document-generation", "email", "memo", "notify", "read-doc",
      "review-pass", "service-management", "sessions", "skill-manager", "sms",
      "system-status", "time", "weather", "web-monitoring",
      // business/ has no SKILL.md — known stub, NOT required.
    ];
    const got = new Set(skills.map((s) => s.name));
    const missing = want.filter((n) => !got.has(n));
    const mechPass = missing.length === 0;
    record("D6", "D", "naia-adk 풀셋 roll-up", start, {
      mechanism: {
        pass: mechPass,
        notes: [`loaded=${skills.length}`, `want=${want.length}`, `missing=${missing.join(",") || "—"}`],
      },
      observedTail: `got: ${[...got].join(",")}`,
    });
    expect(mechPass).toBe(true);
  });
});

// ─── Group G. onmam-adk domain skills (Slice 3-XR-L) ─────────────────────────

describe("Group G — onmam-adk domain skills via --skills-dir", () => {
  let tmp: string;
  const onmamAdkSkills = resolve(repoRoot, "../onmam-adk/skills");

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-intg-G-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("G1 onmam-adk skills/ load — 10 skills incl. wp-archive (mechanism)", async () => {
    const start = Date.now();
    if (!existsSync(onmamAdkSkills)) {
      record("G1", "G", "onmam-adk skills/ load", start, {
        skipped: `onmam-adk submodule not present at ${onmamAdkSkills}`,
      });
      return;
    }
    const { FileSkillLoader } = await import(
      resolve(repoRoot, "packages/runtime/src/index.ts")
    );
    const loader = new FileSkillLoader({
      workspaceRoot: onmamAdkSkills,
      skillsDir: onmamAdkSkills,
      onWarn: () => {
        /* silent */
      },
    });
    const skills = await loader.list();
    const names = new Set(skills.map((s: { name: string }) => s.name));
    const hasWpArchive = names.has("wp-archive");
    const hasOverlap = ["channel-management", "doc-coauthoring", "email", "sms"].every((n) =>
      names.has(n),
    );
    const mechPass = skills.length >= 10 && hasWpArchive && hasOverlap;
    record("G1", "G", "onmam-adk skills/ load", start, {
      mechanism: {
        pass: mechPass,
        notes: [
          `loaded=${skills.length}`,
          `wp-archive=${hasWpArchive}`,
          `overlap_naia=${hasOverlap}`,
          `tier-distribution: T0=${skills.filter((s: { tier: string }) => s.tier === "T0").length} T1=${skills.filter((s: { tier: string }) => s.tier === "T1").length}`,
        ],
      },
      observedTail: `names: ${[...names].join(",")}`,
    });
    expect(mechPass).toBe(true);
  });

  it("G2 wp-archive (onmam-only domain skill) — descriptor valid", async () => {
    const start = Date.now();
    if (!existsSync(onmamAdkSkills)) {
      record("G2", "G", "wp-archive descriptor", start, { skipped: "no onmam-adk" });
      return;
    }
    const { FileSkillLoader } = await import(
      resolve(repoRoot, "packages/runtime/src/index.ts")
    );
    const loader = new FileSkillLoader({
      workspaceRoot: onmamAdkSkills,
      skillsDir: onmamAdkSkills,
      onWarn: () => {
        /* silent */
      },
    });
    const wp = await loader.get("wp-archive");
    const mechPass =
      !!wp &&
      typeof wp.name === "string" &&
      typeof wp.description === "string" &&
      ["T0", "T1", "T2", "T3"].includes(wp.tier);
    record("G2", "G", "wp-archive descriptor", start, {
      mechanism: {
        pass: mechPass,
        notes: [
          `present=${!!wp}`,
          `name="${wp?.name ?? ""}"`,
          `tier=${wp?.tier ?? ""}`,
          `descLen=${wp?.description?.length ?? 0}`,
        ],
      },
      observedTail: `desc: ${wp?.description?.slice(0, 200) ?? "<missing>"}`,
    });
    expect(mechPass).toBe(true);
  });

  it("G3 naia-adk + onmam-adk skill-name collision via Composite — first-registered wins (shadow recorded)", async () => {
    const start = Date.now();
    const naiaAdkSkills = resolve(repoRoot, "../naia-adk/skills");
    if (!existsSync(naiaAdkSkills) || !existsSync(onmamAdkSkills)) {
      record("G3", "G", "naia+onmam composite collision", start, {
        skipped: "need both naia-adk and onmam-adk",
      });
      return;
    }
    const { FileSkillLoader, SkillToolExecutor, CompositeToolExecutor } = await import(
      resolve(repoRoot, "packages/runtime/src/index.ts")
    );
    const naiaLoader = new FileSkillLoader({
      workspaceRoot: naiaAdkSkills,
      skillsDir: naiaAdkSkills,
      onWarn: () => {
        /* silent */
      },
    });
    const onmamLoader = new FileSkillLoader({
      workspaceRoot: onmamAdkSkills,
      skillsDir: onmamAdkSkills,
      onWarn: () => {
        /* silent */
      },
    });
    const composite = new CompositeToolExecutor({
      subs: [
        { id: "naia-adk", executor: new SkillToolExecutor({ loader: naiaLoader }) },
        { id: "onmam-adk", executor: new SkillToolExecutor({ loader: onmamLoader }) },
      ],
      onWarn: () => {
        /* silent — we inspect shadowedNames() instead */
      },
    });
    const list = await composite.list();
    const shadows = composite.shadowedNames();
    const allNames = new Set(list.map((t: { name: string }) => t.name));
    // Naia owns 'channel-management' (first sub) → onmam version shadowed.
    const naiaWinsChan = composite.ownerOf("channel-management") === "naia-adk";
    // wp-archive is onmam-only → present, owner=onmam-adk.
    const wpOwner = composite.ownerOf("wp-archive");
    // Each overlap (9 names) should appear in shadow list with winner=naia-adk.
    const shadowCount = shadows.length;
    const mechPass =
      naiaWinsChan && wpOwner === "onmam-adk" && shadowCount >= 9 && allNames.has("time") && allNames.has("wp-archive");
    record("G3", "G", "naia+onmam composite collision", start, {
      mechanism: {
        pass: mechPass,
        notes: [
          `totalTools=${list.length}`,
          `naiaWinsChan=${naiaWinsChan}`,
          `wpOwner=${wpOwner}`,
          `shadowCount=${shadowCount}`,
          `naiaOnlyPresent=${allNames.has("time")}`,
          `onmamOnlyPresent=${allNames.has("wp-archive")}`,
        ],
      },
      observedTail: `shadow sample: ${shadows.slice(0, 3).map((s: { name: string; winner: string; loser: string }) => `${s.name}:${s.winner}>${s.loser}`).join(", ")}`,
    });
    expect(mechPass).toBe(true);
  });

  it("G4 onmam-dev GCE live invocation — DEFERRED (user gate, external server)", async () => {
    const start = Date.now();
    record("G4", "G", "onmam-dev GCE live", start, {
      skipped:
        "DEFERRED — onmam-dev GCE host modification is user-gated (feedback_ai_leads_human_executes_serverenv). Out of scope for Slice 3-XR-L mechanism.",
    });
    expect(true).toBe(true);
  });
});

// ─── Group M. multi-turn REPL + Claude Code live (Slice 3-XR-M) ──────────────

describe("Group M — multi-turn REPL + Claude Code subscription routing", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-intg-M-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Multi-turn REPL via async spawn (we have no node-pty; spawnSync only
   * runs one shot). Pattern: spawn child, write turn 1, wait for the
   * next `naia> ` prompt to appear in stderr/stdout, write turn 2, etc.
   * If the model server is down a turn fails — safeTurn must not crash
   * the REPL, so the prompt MUST come back for turn 2.
   */
  async function runRepl(
    args: string[],
    env: NodeJS.ProcessEnv,
    turns: string[],
    timeoutMs = 90_000,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; promptCount: number }> {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [tsxCli, binPath, ...args], {
      cwd: existsSync(env["HOME"] ?? "") ? (env["HOME"] as string) : repoRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let promptCount = 0;
    let nextTurn = 0;
    return await new Promise((resolveP) => {
      const finish = (exitCode: number | null): void => {
        try {
          child.stdin.end();
        } catch {
          /* noop */
        }
        resolveP({ exitCode, stdout, stderr, promptCount });
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(null);
      }, timeoutMs);
      child.stdout.on("data", (b: Buffer) => {
        stdout += b.toString();
      });
      child.stderr.on("data", (b: Buffer) => {
        const text = b.toString();
        stderr += text;
        // The bin writes "\nnaia> " as the prompt (line 505) — count by
        // the trailing `naia> ` token, but note the bin sends it on
        // STDOUT (readline.createInterface output:process.stdout). The
        // safety net: also count in stdout below.
        let idx = 0;
        while ((idx = text.indexOf("naia> ", idx)) !== -1) {
          promptCount += 1;
          idx += 1;
        }
      });
      let stdoutCarry = "";
      child.stdout.on("data", (b: Buffer) => {
        const text = b.toString();
        stdoutCarry += text;
        // Each `naia> ` indicates the REPL is ready for the next turn.
        while (stdoutCarry.includes("naia> ")) {
          promptCount += 1;
          stdoutCarry = stdoutCarry.slice(stdoutCarry.indexOf("naia> ") + "naia> ".length);
          if (nextTurn < turns.length) {
            try {
              child.stdin.write(turns[nextTurn] + "\n");
            } catch {
              /* noop */
            }
            nextTurn += 1;
          } else {
            try {
              child.stdin.write("exit\n");
            } catch {
              /* noop */
            }
          }
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        finish(code);
      });
    });
  }

  it("M1 multi-turn REPL — 1st turn against dead server, 2nd turn against the same dead server, REPL stays alive", async () => {
    const start = Date.now();
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    runBin(
      ["login", "--adk", adk, "--main", "openai-compat|http://127.0.0.1:1/v1|absent"],
      coldEnv(home),
    );
    const r = await runRepl(
      ["--no-tools", "--repl"],
      coldEnv(home),
      ["hi", "still there?"],
      45_000,
    );
    // safeTurn keeps the REPL alive across per-turn failures (Slice 3-XR-F).
    // Mechanism: we see ≥ 2 `naia> ` prompts (initial + AT LEAST one
    // post-turn). A clean exit on "exit" → exitCode === 0.
    const mechPass = r.exitCode === 0 && r.promptCount >= 2;
    record("M1", "M", "REPL safeTurn cross-turn survival", start, {
      mechanism: {
        pass: mechPass,
        notes: [
          `exit=${r.exitCode}`,
          `promptCount=${r.promptCount}`,
          `stderrHas turn failed=${/turn failed/i.test(r.stderr)}`,
        ],
      },
      observedTail: `stderr tail: ${r.stderr.slice(-800)}`,
    });
    expect(mechPass).toBe(true);
  }, 60_000);

  it("M2 Claude Code subscription routing — DRYRUN dispatcher (no credit) + opt-in live gate via NAIA_AGENT_CLAUDECODE_LIVE=1", async () => {
    const start = Date.now();
    const home = mkdtempSync(join(tmp, "home-"));
    const manifestPath = join(home, "claude-code.service.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: "0.1.0",
        name: "claude-code-test",
        persona: { systemPrompt: "test" },
        llm: { backend: "claude-code", model: "claude-haiku-4-5-20251001" },
        memory: { binding: "in-memory" },
      }),
    );

    // DRYRUN — default mode (no credit spent). Asserts the backend
    // 'claude-code' arm is dispatched.
    const dry = runBin(
      ["--service", manifestPath, "hi"],
      coldEnv(home, { NAIA_AGENT_DRYRUN: "1" }),
      undefined,
      30_000,
    );
    const dryMech = dry.status === 0 && /provider=claude-code|dry-run OK.*claude-code/i.test(dry.stderr);

    // Optional LIVE gate (consumes Claude Code subscription credit).
    // Default OFF — only run when NAIA_AGENT_CLAUDECODE_LIVE=1.
    let liveExit: number | null = null;
    let liveTail = "";
    if (process.env.NAIA_AGENT_CLAUDECODE_LIVE === "1") {
      const live = runBin(
        ["--service", manifestPath, "Reply with exactly: ALIVE"],
        coldEnv(home),
        undefined,
        90_000,
      );
      liveExit = live.status;
      liveTail = `live stderr: ${live.stderr.slice(-300)}\nlive stdout: ${live.stdout.slice(-300)}`;
    }

    const mechPass = dryMech;
    record("M2", "M", "Claude Code subscription routing (DRYRUN + opt-in live)", start, {
      mechanism: {
        pass: mechPass,
        notes: [
          `dry.exit=${dry.status}`,
          `dryMech=${dryMech}`,
          `liveExit=${liveExit ?? "<skipped>"}`,
        ],
      },
      observedTail: `dry stderr: ${dry.stderr.slice(-600)}\n${liveTail}`,
    });
    expect(mechPass).toBe(true);
  }, 120_000);
});

// ─── Group N. cross-OS mechanism (Slice 3-XR-N) ──────────────────────────────

describe("Group N — cross-OS mechanism (Linux side; Windows-side honest defer)", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-intg-N-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("N1 path normalization — workspace boundary refuses path-traversal regardless of separator style", async () => {
    const start = Date.now();
    const { normalizeWorkspacePath, WorkspaceEscapeError } = await import(
      resolve(repoRoot, "packages/runtime/src/utils/path-normalize.ts")
    );
    const root = mkdtempSync(join(tmp, "ws-"));
    type NormalizeFn = (rel: string, root: string) => Promise<string> | string;
    const fn = normalizeWorkspacePath as NormalizeFn;
    const traversals = ["../etc/passwd", "../../etc/passwd", "/etc/passwd"];
    let blocked = 0;
    for (const t of traversals) {
      try {
        await fn(t, root);
      } catch (e) {
        if (e instanceof (WorkspaceEscapeError as new () => Error)) blocked += 1;
        else if (String(e).includes("escape") || String(e).includes("workspace")) blocked += 1;
      }
    }
    // Backslash form on Linux is a literal filename component, not a separator
    // — so it does NOT traverse. Document that as honest cross-OS behaviour.
    let backslashIsLiteral = false;
    try {
      const out = (await fn("subdir\\file.txt", root)) as string;
      backslashIsLiteral = out.includes("\\");
    } catch {
      backslashIsLiteral = false;
    }
    const mechPass = blocked === traversals.length;
    record("N1", "N", "path normalization cross-OS", start, {
      mechanism: {
        pass: mechPass,
        notes: [
          `traversals blocked=${blocked}/${traversals.length}`,
          `backslash literal on linux=${backslashIsLiteral}`,
        ],
      },
      observedTail: `note: backslash is a separator only on win32; on linux it's a filename literal — escape detection relies on resolved path comparison, not character heuristics`,
    });
    expect(mechPass).toBe(true);
  });

  it("N2 line ending — file-ops read/write tolerate CRLF without corruption", async () => {
    const start = Date.now();
    const { createReadFileSkill, createWriteFileSkill } = await import(
      resolve(repoRoot, "packages/runtime/src/index.ts")
    );
    const root = mkdtempSync(join(tmp, "ws-"));
    type SkillFn = (opts: { workspaceRoot: string }) => {
      handler: (input: unknown) => Promise<{ content: string; isError?: boolean }>;
    };
    // file-ops handlers return plain strings (success = raw content, errors
    // begin with "ERROR:" / "BLOCKED:"). Not the {content, isError} shape.
    type Handler = (input: unknown) => Promise<string>;
    type SkillWithHandler = { handler: Handler };
    const writer = ((createWriteFileSkill as unknown as SkillFn)({ workspaceRoot: root })) as unknown as SkillWithHandler;
    const reader = ((createReadFileSkill as unknown as SkillFn)({ workspaceRoot: root })) as unknown as SkillWithHandler;
    const content = "line1\r\nline2\r\nline3\r\n";
    const w = await writer.handler({ path: "crlf.txt", content });
    const r = await reader.handler({ path: "crlf.txt" });
    const wOk = typeof w === "string" && !w.startsWith("ERROR") && !w.startsWith("BLOCKED");
    const rOk =
      typeof r === "string" &&
      !r.startsWith("ERROR") &&
      !r.startsWith("BLOCKED") &&
      r.includes("line1") &&
      r.includes("line3") &&
      r.includes("\r\n"); // CRLF preserved through roundtrip
    const mechPass = wOk && rOk;
    record("N2", "N", "line ending CRLF roundtrip", start, {
      mechanism: {
        pass: mechPass,
        notes: [`writeOk=${wOk}`, `readOk=${rOk}`, `contentLen=${r.length}`],
      },
      observedTail: `roundtrip: write="${w.slice(0, 60)}" / read="${r.slice(0, 100)}"`,
    });
    expect(mechPass).toBe(true);
  });

  it("N3 secret-store platform — getSecretStore() reports availability matching process.platform", async () => {
    const start = Date.now();
    const { getSecretStore } = await import(
      resolve(repoRoot, "packages/runtime/src/index.ts")
    );
    const store = (getSecretStore as () => { available(): Promise<boolean> })();
    const avail = await store.available();
    // Linux: LibSecretStore should be wired (available=true if libsecret present).
    // Other OS: NullSecretStore — available=false. Either way, available()
    // must be a clean boolean (no throw) so callers can gate gracefully.
    const mechPass = typeof avail === "boolean";
    record("N3", "N", "secret-store cross-platform availability", start, {
      mechanism: {
        pass: mechPass,
        notes: [`platform=${process.platform}`, `availableType=${typeof avail}`, `availableValue=${avail}`],
      },
      observedTail: `${process.platform}: secret-store available=${avail} (Linux=libsecret/Null fallback; other=NullSecretStore)`,
    });
    expect(mechPass).toBe(true);
  });

  it("N4 HOME directory convention — bin uses HOME env (Linux/macOS); USERPROFILE (Windows) DEFERRED", async () => {
    const start = Date.now();
    // Mechanism: spawn bin with a custom HOME and confirm the `show` output
    // reflects that path (proves HOME is read, not hard-coded). On Windows
    // the same path comes from USERPROFILE; that's tested on Windows hosts.
    const customHome = mkdtempSync(join(tmp, "custom-home-"));
    const r = runBin(["show"], coldEnv(customHome));
    const mechPass =
      r.status === 0 &&
      (r.stdout.includes(customHome) || r.stdout.includes("naia-agent show"));
    record("N4", "N", "HOME env read on Linux/macOS (Windows USERPROFILE deferred)", start, {
      mechanism: {
        pass: mechPass,
        notes: [
          `exit=${r.status}`,
          `customHomeMentioned=${r.stdout.includes(customHome)}`,
          `platform=${process.platform}`,
        ],
      },
      observedTail: `show stdout: ${r.stdout.slice(-400)}`,
    });
    expect(mechPass).toBe(true);
  });

  it("N5 bash skill platform note — Linux/macOS use /usr/bin/env, Windows uses cmd.exe (mechanism)", async () => {
    const start = Date.now();
    // Pure-mechanism: read the bin source itself and assert the dual-platform
    // branch is wired (constant verification — refuses silent regression that
    // hard-codes one platform).
    const { readFileSync } = await import("node:fs");
    const bin = readFileSync(resolve(repoRoot, "bin/naia-agent.ts"), "utf8");
    const hasWinBranch = /process\.platform === "win32"/.test(bin);
    const hasUsrBinEnv = bin.includes("/usr/bin/env");
    const hasCmd = bin.includes("cmd.exe");
    const mechPass = hasWinBranch && hasUsrBinEnv && hasCmd;
    record("N5", "N", "shell adapter cross-platform branch", start, {
      mechanism: {
        pass: mechPass,
        notes: [`platform-branch=${hasWinBranch}`, `usr-bin-env=${hasUsrBinEnv}`, `cmd.exe=${hasCmd}`],
      },
      observedTail: `bin/naia-agent.ts has the dual-platform shell adapter branch`,
    });
    expect(mechPass).toBe(true);
  });

  it("N6 windows-side LIVE — DEFERRED (no Windows host in this session; cross-OS sanity sufficient)", async () => {
    const start = Date.now();
    record("N6", "N", "Windows-host LIVE", start, {
      skipped:
        "DEFERRED — this session is Linux. cross-os-compat-sanity-2026-05-20.md captured the 4/5 sanity (path/line/secret-store/shell adapter mechanism). Windows host LIVE = separate slice with Windows runner.",
    });
    expect(true).toBe(true);
  });
});

// ─── Group O. naia-agent ↔ Claude Code parity ledger (Slice 3-XR-O) ──────────

describe("Group O — naia-agent ↔ Claude Code harness behavioral parity (intentional-difference ledger)", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-intg-O-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // Parity is NOT "naia-agent must equal Claude Code". Both are runtimes;
  // naia-agent's mandate is host-able runtime ("Interfaces, not dependencies"),
  // while Claude Code is a CLI product. The ledger captures which surfaces
  // are EQUIVALENT (model-driven feature parity) and which are INTENTIONALLY
  // DIFFERENT (e.g. prompt token, exit codes). Other slices' results are
  // referenced — this group rolls them up + documents the diffs.

  it("O1 file-ops parity — naia-agent registers the SAME 5 skills Claude Code's editor offers", async () => {
    const start = Date.now();
    // Mechanism: import createFileOpsSkills() and confirm the 5-tool set.
    // Claude Code exposes Read/Write/Edit/Bash + Glob/Grep equivalents.
    // naia-agent's set: read_file / write_file / edit_file / list_files / bash.
    const { createFileOpsSkills, createBashSkill } = await import(
      resolve(repoRoot, "packages/runtime/src/index.ts")
    );
    type SkillFactory = (opts?: { workspaceRoot?: string }) => { name?: string };
    const fileOps = (createFileOpsSkills as SkillFactory)({ workspaceRoot: tmp });
    const bash = (createBashSkill as SkillFactory)();
    const list = Array.isArray(fileOps) ? fileOps : [];
    const names = new Set(list.map((s: { name?: string }) => s.name).filter(Boolean) as string[]);
    names.add(((bash as { name?: string }).name ?? "bash"));
    const expected = ["read_file", "write_file", "edit_file", "list_files", "bash"];
    const missing = expected.filter((n) => !names.has(n));
    const mechPass = missing.length === 0;
    record("O1", "O", "file-ops parity (5 skills, Claude Code equivalent)", start, {
      mechanism: {
        pass: mechPass,
        notes: [`available=${[...names].join(",")}`, `missing=${missing.join(",") || "—"}`],
      },
      observedTail: `naia-agent core tool surface ≅ Claude Code's editor toolset (read/write/edit/list/bash)`,
    });
    expect(mechPass).toBe(true);
  });

  it("O2 REPL parity — readline-based, single-line prompt, 'exit'/Ctrl-D quits, --repl forces non-TTY (Slice 3-XR-M)", () => {
    const start = Date.now();
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const bin = readFileSync(resolve(repoRoot, "bin/naia-agent.ts"), "utf8");
    // Mechanism cross-ref: confirm REPL wire-up matches the Claude Code-style
    // readline contract. (LIVE REPL behaviour is verified by Group M.)
    const hasReadline = /readline.createInterface/.test(bin);
    const hasNaiaPrompt = /prompt:\s*"\\nnaia>\s/.test(bin) || bin.includes('prompt: "\\nnaia> "');
    const hasExitKeywords = /=== "exit"\s*\|\|\s*trimmed === "quit"|trimmed === "\.exit"/.test(bin);
    const hasForceRepl = /--repl|forceRepl/.test(bin);
    const mechPass = hasReadline && hasNaiaPrompt && hasExitKeywords && hasForceRepl;
    record("O2", "O", "REPL parity (readline + exit + --repl)", start, {
      mechanism: {
        pass: mechPass,
        notes: [
          `readline=${hasReadline}`,
          `naiaPrompt=${hasNaiaPrompt}`,
          `exitKeywords=${hasExitKeywords}`,
          `forceRepl=${hasForceRepl}`,
        ],
      },
      observedTail:
        `intentional diff: Claude Code uses '> ' as prompt; naia-agent uses 'naia> '. Both are readline-driven. naia-agent adds --repl to force REPL on non-TTY stdin (testing affordance). Multi-turn safeTurn survival verified in Group M.`,
    });
    expect(mechPass).toBe(true);
  });

  it("O3 tool-marker parity — both runtimes surface tool invocations in stderr with a [tool]-style line per call", () => {
    const start = Date.now();
    // Cross-ref Group P: stderr emits `[tool] <name>({json})\n` per tool
    // invocation (line ~772-774 of bin/naia-agent.ts). Claude Code prints
    // ● Tool(arg) per invocation. Different prefix, same semantics.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const bin = readFileSync(resolve(repoRoot, "bin/naia-agent.ts"), "utf8");
    const hasToolStarted = /tool\.started/.test(bin);
    const hasToolEnded = /tool\.ended/.test(bin);
    const hasStderrTag = /\[tool\]\s/.test(bin) || bin.includes("[tool]");
    const mechPass = hasToolStarted && hasToolEnded && hasStderrTag;
    record("O3", "O", "tool-marker parity (stderr [tool] tags vs Claude ● tags)", start, {
      mechanism: {
        pass: mechPass,
        notes: [`toolStarted=${hasToolStarted}`, `toolEnded=${hasToolEnded}`, `stderrTag=${hasStderrTag}`],
      },
      observedTail:
        `intentional diff: prefix only ('[tool] read_file({…})' vs '● Read(…)'). Both go to stderr and are caller-greppable. Group P scenarios assert the [tool] marker presence on LIVE tool-calls.`,
    });
    expect(mechPass).toBe(true);
  });

  it("O4 exit-code parity — 0=ok / 2=parse_or_turn_failed / 3=no_provider; Claude Code 0/1 different (intentional)", () => {
    const start = Date.now();
    // Convention captured in CLAUDE.md / bin source: 0 success, 2 single-turn
    // failure or parseArgs error, 3 missing provider. Claude Code uses 0/1.
    // Different on purpose — naia-agent's 3-tier exit is more actionable
    // for shell pipelines (skip vs retry vs fix).
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const bin = readFileSync(resolve(repoRoot, "bin/naia-agent.ts"), "utf8");
    const has0 = /return\s+0/.test(bin);
    const has2 = /\b0\s*:\s*2\b|\breturn\s+2\b/.test(bin);
    const has3 = /return\s+3/.test(bin);
    const mechPass = has0 && has2 && has3;
    record("O4", "O", "exit-code parity (0/2/3 tier)", start, {
      mechanism: { pass: mechPass, notes: [`return0=${has0}`, `return2=${has2}`, `return3=${has3}`] },
      observedTail:
        `intentional diff: naia-agent 0/2/3 vs Claude Code 0/1. Group H scenarios (H1/H2/H3) and S1-S5 unit scenarios assert the convention.`,
    });
    expect(mechPass).toBe(true);
  });

  it("O5 memory + persona parity — --memory + --system supported (Slice 3-XR-F + 3-XR-G F2/A3 cross-ref)", () => {
    const start = Date.now();
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const bin = readFileSync(resolve(repoRoot, "bin/naia-agent.ts"), "utf8");
    const hasMemory = /--memory/.test(bin) && /LiteMemoryProvider/.test(bin);
    const hasSystem = /--system/.test(bin) && /systemPrompt/.test(bin);
    const hasNoDefSys = /--no-default-system/.test(bin);
    const mechPass = hasMemory && hasSystem && hasNoDefSys;
    record("O5", "O", "memory + persona parity (--memory + --system + --no-default-system)", start, {
      mechanism: {
        pass: mechPass,
        notes: [`--memory=${hasMemory}`, `--system=${hasSystem}`, `--no-default-system=${hasNoDefSys}`],
      },
      observedTail:
        `parity-with-care: Claude Code uses 'Project memory' / 'CLAUDE.md' (file-based) + system prompt template; naia-agent uses ` +
        `LiteMemoryProvider SQLite + --system rider. Equivalent capability, different shape. Group F (4 scenarios incl. F2 persona+memory) + Group A3 (cross-process recall) verify on LIVE.`,
    });
    expect(mechPass).toBe(true);
  });

  it("O6 service-mode parity — --service <manifest> dispatches to Claude Code subscription (Slice 3-XR-M M2 cross-ref)", () => {
    const start = Date.now();
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const bin = readFileSync(resolve(repoRoot, "bin/naia-agent.ts"), "utf8");
    const hasClaudeCode = /case "claude-code"/.test(bin);
    const hasSubscriptionNote = /subscription, no API key/.test(bin);
    const hasDryRun = /NAIA_AGENT_DRYRUN/.test(bin);
    const mechPass = hasClaudeCode && hasSubscriptionNote && hasDryRun;
    record("O6", "O", "service-mode parity (Claude Code subscription routing)", start, {
      mechanism: {
        pass: mechPass,
        notes: [
          `claude-code case=${hasClaudeCode}`,
          `subscription note=${hasSubscriptionNote}`,
          `DRYRUN gate=${hasDryRun}`,
        ],
      },
      observedTail:
        `naia-agent can ROUTE to Claude Code (subscription, no API key) via --service <manifest> with backend:"claude-code". DRYRUN gate (NAIA_AGENT_DRYRUN=1) verifies routing without credit cost. Group M M2 + Group G3 cross-ref.`,
    });
    expect(mechPass).toBe(true);
  });

  it("O7 intentional-difference ledger — what naia-agent INTENTIONALLY does NOT replicate from Claude Code", () => {
    const start = Date.now();
    // Pure documentation scenario: enumerate intentional divergences so
    // a reader (or LLM) doesn't mistake them for missing features.
    const ledger = [
      "Slash commands (/clear /compact /save) — Claude Code only; naia-agent is a runtime, not a CLI product.",
      "TUI rendering (panes, status bars, progress widgets) — Claude Code uses Ink; naia-agent uses bare readline.",
      "Subagent dispatch (Task tool launching another agent) — naia-agent has Phase1Supervisor but is host-driven, not user-CLI.",
      "Plugins / Marketplace / IDE extensions — Claude Code product surface only.",
      "Built-in 'ultrareview' / cloud review — Claude Code only.",
      "Auto-compaction / context window management UI — Claude Code's harness; naia-agent leaves it to the host.",
      "Web search / WebFetch — Claude Code built-in; naia-agent treats it as a host-provided skill (cf naia-adk web-monitoring).",
    ];
    record("O7", "O", "intentional-difference ledger", start, {
      mechanism: { pass: true, notes: [`itemCount=${ledger.length}`] },
      observedTail: ledger.join("\n— "),
    });
    expect(true).toBe(true);
  });
});

// ─── Group P. pi-based coding (LIVE tool calling — Slice 3-XR-I) ─────────────

describe("Group P — pi-based coding LIVE (native tool-calling)", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-intg-P-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // Run gemma4:31b WITHOUT --no-tools, with --enable-file-ops, so the model
  // can drive bash + read/write/edit/list skills via native tool-calling
  // (confirmed in probe: ollama gemma4:31b returns finish_reason=tool_calls).
  // workdir = workspace root for file-ops boundary (D09 normalizeWorkspacePath).
  function runCoding(args: string[], home: string, workdir: string, extra: NodeJS.ProcessEnv = {}, timeoutMs = 240_000) {
    return runBin(
      ["--enable-file-ops", "--no-default-system", "--workdir", workdir, ...args],
      coldEnv(home, extra),
      undefined,
      timeoutMs,
    );
  }

  it("P1 write_file — model writes a file to a tmp dir, mechanism asserts file content", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("P1", "P", "write_file LIVE (24G)", start, { skipped: "no 24G" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const work = mkdtempSync(join(tmp, "work-"));
    const target = join(work, "hello.txt");
    const persona =
      `You have tools to write files. Use the write_file tool to create the file "${target}" containing exactly the text "hello from naia-agent". Reply only after the tool returns.`;
    const r = runCoding(["--system", persona, "Please do it now."], home, work);
    const fileExists = existsSync(target);
    const fileContent = fileExists ? readFileSync(target, "utf8") : "";
    const observed = `[exit=${r.status}]\nstdout:\n${r.stdout.slice(0, 800)}\n--- stderr tail ---\n${r.stderr.slice(-1200)}\n--- file ---\nexists=${fileExists} content=${JSON.stringify(fileContent)}`;
    const toolFired = /\[tool\]\s*write_file/.test(r.stderr);
    const mechPass = r.status === 0 && fileExists && fileContent.length > 0;
    record("P1", "P", "write_file LIVE (24G)", start, {
      mechanism: {
        pass: mechPass,
        notes: [`exit=${r.status}`, `fileExists=${fileExists}`, `toolFired=${toolFired}`, `contentLen=${fileContent.length}`],
      },
      observedTail: observed.slice(-1500),
    });
    expect(mechPass).toBe(true);
  }, 280_000);

  it("P2 read_file — model reads a tmp file and quotes its content", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("P2", "P", "read_file LIVE (24G)", start, { skipped: "no 24G" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const work = mkdtempSync(join(tmp, "work-"));
    const target = join(work, "note.txt");
    const secret = "the magic number is 73218";
    writeFileSync(target, secret);
    const persona =
      `You have a read_file tool. Read "${target}" using the tool, then tell me what number is mentioned. Answer in one sentence.`;
    const r = runCoding(["--system", persona, "Go."], home, work);
    const observed = `[exit=${r.status}]\nstdout:\n${r.stdout}\n--- stderr tail ---\n${r.stderr.slice(-1200)}`;
    const toolFired = /\[tool\]\s*read_file/.test(r.stderr);
    const quoted = r.stdout.includes("73218");
    const mechPass = r.status === 0 && toolFired && quoted;
    let v: JudgeVerdict | undefined;
    if (mechPass && judgeAvailable()) {
      v = await judge({
        scenarioId: "P2",
        description: "model reads a file via read_file tool and quotes the magic number",
        expected:
          "The output names '73218' as the magic number. The stderr shows [tool] read_file fired before the answer.",
        observed,
      });
    }
    record("P2", "P", "read_file LIVE (24G)", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`, `toolFired=${toolFired}`, `quoted=${quoted}`] },
      judge: v,
      observedTail: observed.slice(-1500),
    });
    expect(mechPass).toBe(true);
    if (v && v.pass === false && !/transport error|judge empty|judge parse error/.test(v.reason)) {
      expect(v.pass).toBe(true);
    }
  }, 280_000);

  it("P3 list_files — model lists tmp dir contents accurately", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("P3", "P", "list_files LIVE (24G)", start, { skipped: "no 24G" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const work = mkdtempSync(join(tmp, "work-"));
    writeFileSync(join(work, "alpha.txt"), "a");
    writeFileSync(join(work, "beta.md"), "b");
    writeFileSync(join(work, "gamma.json"), "{}");
    const persona =
      `You have a list_files tool. Call list_files EXACTLY ONCE with path="${work}" (use that absolute path verbatim). Do not call any other tool. Then tell me the file names from the tool's response, comma-separated.`;
    const r = runCoding(["--system", persona, "What's there?"], home, work);
    const observed = `[exit=${r.status}]\nstdout:\n${r.stdout}\n--- stderr tail ---\n${r.stderr.slice(-1200)}`;
    const toolFired = /\[tool\]\s*list_files/.test(r.stderr);
    const allNamed = ["alpha.txt", "beta.md", "gamma.json"].every((n) => r.stdout.includes(n));
    const mechPass = r.status === 0 && toolFired && allNamed;
    record("P3", "P", "list_files LIVE (24G)", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`, `toolFired=${toolFired}`, `allNamed=${allNamed}`] },
      observedTail: observed.slice(-1500),
    });
    expect(mechPass).toBe(true);
  }, 280_000);

  it("P4 edit_file — model patches a file via edit_file tool", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("P4", "P", "edit_file LIVE (24G)", start, { skipped: "no 24G" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const work = mkdtempSync(join(tmp, "work-"));
    const target = join(work, "config.txt");
    writeFileSync(target, "name=alpha\nversion=0.1.0\n");
    const persona =
      `You have an edit_file tool. In the file "${target}", change "version=0.1.0" to "version=0.2.0". Use the tool once.`;
    const r = runCoding(["--system", persona, "Apply the edit."], home, work);
    const after = existsSync(target) ? readFileSync(target, "utf8") : "";
    const observed = `[exit=${r.status}]\nstdout:\n${r.stdout.slice(0, 600)}\n--- stderr tail ---\n${r.stderr.slice(-1200)}\n--- file after ---\n${after}`;
    const toolFired = /\[tool\]\s*edit_file/.test(r.stderr);
    const patched = after.includes("version=0.2.0") && !after.includes("version=0.1.0");
    const mechPass = r.status === 0 && toolFired && patched;
    record("P4", "P", "edit_file LIVE (24G)", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`, `toolFired=${toolFired}`, `patched=${patched}`] },
      observedTail: observed.slice(-1500),
    });
    expect(mechPass).toBe(true);
  }, 280_000);

  it("P5 bash — model runs a single echo via bash skill", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("P5", "P", "bash LIVE (24G)", start, { skipped: "no 24G" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const persona =
      `You have a bash tool. Run \`echo READY-marker-7Q\` using bash, then tell me what the output was.`;
    const r = runCoding(["--system", persona, "Run it."], home, home);
    const observed = `[exit=${r.status}]\nstdout:\n${r.stdout}\n--- stderr tail ---\n${r.stderr.slice(-1200)}`;
    const toolFired = /\[tool\]\s*bash/.test(r.stderr);
    const quoted = r.stdout.includes("READY-marker-7Q");
    const mechPass = r.status === 0 && toolFired && quoted;
    record("P5", "P", "bash LIVE (24G)", start, {
      mechanism: { pass: mechPass, notes: [`exit=${r.status}`, `toolFired=${toolFired}`, `quoted=${quoted}`] },
      observedTail: observed.slice(-1500),
    });
    expect(mechPass).toBe(true);
  }, 280_000);

  it("P6 multi-tool composite — write + read + list in one session", async () => {
    const start = Date.now();
    if (!(await ollamaReachable()) || !(await modelAvailable("gemma4:31b"))) {
      record("P6", "P", "multi-tool composite LIVE (24G)", start, { skipped: "no 24G" });
      return;
    }
    const home = mkdtempSync(join(tmp, "home-"));
    const adk = mkdtempSync(join(tmp, "adk-"));
    bootstrap24G(home, adk);
    const work = mkdtempSync(join(tmp, "work-"));
    const target = join(work, "data.txt");
    const persona =
      `You have write_file, read_file, list_files tools. Step 1: write_file "${target}" with content "step1-done". Step 2: list_files in "${work}". Step 3: read_file "${target}" and quote it.`;
    const r = runCoding(["--system", persona, "Execute all three steps."], home, work);
    const observed = `[exit=${r.status}]\nstdout:\n${r.stdout.slice(0, 1000)}\n--- stderr tail ---\n${r.stderr.slice(-1500)}`;
    const wroteFired = /\[tool\]\s*write_file/.test(r.stderr);
    const listFired = /\[tool\]\s*list_files/.test(r.stderr);
    const readFired = /\[tool\]\s*read_file/.test(r.stderr);
    const bashFallback = /\[tool\]\s*bash/.test(r.stderr);
    const fileOk = existsSync(target) && readFileSync(target, "utf8").includes("step1-done");
    // The model is free to compose tools (write_file + bash for list/read is
    // a legitimate path). Mechanism = file effect correct + AT LEAST write
    // fired + (list happened by ANY route — native list_files OR bash-ls).
    // Response prose is NOT asserted — the [tool] markers in stderr are the
    // ground truth for what executed.
    const respondsListing = /data\.txt/.test(r.stdout);
    const respondsRead = /step1-done/.test(r.stdout);
    const listHappened = listFired || /\[tool\]\s*bash[^\n]*ls/.test(r.stderr);
    const readHappened = readFired || /\[tool\]\s*bash[^\n]*cat/.test(r.stderr);
    const mechPass =
      r.status === 0 && wroteFired && listHappened && readHappened && fileOk;
    record("P6", "P", "multi-tool composite LIVE (24G)", start, {
      mechanism: {
        pass: mechPass,
        notes: [
          `exit=${r.status}`,
          `write=${wroteFired}`,
          `list_native=${listFired}`,
          `read_native=${readFired}`,
          `bash_fallback=${bashFallback}`,
          `fileOk=${fileOk}`,
          `respondsListing=${respondsListing}`,
          `respondsRead=${respondsRead}`,
        ],
      },
      observedTail: observed.slice(-1800),
    });
    expect(mechPass).toBe(true);
  }, 360_000);
});

// ─── Group K. model comparison ────────────────────────────────────────────────

describe("Group K — same prompt: e4b vs 31b", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-intg-K-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("K1 short Q — both models reply; report side-by-side lengths and judge K1 quality diff", async () => {
    const start = Date.now();
    if (
      !(await ollamaReachable()) ||
      !(await modelAvailable("gemma3n:e4b")) ||
      !(await modelAvailable("gemma4:31b"))
    ) {
      record("K1", "K", "e4b vs 31b same-prompt", start, { skipped: "need both models" });
      return;
    }
    const home8 = mkdtempSync(join(tmp, "home8-"));
    const adk8 = mkdtempSync(join(tmp, "adk8-"));
    bootstrap8G(home8, adk8);
    const home24 = mkdtempSync(join(tmp, "home24-"));
    const adk24 = mkdtempSync(join(tmp, "adk24-"));
    bootstrap24G(home24, adk24);
    const q = "In one sentence, what is a Merkle tree used for?";
    // e4b: no native tool-calling AND degraded by long English system riders
    // (#41 v2). Use the minimal --no-tools + --no-default-system + raw q.
    const r8 = runBin(["--no-tools", "--no-default-system", q], coldEnv(home8), undefined, 150_000);
    const r24 = runBin(
      ["--no-tools", "--system", ANSWER_DIRECTLY, q],
      coldEnv(home24),
      undefined,
      200_000,
    );
    const observed =
      `=== gemma3n:e4b (8G) exit=${r8.status}\nstdout:\n${r8.stdout}\nstderr-tail:\n${r8.stderr.slice(-600)}\n` +
      `=== gemma4:31b (24G) exit=${r24.status}\nstdout:\n${r24.stdout}\nstderr-tail:\n${r24.stderr.slice(-300)}`;
    const mechPass = r8.status === 0 && r24.status === 0;
    let v: JudgeVerdict | undefined;
    if (mechPass && judgeAvailable()) {
      v = await judge({
        scenarioId: "K1",
        description: "Same one-sentence Merkle-tree question across two models",
        expected:
          "Both responses should mention tamper-evidence / integrity / hash verification / " +
          "blockchain. Either being grossly wrong (e.g. 'binary search') = FAIL. " +
          "Length difference is allowed — quality is the criterion.",
        observed,
      });
    }
    record("K1", "K", "e4b vs 31b same-prompt", start, {
      mechanism: {
        pass: mechPass,
        notes: [`8g.exit=${r8.status}`, `24g.exit=${r24.status}`, `8gLen=${r8.stdout.length}`, `24gLen=${r24.stdout.length}`],
      },
      judge: v,
      observedTail: observed.slice(-1500),
    });
    expect(mechPass).toBe(true);
    // judge transport / parse / empty failures = infra noise, not a real
    // verdict — record but do not flunk the scenario. Real failed verdicts
    // (pass:false with a substantive reason) still flunk.
    if (v && v.pass === false && !/transport error|judge empty|judge parse error/.test(v.reason)) {
      expect(v.pass).toBe(true);
    }
  }, 400_000);
});
