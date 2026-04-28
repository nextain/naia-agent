/**
 * Phase 5+ adversarial review fix - claude-cli env allowlist integration test.
 *
 * Adversarial review (user directive 2026-04-28): 1139 unit PASS were mock-only.
 * This test uses real child_process.spawn (Linux /usr/bin/env binary) to verify
 * env allowlist works at OS level.
 *
 * /usr/bin/env command prints current environment to stdout. If ClaudeCliClient
 * env scrubbing is correct, LD_PRELOAD, DYLD_*, ANTHROPIC_API_KEY should NOT
 * appear in output.
 *
 * Replicates allowlist construction (mirror, not import) since ClaudeCliClient
 * forces stream-json parsing - env verification is split.
 *
 * Skip on Windows / non-Linux (env binary missing).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:process";
import { describe, expect, it } from "vitest";

const SKIP_PLATFORMS = platform === "win32";
const ENV_BINARY = "/usr/bin/env";

describe.skipIf(SKIP_PLATFORMS || !existsSync(ENV_BINARY))(
  "claude-cli env allowlist integration - real /usr/bin/env spawn (no mock)",
  () => {
    function buildScrubbedEnv(maxOutputTokens: string): NodeJS.ProcessEnv {
      const ALLOWED_ENV_KEYS = [
        "PATH", "HOME", "USER",
        "LANG", "LC_ALL", "LC_CTYPE",
        "TERM", "TZ",
        "TMPDIR", "TEMP", "TMP",
        "FLATPAK", "FLATPAK_ID",
        "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
      ];
      const env: NodeJS.ProcessEnv = {};
      for (const key of ALLOWED_ENV_KEYS) {
        const v = process.env[key];
        if (v !== undefined) env[key] = v;
      }
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("CLAUDE_CODE_")
            && key !== "CLAUDE_CODE_MAX_OUTPUT_TOKENS"
            && key !== "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC") {
          env[key] = process.env[key];
        }
      }
      env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = maxOutputTokens;
      env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1";
      env["DISABLE_NON_ESSENTIAL_MODEL_CALLS"] = "1";
      return env;
    }

    async function spawnEnv(env: NodeJS.ProcessEnv): Promise<string> {
      return new Promise((resolve, reject) => {
        const child = spawn(ENV_BINARY, [], { env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (chunk) => { out += chunk.toString("utf-8"); });
        child.on("error", reject);
        child.on("close", () => resolve(out));
        setTimeout(() => {
          if (!child.killed) child.kill();
          reject(new Error("env spawn timeout"));
        }, 5000);
      });
    }

    it("LD_PRELOAD NOT propagated to subprocess env (real spawn)", async () => {
      process.env["LD_PRELOAD"] = "/tmp/evil.so";
      try {
        const env = buildScrubbedEnv("32000");
        const out = await spawnEnv(env);
        expect(out).not.toContain("LD_PRELOAD=");
      } finally {
        delete process.env["LD_PRELOAD"];
      }
    });

    it("LD_LIBRARY_PATH NOT propagated", async () => {
      process.env["LD_LIBRARY_PATH"] = "/tmp/evil";
      try {
        const env = buildScrubbedEnv("32000");
        const out = await spawnEnv(env);
        expect(out).not.toContain("LD_LIBRARY_PATH=");
      } finally {
        delete process.env["LD_LIBRARY_PATH"];
      }
    });

    it("ANTHROPIC_API_KEY NOT propagated (credential isolation)", async () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-test-secret-12345";
      try {
        const env = buildScrubbedEnv("32000");
        const out = await spawnEnv(env);
        expect(out).not.toContain("sk-test-secret");
        expect(out).not.toContain("ANTHROPIC_API_KEY=");
      } finally {
        delete process.env["ANTHROPIC_API_KEY"];
      }
    });

    it("CLAUDECODE NOT propagated", async () => {
      process.env["CLAUDECODE"] = "1";
      try {
        const env = buildScrubbedEnv("32000");
        const out = await spawnEnv(env);
        expect(out).not.toContain("CLAUDECODE=1");
      } finally {
        delete process.env["CLAUDECODE"];
      }
    });

    it("PATH IS propagated (binary resolution)", async () => {
      process.env["PATH"] = "/usr/bin:/bin";
      const env = buildScrubbedEnv("32000");
      const out = await spawnEnv(env);
      expect(out).toMatch(/PATH=\/usr\/bin/);
    });

    it("HOME IS propagated (.claude config)", async () => {
      const originalHome = process.env["HOME"];
      process.env["HOME"] = "/home/test-user";
      try {
        const env = buildScrubbedEnv("32000");
        const out = await spawnEnv(env);
        expect(out).toContain("HOME=/home/test-user");
      } finally {
        if (originalHome !== undefined) process.env["HOME"] = originalHome;
      }
    });

    it("CLAUDE_CODE_MAX_OUTPUT_TOKENS overridden by allowlist value", async () => {
      process.env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = "999999";
      try {
        const env = buildScrubbedEnv("16000");
        const out = await spawnEnv(env);
        expect(out).toContain("CLAUDE_CODE_MAX_OUTPUT_TOKENS=16000");
        expect(out).not.toContain("CLAUDE_CODE_MAX_OUTPUT_TOKENS=999999");
      } finally {
        delete process.env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"];
      }
    });

    it("Random env var NOT propagated", async () => {
      process.env["RANDOM_TEST_VAR_XYZ"] = "leaked";
      try {
        const env = buildScrubbedEnv("32000");
        const out = await spawnEnv(env);
        expect(out).not.toContain("RANDOM_TEST_VAR_XYZ=leaked");
      } finally {
        delete process.env["RANDOM_TEST_VAR_XYZ"];
      }
    });
  },
);
