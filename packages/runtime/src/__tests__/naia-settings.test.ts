// Cross-repo LLM config — naia-settings/llm.json reader (Task #3, Slice A).
// Asserts: main → existing provider env keys, local no-key sentinel,
// apiKeyRef env deref, sub/embedded → NAIA_SUB_*/NAIA_EMBED_*, process.env
// precedence (never overwritten), graceful skip on missing/malformed.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Logger } from "@nextain/agent-types";
import { loadNaiaSettingsLLM } from "../utils/naia-settings.js";
import { __setSecretStoreForTest, type SecretStore } from "../utils/secret-store.js";

const TOUCHED = [
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
  "GLM_API_KEY", "GLM_BASE_URL", "GLM_MODEL",
  "NAIA_SUB_PROVIDER", "NAIA_SUB_BASE_URL", "NAIA_SUB_MODEL",
  "NAIA_EMBED_PROVIDER", "NAIA_EMBED_BASE_URL", "NAIA_EMBED_MODEL", "NAIA_EMBED_DIMS",
  "NAIA_ADK_PATH", "MY_KEY_REF", "MISSING_REF", "NAIA_ALLOW_MANIFEST_BASEURL_HOSTS", "KCREF",
  "NAIA_SUB_API_KEY", "NAIA_EMBED_API_KEY",
];

const fakeStore = (map: Record<string, string>): SecretStore => ({
  available: () => true,
  get: (n) => map[n],
  set: () => true,
});

let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  saved = {};
  for (const k of TOUCHED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "nset-"));
});
afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
  __setSecretStoreForTest(); // reset keychain seam
});

function writeLLM(obj: unknown): string {
  mkdirSync(join(dir, "naia-settings"), { recursive: true });
  writeFileSync(join(dir, "naia-settings", "llm.json"), JSON.stringify(obj));
  return dir;
}

const LOCAL = {
  version: 1,
  main: { provider: "openai-compat", baseUrl: "http://127.0.0.1:11434/v1", model: "gemma3n:e4b" },
  sub: { provider: "openai-compat", baseUrl: "http://127.0.0.1:11434/v1", model: "gemma3n:e2b" },
  embedded: { provider: "ollama-embed", baseUrl: "http://127.0.0.1:11434/v1", model: "bge-m3", dims: 1024 },
};

describe("loadNaiaSettingsLLM", () => {
  it("no adkPath / no NAIA_ADK_PATH → skipped, sets nothing", () => {
    const r = loadNaiaSettingsLLM();
    expect(r.skipped).toBe(true);
    expect(r.setKeys).toEqual([]);
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
  });

  it("local openai-compat main → OPENAI_* + 'ollama' key sentinel; sub/embedded → NAIA_*", () => {
    const r = loadNaiaSettingsLLM({ adkPath: writeLLM(LOCAL) });
    expect(r.skipped).toBe(false);
    expect(process.env.OPENAI_BASE_URL).toBe("http://127.0.0.1:11434/v1");
    expect(process.env.OPENAI_MODEL).toBe("gemma3n:e4b");
    expect(process.env.OPENAI_API_KEY).toBe("ollama"); // local no-key sentinel
    expect(process.env.NAIA_SUB_MODEL).toBe("gemma3n:e2b");
    expect(process.env.NAIA_EMBED_MODEL).toBe("bge-m3");
    expect(process.env.NAIA_EMBED_DIMS).toBe("1024");
    expect(r.roles).toEqual({ main: "openai-compat", sub: "openai-compat", embedded: "ollama-embed" });
  });

  it("process.env precedence — pre-set key is NEVER overwritten", () => {
    process.env.OPENAI_MODEL = "user-pinned";
    loadNaiaSettingsLLM({ adkPath: writeLLM(LOCAL) });
    expect(process.env.OPENAI_MODEL).toBe("user-pinned");
    expect(process.env.OPENAI_BASE_URL).toBe("http://127.0.0.1:11434/v1"); // unset → applied
  });

  it("anthropic main apiKeyRef → deref from env; absent ref → key unset (honest fall-through)", () => {
    process.env.MY_KEY_REF = "sk-secret-xyz";
    loadNaiaSettingsLLM({
      adkPath: writeLLM({ main: { provider: "anthropic", model: "claude-x", apiKeyRef: "MY_KEY_REF" } }),
    });
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-secret-xyz");
    expect(process.env.ANTHROPIC_MODEL).toBe("claude-x");

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.MY_KEY_REF;
    loadNaiaSettingsLLM({
      adkPath: writeLLM({ main: { provider: "anthropic", model: "claude-y", apiKeyRef: "MY_KEY_REF" } }),
    });
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined(); // no sentinel for anthropic
    expect(process.env.ANTHROPIC_MODEL).toBe("claude-y");
  });

  it("apiKeyRef resolves from OS keychain when env var is unset", () => {
    __setSecretStoreForTest(fakeStore({ KCREF: "kc-secret-val" }));
    loadNaiaSettingsLLM({
      adkPath: writeLLM({ main: { provider: "anthropic", model: "claude-z", apiKeyRef: "KCREF" } }),
    });
    expect(process.env.ANTHROPIC_API_KEY).toBe("kc-secret-val");
  });

  it("env var WINS over keychain for the same apiKeyRef", () => {
    process.env.KCREF = "env-wins";
    __setSecretStoreForTest(fakeStore({ KCREF: "kc-loses" }));
    loadNaiaSettingsLLM({
      adkPath: writeLLM({ main: { provider: "anthropic", model: "claude-z", apiKeyRef: "KCREF" } }),
    });
    expect(process.env.ANTHROPIC_API_KEY).toBe("env-wins");
  });

  it("missing file → skipped gracefully (env-only path still works)", () => {
    const r = loadNaiaSettingsLLM({ adkPath: dir }); // dir exists, no naia-settings/llm.json
    expect(r.skipped).toBe(true);
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
  });

  it("openai-compat: resolved apiKeyRef OVERRIDES the local sentinel", () => {
    process.env.MY_KEY_REF = "real-key-123";
    loadNaiaSettingsLLM({
      adkPath: writeLLM({
        main: { provider: "openai-compat", baseUrl: "http://127.0.0.1:11434/v1", model: "m", apiKeyRef: "MY_KEY_REF" },
      }),
    });
    expect(process.env.OPENAI_API_KEY).toBe("real-key-123"); // not "ollama"
  });

  it("openai-compat: REMOTE baseUrl + no apiKeyRef → NO 'ollama' sentinel (honest)", () => {
    loadNaiaSettingsLLM({
      adkPath: writeLLM({
        main: { provider: "openai-compat", baseUrl: "https://api.openrouter.ai/v1", model: "m" },
      }),
    });
    expect(process.env.OPENAI_BASE_URL).toBe("https://api.openrouter.ai/v1");
    expect(process.env.OPENAI_MODEL).toBe("m");
    expect(process.env.OPENAI_API_KEY).toBeUndefined(); // remote → no sentinel
  });

  it("openai-compat: apiKeyRef present but UNRESOLVED → NO sentinel (symmetric w/ anthropic)", () => {
    loadNaiaSettingsLLM({
      adkPath: writeLLM({
        main: { provider: "openai-compat", baseUrl: "http://127.0.0.1:11434/v1", model: "m", apiKeyRef: "MISSING_REF" },
      }),
    });
    expect(process.env.OPENAI_API_KEY).toBeUndefined(); // ref set but env absent
  });

  it("unknown provider → role recorded, no env mapped", () => {
    const r = loadNaiaSettingsLLM({ adkPath: writeLLM({ main: { provider: "weird-x", model: "m" } }) });
    expect(r.roles.main).toBe("weird-x");
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_MODEL).toBeUndefined();
  });

  it("version != 1 → warn but still proceeds", () => {
    const warns: string[] = [];
    const logger = { warn: (m: string) => void warns.push(m), fn: () => undefined } as unknown as Logger;
    const r = loadNaiaSettingsLLM({ adkPath: writeLLM({ version: 2, main: { provider: "openai-compat", baseUrl: "http://127.0.0.1:11434/v1", model: "m" } }), logger });
    expect(r.skipped).toBe(false);
    expect(r.roles.main).toBe("openai-compat");
    expect(warns.some((w) => w.includes("version.unknown"))).toBe(true);
  });

  it("plaintext secret in a role → WHOLE file rejected (no env set), warns", () => {
    const warns: string[] = [];
    const logger = { warn: (m: string) => void warns.push(m), fn: () => undefined } as unknown as Logger;
    // (a) intuitive wrong field name
    const r1 = loadNaiaSettingsLLM({
      adkPath: writeLLM({ main: { provider: "anthropic", apiKey: "sk-ant-REALSECRET12345", model: "m" } }),
      logger,
    });
    expect(r1.skipped).toBe(true);
    expect(process.env.ANTHROPIC_MODEL).toBeUndefined();
    expect(warns.some((w) => w.includes("plaintext_suspected"))).toBe(true);
    // (b) raw-secret-looking VALUE in an otherwise-fine field
    const r2 = loadNaiaSettingsLLM({
      adkPath: writeLLM({ main: { provider: "openai-compat", baseUrl: "http://127.0.0.1:11434/v1", model: "AIzaSyAabcdefghij1234567890" } }),
      logger,
    });
    expect(r2.skipped).toBe(true);
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
  });

  it("malformed JSON / invalid shape → warn + skip, no throw", () => {
    const warns: string[] = [];
    const logger = { warn: (m: string) => void warns.push(m), fn: () => undefined } as unknown as Logger;
    mkdirSync(join(dir, "naia-settings"), { recursive: true });
    writeFileSync(join(dir, "naia-settings", "llm.json"), "{ not json");
    const r1 = loadNaiaSettingsLLM({ adkPath: dir, logger });
    expect(r1.skipped).toBe(true);
    expect(warns.some((w) => w.includes("parse.error"))).toBe(true);

    writeFileSync(join(dir, "naia-settings", "llm.json"), JSON.stringify({ version: 1 }));
    const r2 = loadNaiaSettingsLLM({ adkPath: dir, logger });
    expect(r2.skipped).toBe(true);
    expect(warns.some((w) => w.includes("shape.invalid"))).toBe(true);
  });
});
