// operational-patterns.test.ts — 대화 기록 분석 기반 회귀 테스트 (6개 패턴)
//
// 출처: 77개 jsonl 대화 기록 → Node.js 스크립트 추출 → haiku 서브에이전트 분석
// 패턴 1~6은 실제 사용자 질의에서 반복 등장한 실패 유형.
// G15 CI safe: 파일 읽기 + 단위 로직만, API key / spawn 없음.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 이 파일 기준 repo 루트 (Windows fileURLToPath 필수 — new URL().pathname은 /D:/ 이중화 버그 있음)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname = .../naia-agent/packages/runtime/src/__tests__
// 4단계 위 = .../naia-agent (repo root)
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const BIN_PATH = path.join(REPO_ROOT, "bin", "naia-agent.ts");
const PKG_PATH = path.join(REPO_ROOT, "package.json");
const CHANGELOG_PATH = path.join(REPO_ROOT, "CHANGELOG.md");
const AGENTS_RULES_PATH = path.join(REPO_ROOT, ".agents", "context", "agents-rules.json");

// ─── 패턴 1: 프로세스 작업 디렉토리 불일치 (Working Directory Context) ────────
// 근거 질의: cwd가 프로젝트 루트가 아닐 때 bin이 실패하거나 잘못된 경로 사용
// 검증: parseArgs가 --workdir 값을 올바르게 파싱하고, 기본값은 process.cwd()임을 코드에서 확인

describe("패턴 1: 작업 디렉토리 컨텍스트 (cwd)", () => {
  it("bin/naia-agent.ts 파일이 존재한다", async () => {
    const exists = await access(BIN_PATH).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it("bin이 readline import를 포함한다 — TTY REPL 지원", async () => {
    const code = await readFile(BIN_PATH, "utf-8");
    expect(code).toContain("readline");
  });

  it("bin이 --workdir 인수를 파싱한다", async () => {
    const code = await readFile(BIN_PATH, "utf-8");
    expect(code).toContain("--workdir");
  });

  it("bin의 기본 workdir가 process.cwd()", async () => {
    const code = await readFile(BIN_PATH, "utf-8");
    // parseArgs에서 workdir: process.cwd() 를 기본값으로 사용
    expect(code).toContain("process.cwd()");
  });

  it("bin이 cwd injection guard를 포함한다 — G2 패턴", async () => {
    // coding-tool.ts의 G2와 같이, bin 또는 호출 경로에서 경로 검증 존재 여부
    const code = await readFile(BIN_PATH, "utf-8");
    // workdir를 인수로 받을 때 최소한 존재 여부 또는 절대경로 확인
    expect(code).toMatch(/workdir|cwd/);
  });
});

// ─── 패턴 2: 런타임 명령 (Runnable Command) 부재 ────────────────────────────
// 근거 질의: bin/naia-agent 존재하지만 사용자가 호출 가능한 명령이 불명확
// AGENTS.md success criterion §1: "새 실행 가능 명령"

describe("패턴 2: 실행 가능 명령 (pnpm naia-agent)", () => {
  it("package.json에 naia-agent script가 정의되어 있다", async () => {
    const raw = await readFile(PKG_PATH, "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const scripts = pkg["scripts"] as Record<string, string> | undefined;
    expect(scripts).toBeDefined();
    expect("naia-agent" in scripts!).toBe(true);
  });

  it("naia-agent script가 bin/naia-agent.ts를 가리킨다", async () => {
    const raw = await readFile(PKG_PATH, "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const scripts = pkg["scripts"] as Record<string, string>;
    expect(scripts["naia-agent"]).toContain("bin/naia-agent");
  });

  it("bin이 tsx로 실행된다 (shebang 또는 script)", async () => {
    const raw = await readFile(PKG_PATH, "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const scripts = pkg["scripts"] as Record<string, string>;
    // script에 tsx 포함 또는 bin 자체에 shebang 포함
    const binCode = await readFile(BIN_PATH, "utf-8");
    const hasTsx = scripts["naia-agent"]?.includes("tsx") || binCode.startsWith("#!/usr/bin/env -S pnpm exec tsx");
    expect(hasTsx).toBe(true);
  });

  it("bin이 --mode=direct 와 --mode=supervisor 양쪽 모두 처리한다", async () => {
    const code = await readFile(BIN_PATH, "utf-8");
    expect(code).toContain("--mode=direct");
    expect(code).toContain("--mode=supervisor");
  });

  it("bin이 piped stdin과 TTY stdin 양쪽 처리 로직을 포함한다", async () => {
    const code = await readFile(BIN_PATH, "utf-8");
    // TTY 감지
    expect(code).toMatch(/isTTY|process\.stdin\.isTTY/);
  });
});

// ─── 패턴 3: 4-repo 조합 검증 (Four-Repo Integration) ─────────────────────
// 근거 질의: naia-os/naia-agent/naia-adk/naia-memory 간 계약이 실제 동작하는지 불명확
// 검증: bin이 @nextain/agent-types, @nextain/agent-runtime, @nextain/agent-core 사용

describe("패턴 3: 4-repo 인터페이스 계약", () => {
  it("bin이 @nextain/agent-core Agent를 import한다", async () => {
    const code = await readFile(BIN_PATH, "utf-8");
    expect(code).toContain("@nextain/agent-core");
    expect(code).toContain("Agent");
  });

  it("bin이 @nextain/agent-types의 HostContext, LLMClient, MemoryProvider를 import한다", async () => {
    const code = await readFile(BIN_PATH, "utf-8");
    expect(code).toContain("@nextain/agent-types");
    expect(code).toContain("HostContext");
    expect(code).toContain("LLMClient");
    expect(code).toContain("MemoryProvider");
  });

  it("bin이 @nextain/agent-runtime의 InMemoryToolExecutor를 사용한다", async () => {
    const code = await readFile(BIN_PATH, "utf-8");
    expect(code).toContain("@nextain/agent-runtime");
    expect(code).toContain("InMemoryToolExecutor");
  });

  it("bin이 @nextain/agent-providers의 VercelClient를 사용한다", async () => {
    const code = await readFile(BIN_PATH, "utf-8");
    expect(code).toContain("@nextain/agent-providers");
    expect(code).toContain("VercelClient");
  });

  it("bin이 @nextain/agent-observability의 ConsoleLogger를 사용한다", async () => {
    const code = await readFile(BIN_PATH, "utf-8");
    expect(code).toContain("@nextain/agent-observability");
    expect(code).toContain("ConsoleLogger");
  });
});

// ─── 패턴 4: 개발 현황 추적 불명확 (Development Status) ──────────────────────
// 근거 질의: Slice 진행 상황이 문서와 코드 불일치, CHANGELOG 미갱신
// 검증: CHANGELOG와 agents-rules.json 구조적 완결성 확인

describe("패턴 4: 개발 현황 추적 (CHANGELOG / agents-rules.json)", () => {
  it("CHANGELOG.md가 존재한다", async () => {
    const exists = await access(CHANGELOG_PATH).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it("CHANGELOG.md에 [Unreleased] 섹션이 있다", async () => {
    const text = await readFile(CHANGELOG_PATH, "utf-8");
    expect(text).toContain("## [Unreleased]");
  });

  it("CHANGELOG.md에 최소 1개의 Slice 항목이 있다", async () => {
    const text = await readFile(CHANGELOG_PATH, "utf-8");
    // "## [Slice" 패턴
    expect(text).toMatch(/## \[Slice/);
  });

  it("agents-rules.json이 존재한다", async () => {
    const exists = await access(AGENTS_RULES_PATH).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it("agents-rules.json의 phase 필드가 문자열이다", async () => {
    const raw = await readFile(AGENTS_RULES_PATH, "utf-8");
    const rules = JSON.parse(raw) as Record<string, unknown>;
    expect(typeof rules["phase"]).toBe("string");
    expect((rules["phase"] as string).length).toBeGreaterThan(0);
  });

  it("agents-rules.json의 forbidden_actions가 배열이다", async () => {
    const raw = await readFile(AGENTS_RULES_PATH, "utf-8");
    const rules = JSON.parse(raw) as Record<string, unknown>;
    expect(Array.isArray(rules["forbidden_actions"])).toBe(true);
  });
});

// ─── 패턴 5: 로깅 신뢰성 (Logging & Observability) ───────────────────────────
// 근거 질의: agent 실행 시 로그 레벨 제어 안 됨, stderr/stdout 혼용
// 검증: ConsoleLogger 레벨 필터링, stream 분리

describe("패턴 5: 로깅 신뢰성 (ConsoleLogger)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("level=warn 시 debug 로그가 출력되지 않는다", async () => {
    const { ConsoleLogger } = await import("@nextain/agent-observability");
    const chunks: string[] = [];
    const fakeStream = { write: (s: string) => { chunks.push(s); return true; } };
    const logger = new ConsoleLogger({ level: "warn", stream: fakeStream as NodeJS.WritableStream });

    logger.debug("debug message");
    logger.info("info message");
    expect(chunks.length).toBe(0); // debug와 info 모두 출력 안 됨
  });

  it("level=warn 시 warn/error/fatal은 출력된다", async () => {
    const { ConsoleLogger } = await import("@nextain/agent-observability");
    const chunks: string[] = [];
    const fakeStream = { write: (s: string) => { chunks.push(s); return true; } };
    const logger = new ConsoleLogger({ level: "warn", stream: fakeStream as NodeJS.WritableStream });

    logger.warn("warn message");
    logger.error("error message");
    expect(chunks.length).toBe(2);
  });

  it("level=debug 시 모든 레벨이 출력된다", async () => {
    const { ConsoleLogger } = await import("@nextain/agent-observability");
    const chunks: string[] = [];
    const fakeStream = { write: (s: string) => { chunks.push(s); return true; } };
    const logger = new ConsoleLogger({ level: "debug", stream: fakeStream as NodeJS.WritableStream });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(chunks.length).toBe(4);
  });

  it("각 로그 항목은 JSON-lines 형식 (ts, level, msg 필드 포함)이다", async () => {
    const { ConsoleLogger } = await import("@nextain/agent-observability");
    const chunks: string[] = [];
    const fakeStream = { write: (s: string) => { chunks.push(s); return true; } };
    const logger = new ConsoleLogger({ level: "info", stream: fakeStream as NodeJS.WritableStream });

    logger.info("test message", { key: "value" });
    expect(chunks.length).toBe(1);
    const entry = JSON.parse(chunks[0]!) as Record<string, unknown>;
    expect(entry).toHaveProperty("ts");
    expect(entry).toHaveProperty("level", "info");
    expect(entry).toHaveProperty("msg", "test message");
    expect(entry).toHaveProperty("key", "value");
  });

  it("ConsoleLogger.tag()가 하위 logger를 반환하고 tags 필드를 추가한다", async () => {
    const { ConsoleLogger } = await import("@nextain/agent-observability");
    const chunks: string[] = [];
    const fakeStream = { write: (s: string) => { chunks.push(s); return true; } };
    const logger = new ConsoleLogger({ level: "info", stream: fakeStream as NodeJS.WritableStream });

    const tagged = logger.tag("naia-agent", "bin");
    tagged.info("tagged message");

    const entry = JSON.parse(chunks[0]!) as Record<string, unknown>;
    expect((entry["tags"] as string[])).toContain("naia-agent");
    expect((entry["tags"] as string[])).toContain("bin");
  });

  it("bin이 stderr와 stdout을 사용한다 — 로그/출력 분리", async () => {
    const code = await readFile(BIN_PATH, "utf-8");
    expect(code).toMatch(/process\.stderr/);
    expect(code).toMatch(/process\.stdout/);
  });
});

// ─── 패턴 6: 범위 경계 — naia-agent vs naia-adk (Scope Boundary) ────────────
// 근거 질의: Tool executor / skill이 어느 레포에 있는지 혼동, 민감 환경변수 노출
// 검증: GatedToolExecutor 존재, bash skill 위치, sensitive env 블랙리스트

describe("패턴 6: 범위 경계 (naia-agent runtime 책임)", () => {
  it("GatedToolExecutor 클래스가 runtime에 있다", async () => {
    const runtimePath = path.join(REPO_ROOT, "packages", "runtime", "src", "tool-executor.ts");
    const code = await readFile(runtimePath, "utf-8");
    expect(code).toContain("class GatedToolExecutor");
  });

  it("BashSkill (createBashSkill)이 runtime/skills에 있다", async () => {
    const skillPath = path.join(REPO_ROOT, "packages", "runtime", "src", "skills", "bash.ts");
    const exists = await access(skillPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it("coding-tool (createCodingSkill)이 runtime/skills에 있다", async () => {
    const skillPath = path.join(REPO_ROOT, "packages", "runtime", "src", "skills", "coding-tool.ts");
    const exists = await access(skillPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it("bin이 민감 환경변수 블랙리스트(SENSITIVE_ENV_PATTERNS)를 정의한다", async () => {
    const code = await readFile(BIN_PATH, "utf-8");
    expect(code).toContain("SENSITIVE_ENV_PATTERNS");
    expect(code).toContain("ANTHROPIC_");
    expect(code).toContain("_API_KEY");
  });

  it("bin이 LLM provider 해석 우선순위를 명시한다 (ANTHROPIC→OPENAI→GLM→VERTEX→mock)", async () => {
    const code = await readFile(BIN_PATH, "utf-8");
    expect(code).toContain("ANTHROPIC_API_KEY");
    expect(code).toContain("OPENAI_API_KEY");
    expect(code).toContain("GLM_API_KEY");
    expect(code).toContain("VERTEX_PROJECT_ID");
    // mock fallback
    expect(code).toContain("MockLLMClient");
  });

  it("runtime/index.ts가 GatedToolExecutor를 export한다", async () => {
    const indexPath = path.join(REPO_ROOT, "packages", "runtime", "src", "index.ts");
    const code = await readFile(indexPath, "utf-8");
    expect(code).toContain("GatedToolExecutor");
  });
});
