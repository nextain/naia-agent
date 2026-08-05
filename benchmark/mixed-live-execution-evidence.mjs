import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { digestDirectory, git, sha256 } from "./mixed-live-seal-utils.mjs";

const require = createRequire(import.meta.url);

export const SUPPORT_MODULE_PATHS = [
  "benchmark/mixed-live-durable-validation.mjs",
  "benchmark/mixed-live-execution-evidence.mjs",
  "benchmark/mixed-live-seal-utils.mjs",
  "benchmark/mixed-live-secure-files.mjs",
];

export function captureMixedLiveExecutionEvidence(repositoryRoot) {
  const sourceCommit = git(repositoryRoot, ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("mixed live source commit is invalid");
  execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: repositoryRoot });
  execFileSync("git", ["diff", "--cached", "--quiet", "HEAD", "--"], { cwd: repositoryRoot });
  const sourcePaths = ["benchmark/run-mixed-issue-team-live.mjs", "benchmark/seal-mixed-issue-team-live.mjs",
    ...SUPPORT_MODULE_PATHS];
  for (const path of sourcePaths) {
    execFileSync("git", ["ls-files", "--error-unmatch", path], { cwd: repositoryRoot, stdio: "ignore" });
  }
  const compilerPath = join(repositoryRoot, "node_modules/typescript/bin/tsc");
  execFileSync(process.execPath, [compilerPath, "-p", join(repositoryRoot, "tsconfig.json")],
    { cwd: repositoryRoot, stdio: "pipe" });
  const executables = {
    node: captureNodeExecutable(),
    claude: captureExecutable(repositoryRoot, "claude", "CLAUDE_BIN"),
    opencode: captureExecutable(repositoryRoot, "opencode", "OPENCODE_BIN"),
    codex: captureExecutable(repositoryRoot, "codex", "CODEX_BIN"),
  };
  return {
    sourceCommit,
    sourceTree: git(repositoryRoot, ["rev-parse", `${sourceCommit}^{tree}`]),
    benchmarkScriptSha256: sourceSha256(repositoryRoot, sourceCommit, "benchmark/run-mixed-issue-team-live.mjs"),
    sealerSha256: sourceSha256(repositoryRoot, sourceCommit, "benchmark/seal-mixed-issue-team-live.mjs"),
    supportModuleSha256: Object.fromEntries(SUPPORT_MODULE_PATHS.map((path) =>
      [path, sourceSha256(repositoryRoot, sourceCommit, path)])),
    runtimeBuild: { completed: true, compilerSha256: sha256(readFileSync(compilerPath)),
      compilerClosure: digestDirectory(dirname(dirname(compilerPath))),
      sqliteClosure: captureSqliteClosure(),
      tsconfigSha256: sourceSha256(repositoryRoot, sourceCommit, "tsconfig.json") },
    executables,
    runtimeClosure: digestDirectory(join(repositoryRoot, "dist/main")),
  };
}

export function validateExecutionEvidence(value, repositoryRoot, sourceCommit, requireCurrentSourceMatch) {
  const compilerPath = join(repositoryRoot, "node_modules/typescript/bin/tsc");
  const expectedSupportModules = Object.fromEntries(SUPPORT_MODULE_PATHS.map((path) =>
    [path, sourceSha256(repositoryRoot, sourceCommit, path)]));
  if (!value || value.sourceCommit !== sourceCommit
    || value.sourceTree !== git(repositoryRoot, ["rev-parse", `${sourceCommit}^{tree}`])
    || value.benchmarkScriptSha256 !== sourceSha256(repositoryRoot, sourceCommit, "benchmark/run-mixed-issue-team-live.mjs")
    || value.sealerSha256 !== sourceSha256(repositoryRoot, sourceCommit, "benchmark/seal-mixed-issue-team-live.mjs")
    || JSON.stringify(value.supportModuleSha256) !== JSON.stringify(expectedSupportModules)
    || value.runtimeBuild?.completed !== true || value.runtimeBuild.compilerSha256 !== sha256(readFileSync(compilerPath))
    || JSON.stringify(value.runtimeBuild.compilerClosure) !== JSON.stringify(digestDirectory(dirname(dirname(compilerPath))))
    || JSON.stringify(value.runtimeBuild.sqliteClosure) !== JSON.stringify(captureSqliteClosure())
    || value.runtimeBuild.tsconfigSha256 !== sourceSha256(repositoryRoot, sourceCommit, "tsconfig.json")) {
    throw new Error("execution evidence is not bound to the declared source commit");
  }
  validateExecutableEvidence(value.executables, repositoryRoot);
  const currentSupportModules = Object.fromEntries(SUPPORT_MODULE_PATHS.map((path) =>
    [path, sha256(readFileSync(join(repositoryRoot, path)))]));
  const currentBenchmarkSha256 = sha256(readFileSync(join(repositoryRoot, "benchmark/run-mixed-issue-team-live.mjs")));
  const currentSealerSha256 = sha256(readFileSync(join(repositoryRoot, "benchmark/seal-mixed-issue-team-live.mjs")));
  if (currentBenchmarkSha256 !== value.benchmarkScriptSha256 || currentSealerSha256 !== value.sealerSha256
    || JSON.stringify(currentSupportModules) !== JSON.stringify(value.supportModuleSha256)
    || JSON.stringify(value.runtimeClosure) !== JSON.stringify(digestDirectory(join(repositoryRoot, "dist/main")))) {
    throw new Error("current benchmark source or execution runtime closure does not match the live run");
  }
  if (requireCurrentSourceMatch) {
    const executionPaths = ["src/main", "benchmark", "tsconfig.json", "package.json", "pnpm-lock.yaml"];
    execFileSync("git", ["diff", "--quiet", sourceCommit, "--", ...executionPaths], { cwd: repositoryRoot });
    execFileSync("git", ["diff", "--cached", "--quiet", sourceCommit, "--", ...executionPaths], { cwd: repositoryRoot });
  }
}

function sourceSha256(repositoryRoot, sourceCommit, path) {
  return sha256(execFileSync("git", ["show", `${sourceCommit}:${path}`], { cwd: repositoryRoot }));
}

function captureExecutable(cwd, command, environmentName) {
  const configured = process.env[environmentName]?.trim();
  const discovered = configured || execFileSync(process.platform === "win32" ? "where" : "which", [command],
    { cwd, encoding: "utf8" }).trim().split(/\r?\n/u)[0];
  if (!isAbsolute(discovered)) throw new Error(`${environmentName} must resolve to an absolute executable path`);
  const path = realpathSync(discovered); const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`${command} executable is not a regular file`);
  const version = execFileSync(path, ["--version"], { cwd, encoding: "utf8", timeout: 15_000 }).trim();
  if (!version || version.length > 512) throw new Error(`${command} version evidence is invalid`);
  const packageClosures = command === "codex" ? captureCodexPackageClosures(path) : {};
  return { command, path, sha256: sha256(readFileSync(path)), version, packageClosures };
}

function captureNodeExecutable() {
  const path = realpathSync(process.execPath);
  return { command: "node", path, sha256: sha256(readFileSync(path)), version: process.version, packageClosures: {} };
}

function captureCodexPackageClosures(entryPath) {
  const packageRoot = dirname(dirname(entryPath)); const scopeRoot = join(packageRoot, "node_modules/@openai");
  const output = {};
  for (const name of readdirSync(scopeRoot).filter((value) => value.startsWith("codex-")).sort()) {
    const path = join(scopeRoot, name); if (statSync(path).isDirectory()) output[name] = digestDirectory(path);
  }
  if (Object.keys(output).length !== 1) throw new Error("Codex native package closure is ambiguous or unavailable");
  return output;
}

function validateExecutableEvidence(value, cwd) {
  if (!value || Object.keys(value).sort().join(",") !== "claude,codex,node,opencode") {
    throw new Error("coding executable evidence is incomplete");
  }
  for (const command of ["node", "claude", "opencode", "codex"]) {
    const executable = value[command];
    if (executable?.command !== command || !isAbsolute(executable.path)
      || !/^[0-9a-f]{64}$/u.test(executable.sha256) || typeof executable.version !== "string"
      || !executable.version || executable.version.length > 512) throw new Error("coding executable evidence is invalid");
    const currentPath = command === "node" ? realpathSync(process.execPath)
      : realpathSync(process.env[{ claude: "CLAUDE_BIN", opencode: "OPENCODE_BIN", codex: "CODEX_BIN" }[command]]
        || execFileSync(process.platform === "win32" ? "where" : "which", [command],
          { cwd, encoding: "utf8" }).trim().split(/\r?\n/u)[0]);
    const currentVersion = command === "node" ? process.version
      : execFileSync(currentPath, ["--version"], { cwd, encoding: "utf8", timeout: 15_000 }).trim();
    if (sha256(readFileSync(currentPath)) !== executable.sha256 || currentVersion !== executable.version) {
      throw new Error(`coding executable changed during live run: ${command}`);
    }
    if (command === "codex" && JSON.stringify(executable.packageClosures)
      !== JSON.stringify(captureCodexPackageClosures(currentPath))) {
      throw new Error("Codex native package closure changed during live run");
    }
  }
}

function captureSqliteClosure() {
  return digestDirectory(dirname(require.resolve("better-sqlite3/package.json")));
}
