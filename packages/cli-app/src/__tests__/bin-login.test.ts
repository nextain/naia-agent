// packages/cli-app/src/__tests__/bin-login.test.ts
// S1~S4 사용자 시나리오 기반 bin-level 통합 테스트.
// fixes G01/S1/S2/S3/S4.
//
// 커버리지 전략:
//   실행 테스트 — spawnSync(non-TTY) 에서 검증 가능한 경로.
//     S1: login non-TTY 에러 경로 (3개)
//     S2: env auto-load (2개 — positive + negative)
//     S3: NAIA_ADK_PATH config auto-load (2개 — positive + negative)
//     S4: piped stdin no-provider 에러 (1개)
//   2개 .todo() — TTY 장벽으로 인한 BLOCKED (S1-L1, S1-L2).
//
// 실행: pnpm test (vitest run)
// 참조: docs/llm-config-standard.md, bin/naia-agent.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
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
  const h = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");
  if (existsSync(h)) return h;
  throw new Error("tsx dist/cli.mjs not found; install tsx as devDependency");
}
const tsxCli = findTsxCli();

function homeEnv(tmpHome: string): NodeJS.ProcessEnv {
  return process.platform === "win32"
    ? { USERPROFILE: tmpHome }
    : { HOME: tmpHome };
}

function runBin(
  args: string[],
  env?: NodeJS.ProcessEnv,
  stdinInput?: string,
  timeoutMs = 15_000,
) {
  return spawnSync(process.execPath, [tsxCli, binPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    input: stdinInput,
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

// ── S1-L3, S1-L4: non-TTY 환경에서 검증 가능한 login 에러 경로 ──────────────
describe("login subcommand — non-TTY behavior (S1-L3, S1-L4)", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "naia-login-"));
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("non-TTY stdin → exit 3 + 'stdin must be a TTY' message (S1-L3)", () => {
    // non-TTY(spawnSync)에서 login 실행하면 isTTY 체크에서 즉시 exit 3.
    const r = runBin(
      ["login", "--key", "anthropic"],
      homeEnv(tmpHome),
      "sk-ant-fake-key\n",
    );
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("stdin must be a TTY");
  });

  it("missing --key → exit 3 + usage hint with provider list (S1-L4a)", () => {
    const r = runBin(["login"], homeEnv(tmpHome));
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("missing --key");
    expect(r.stderr).toMatch(/anthropic|openai|glm|vertex/);
  });

  it("unknown provider → exit 3 + supported list (S1-L4b)", () => {
    const r = runBin(["login", "--key", "unknown-xyz"], homeEnv(tmpHome));
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("unknown provider");
    expect(r.stderr).toMatch(/anthropic|openai|glm|vertex/);
  });
});

// ── S1-L1, S1-L2: TTY-gated behaviors — 현재 non-TTY 테스트 환경에서 BLOCKED ─
describe("login subcommand — TTY-gated behaviors (S1-L1, S1-L2)", () => {
  it.todo(
    "S1-L1: 빈 키 입력 → exit 3 + 'aborted (empty value)' — " +
      "BLOCKED: promptLine() requires TTY for interactive input; " +
      "non-TTY 환경(spawnSync)에서는 L830 isTTY 체크에서 먼저 exit 3",
  );
  it.todo(
    "S1-L2: 이미 저장된 키 재설정 시 skip + 'already set' message — " +
      "BLOCKED: runLogin() exits at isTTY check before reaching duplicate detection " +
      "(bin/naia-agent.ts:830); 'already set in ${envPath} — skipping' 메시지 코드는 L859",
  );
  it.todo(
    "B4 regression: configureNaiaKey() + configureMainLlm() naia 분기 — " +
      "saveApiKeys()가 selectFromList() 이후에 위치해야 함 (partial-save 방지). " +
      "BLOCKED: TTY-gated 함수, spawnSync non-TTY 환경에서 구조적으로 진입 불가. " +
      "코드 주석 (R4-B, R5/R6-A2)으로 의도 보존.",
  );
});

// ── S2: env-loader auto-load — Track A 해소 + DRYRUN 훅으로 검증 ─────────────
// loadEnvAndConfig()가 main()에서 호출됨 (Track A 완료).
// NAIA_AGENT_DRYRUN=1로 실제 LLM 호출 없이 provider 로드 여부 확인.
describe("S2: env-loader auto-load from ~/.naia-agent/.env (Track A RESOLVED)", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "naia-s2-"));
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("S2: ~/.naia-agent/.env auto-loaded → provider key recognized (exit 0 with DRYRUN)", () => {
    // 임시 HOME에 .naia-agent/.env 생성
    const naiaDir = join(tmpHome, ".naia-agent");
    mkdirSync(naiaDir, { recursive: true });
    writeFileSync(join(naiaDir, ".env"), "ANTHROPIC_API_KEY=sk-ant-test-s2-fake\n", { mode: 0o600 });

    const r = runBin(
      ["hi"],
      {
        ...homeEnv(tmpHome),
        // 부모 env의 API key를 모두 제거 — .env 파일에서만 로드해야 함
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        GLM_API_KEY: undefined,
        VERTEX_PROJECT_ID: undefined,
        NAIA_AGENT_DRYRUN: "1",
      },
    );
    // provider configured → dry-run exit 0
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("dry-run OK");
    expect(r.stderr).not.toContain("no LLM provider configured");
  });

  it("S2-neg: without .env file → no provider → exit 3", () => {
    // .env 파일 없이 실행하면 여전히 exit 3
    const r = runBin(
      ["hi"],
      {
        ...homeEnv(tmpHome),
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        GLM_API_KEY: undefined,
        VERTEX_PROJECT_ID: undefined,
        NAIA_AGENT_DRYRUN: "1",
      },
    );
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("no LLM provider configured");
  });
});

// ── S3: NAIA_ADK_PATH config auto-load ────────────────────────────────────────
describe("S3: NAIA_ADK_PATH/naia-settings/config.json auto-load (Track A RESOLVED)", () => {
  let tmpHome: string;
  let tmpAdk: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "naia-s3h-"));
    tmpAdk = mkdtempSync(join(tmpdir(), "naia-s3a-"));
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpAdk, { recursive: true, force: true });
  });

  it("S3: NAIA_ADK_PATH/naia-settings/config.json loaded → key recognized", () => {
    // naia-adk workspace에 config.json 생성
    const settingsDir = join(tmpAdk, "naia-settings");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "config.json"),
      JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-test-s3-fake" }),
    );

    const r = runBin(
      ["hi"],
      {
        ...homeEnv(tmpHome),
        NAIA_ADK_PATH: tmpAdk,
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        GLM_API_KEY: undefined,
        VERTEX_PROJECT_ID: undefined,
        NAIA_AGENT_DRYRUN: "1",
      },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("dry-run OK");
  });

  it("S3-neg: NAIA_ADK_PATH exists but config.json missing → exit 3", () => {
    // tmpAdk 디렉토리는 있지만 naia-settings/config.json 없음
    const r = runBin(
      ["hi"],
      {
        ...homeEnv(tmpHome),
        NAIA_ADK_PATH: tmpAdk,
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        GLM_API_KEY: undefined,
        VERTEX_PROJECT_ID: undefined,
        NAIA_AGENT_DRYRUN: "1",
      },
    );
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("no LLM provider configured");
  });
});

// ── S4: piped stdin direct mode — LLM 미설정 시 helpful error ─────────────────
describe("S4: piped stdin direct mode", () => {
  it("piped stdin with no LLM provider configured → exit 3 + helpful error", () => {
    // 모든 API key 비워두고 메시지를 piped stdin으로 보내면
    // buildLLMClient()가 MockLLMClient fallback 후 에러 or 설정 에러.
    const r = runBin(
      [],
      {
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        OPENAI_BASE_URL: "",
        NAIA_ANYLLM_API_KEY: "",
        NAIA_ANYLLM_BASE_URL: "",
        GLM_API_KEY: "",
        VERTEX_PROJECT_ID: "",
      },
      "hello world\n",
    );
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("no LLM provider configured");
  });
});
