import { join } from "node:path";

export function withoutBenchmarkIntegrityKey(env) {
  const { NAIA_BENCHMARK_JOURNAL_KEY: _integrityAuthority, ...childEnv } = env;
  return childEnv;
}

export function withoutBenchmarkCredentials(env) {
  const allowed = ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "HOME", "USERPROFILE",
    "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TZ"];
  return Object.fromEntries(allowed.flatMap((key) => typeof env[key] === "string" ? [[key, env[key]]] : []));
}

export function makeBenchmarkGitInvocation(isolationRoot, args, extraEnv = {}, baseEnv = process.env) {
  const env = withoutBenchmarkCredentials({ ...baseEnv });
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  for (const key of ["GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"])
    if (typeof extraEnv[key] === "string") env[key] = extraEnv[key];
  return {
    args: ["-c", `core.hooksPath=${join(isolationRoot, "hooks")}`, ...args],
    env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(isolationRoot, "global.gitconfig"),
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: join(isolationRoot, "hooks"), GIT_TERMINAL_PROMPT: "0" },
  };
}

/** Applies the same isolation to transitive Git calls made inside worktree and verifier adapters. */
export function installBenchmarkProcessIsolation(isolationRoot, env = process.env) {
  delete env.NAIA_BENCHMARK_JOURNAL_KEY;
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = join(isolationRoot, "global.gitconfig");
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "core.hooksPath";
  env.GIT_CONFIG_VALUE_0 = join(isolationRoot, "hooks");
  env.GIT_TERMINAL_PROMPT = "0";
}
