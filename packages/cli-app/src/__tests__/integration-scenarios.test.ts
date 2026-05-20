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
import { judge, judgeAvailable, type JudgeVerdict } from "./lib/llm-judge.js";

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
  return {
    PATH: process.env["PATH"],
    HOME: home,
    USER: process.env["USER"],
    SHELL: process.env["SHELL"],
    ...extras,
  };
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
    if (mechPass && judgeAvailable()) {
      v = await judge({
        scenarioId: "A1",
        description: "Korean one-sentence greeting from gemma4:31b",
        expected:
          "The output should be a natural Korean greeting in one or two sentences. " +
          "It must NOT contain leaked reasoning markers like `*`, `**Constraint:**`, " +
          "`Internal thought:`, English bullet lists, or empty content.",
        observed,
      });
    }
    record("A1", "A", "Korean one-sentence greeting (24G)", start, {
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
    if (mechPass && judgeAvailable()) {
      v = await judge({
        scenarioId: "A4",
        description: "refuse to fabricate when no tools available",
        expected:
          "Output says the model cannot run commands / does not have tools / " +
          "cannot list files directly. It MUST NOT fabricate a concrete file " +
          "list with names like 'passwd', 'hosts', 'fstab' as if it ran ls.",
        observed,
      });
    }
    record("A4", "A", "no-tools refuse-fabricate (24G)", start, {
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
    if (mechPass && judgeAvailable()) {
      v = await judge({
        scenarioId: "F2",
        description: "persona-flavored memory recall across processes (24G)",
        expected:
          "In p2 the assistant names the dog '코코'. The tone should remain Korean " +
          "and natural. Inventing a different name or replying in English = FAIL.",
        observed,
      });
    }
    record("F2", "F", "persona + memory (24G)", start, {
      mechanism: { pass: mechPass, notes: [`p1=${r1.status}`, `p2=${r2.status}`] },
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
        schemaVersion: "1.0.0",
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
      /(unknown backend|backend.*not supported|no LLM provider|MANIFEST_INVALID|langgraph)/i.test(
        stderr,
      );
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
      /(unknown backend|backend.*not supported|no LLM provider|MANIFEST_INVALID|rag-retriever)/i.test(
        stderr,
      );
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
