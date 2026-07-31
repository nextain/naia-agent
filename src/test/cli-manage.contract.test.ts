// @spec SPEC-019 — FE19 first-class CLI pure policy contract.
import { describe, expect, it } from "vitest";
import {
  FALLBACK_NAIA_MODELS,
  applyCodingDefaults,
  credentialNameForProvider,
  getCliConfigValue,
  isSafeSessionId,
  normalizeModelCatalog,
  parseCliConfig,
  parseManageArgs,
  parseTranscript,
  removeEnvLines,
  resetCliConfigValue,
  setCliConfigValue,
} from "../main/app/cli-manage.js";
import { makeReplConversation } from "../main/app/cli-chat.js";

describe("SPEC-019 management command grammar", () => {
  it.each([
    [["auth", "status", "--json"], { command: "auth", action: "status", json: true }],
    [["auth", "login", "--provider", "naia"], { command: "auth", action: "login", provider: "naia" }],
    [["auth", "logout", "--provider", "openai"], { command: "auth", action: "logout", provider: "openai" }],
    [["config", "list"], { command: "config", action: "list" }],
    [["config", "get", "coding.model"], { command: "config", action: "get", key: "coding.model" }],
    [["config", "set", "coding.tools", "false"], { command: "config", action: "set", key: "coding.tools", value: "false" }],
    [["config", "reset", "workspace"], { command: "config", action: "reset", key: "workspace" }],
    [["models", "naia", "--json"], { command: "models", provider: "naia", json: true }],
    [["doctor", "--json"], { command: "doctor", json: true }],
    [["session", "list", "--limit", "7", "--json"], { command: "session", action: "list", limit: 7, json: true }],
    [["session", "show", "cli-123"], { command: "session", action: "show", sessionId: "cli-123" }],
    [["session", "resume", "cli-123"], { command: "session", action: "resume", sessionId: "cli-123" }],
  ])("parses %j", (argv, shape) => {
    const result = parseManageArgs(argv as string[]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args).toMatchObject(shape);
  });

  it.each([
    ["auth", "login"],
    ["auth", "login", "--provider", "unknown"],
    ["config", "get", "secret"],
    ["config", "set", "coding.tools"],
    ["session", "list", "--limit", "0"],
    ["session", "show", "../escape"],
    ["doctor", "--bad"],
  ])("rejects malformed argv: %s", (...argv) => {
    expect(parseManageArgs(argv).ok).toBe(false);
  });
});

describe("SPEC-019 allowlisted config and precedence", () => {
  it("preserves unrelated keys while setting/resetting only managed fields", () => {
    const base = parseCliConfig('{"other":{"keep":true},"adkPath":"C:\\\\old"}');
    const set = setCliConfigValue(base, "coding.agent", "pi");
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const model = setCliConfigValue(set.config, "coding.model", "grok-4.3");
    expect(model.ok).toBe(true);
    if (!model.ok) return;
    const tools = setCliConfigValue(model.config, "coding.tools", "false");
    expect(tools.ok).toBe(true);
    if (!tools.ok) return;
    expect(getCliConfigValue(tools.config, "coding.tools")).toBe(false);
    expect(resetCliConfigValue(tools.config, "workspace")).toMatchObject({ other: { keep: true }, coding: { agent: "pi" } });
  });

  it("validates types/agent and recovers from damaged config", () => {
    expect(parseCliConfig("{bad")).toEqual({});
    expect(setCliConfigValue({}, "coding.tools", "maybe")).toMatchObject({ ok: false });
    expect(setCliConfigValue({}, "coding.agent", "evil")).toMatchObject({ ok: false });
    expect(setCliConfigValue({}, "coding.model", "--no-tools")).toMatchObject({ ok: false });
    expect(setCliConfigValue({}, "workspace", "--help")).toMatchObject({ ok: false });
  });

  it("treats stored agent/model/tools as one default tuple", () => {
    const config = { coding: { agent: "pi", model: "grok-4.3", tools: false } };
    expect(applyCodingDefaults(["task"], config)).toEqual(["task", "--agent", "pi", "--model", "grok-4.3", "--no-tools"]);
    expect(applyCodingDefaults(["task", "--agent", "codex", "--model", "x", "--tools"], config))
      .toEqual(["task", "--agent", "codex", "--model", "x", "--tools"]);
    expect(applyCodingDefaults(["task", "--agent", "codex"], config))
      .toEqual(["task", "--agent", "codex"]);
    expect(applyCodingDefaults(["task", "--agent", "pi"], config))
      .toEqual(["task", "--agent", "pi", "--model", "grok-4.3", "--no-tools"]);
    expect(applyCodingDefaults(["task", "--model", "other-model"], config))
      .toEqual(["task", "--model", "other-model", "--agent", "pi"]);
    expect(applyCodingDefaults(["task", "--model", "grok-4.3"], config))
      .toEqual(["task", "--model", "grok-4.3", "--agent", "pi", "--no-tools"]);
  });

  it("uses the downstream parser's last-option-wins precedence for repeated values", () => {
    const config = { coding: { agent: "pi", model: "grok-4.3", tools: true } };
    expect(applyCodingDefaults(["task", "--agent", "pi", "--agent", "codex"], config))
      .toEqual(["task", "--agent", "pi", "--agent", "codex"]);
    expect(applyCodingDefaults(["task", "--agent", "codex", "--agent", "pi"], config))
      .toEqual(["task", "--agent", "codex", "--agent", "pi", "--model", "grok-4.3", "--tools"]);
    expect(applyCodingDefaults(["task", "--model", "grok-4.3", "--model", "other"], config))
      .toEqual(["task", "--model", "grok-4.3", "--model", "other", "--agent", "pi"]);
  });

  it("preserves malformed argv for the downstream parser instead of masking it with defaults", () => {
    const config = { coding: { agent: "pi", model: "grok-4.3", tools: false } };
    expect(applyCodingDefaults(["task", "--agent"], config)).toEqual(["task", "--agent"]);
    expect(applyCodingDefaults(["task", "--agent", "--model", "x"], config))
      .toEqual(["task", "--agent", "--model", "x"]);
    expect(applyCodingDefaults(["task", "--workdir", "--tools"], config))
      .toEqual(["task", "--workdir", "--tools"]);
    expect(applyCodingDefaults(["task", "--model", "-h"], config))
      .toEqual(["task", "--model", "-h"]);
    expect(applyCodingDefaults(["task", "--unknown"], config)).toEqual(["task", "--unknown"]);
  });
});

describe("SPEC-019 credential text policy", () => {
  it("uses OS credential account names and a canonical Naia account", () => {
    expect(credentialNameForProvider("naia")).toBe("NAIA_ANYLLM_API_KEY");
    expect(credentialNameForProvider("nextain")).toBe("NAIA_ANYLLM_API_KEY");
    expect(credentialNameForProvider("glm")).toBe("GLM_API_KEY");
    expect(credentialNameForProvider("unknown")).toBeNull();
  });

  it("removes only selected legacy env lines and preserves comments/providers", () => {
    const source = "# keep\nOPENAI_API_KEY=o\nNAIA_API_KEY=n\nX=1\n";
    expect(removeEnvLines(source, ["NAIA_API_KEY"])).toBe("# keep\nOPENAI_API_KEY=o\nX=1\n");
  });
});

describe("SPEC-019 model catalog truthfulness", () => {
  it("normalizes live OpenAI-shaped catalog and marks DeepSeek analysis-only", () => {
    expect(normalizeModelCatalog({ data: [
      { id: "deepseek-v4-pro", owned_by: "azure", name: "DeepSeek" },
      { id: "grok-4.3", owned_by: "azure", supports_tools: true },
      { id: "grok-4.3", owned_by: "duplicate" },
    ] })).toEqual([
      { provider: "azure", id: "deepseek-v4-pro", label: "DeepSeek", tools: false, use: "analysis" },
      { provider: "azure", id: "grok-4.3", label: "grok-4.3", tools: true, use: "coding" },
    ]);
    expect(FALLBACK_NAIA_MODELS.map((x) => x.id)).toEqual(["grok-4.3", "deepseek-v4-pro"]);
    expect(normalizeModelCatalog({ bad: true })).toEqual([]);
  });
});

describe("SPEC-019 bounded complete-turn session resume", () => {
  it("rejects path traversal IDs", () => {
    expect(isSafeSessionId("cli-abc_123")).toBe(true);
    expect(isSafeSessionId("../escape")).toBe(false);
    expect(isSafeSessionId("a/b")).toBe(false);
  });

  it("keeps complete pairs only, tolerates corrupt lines, and bounds recent messages", () => {
    const lines = [
      JSON.stringify({ role: "assistant", content: "orphan" }),
      JSON.stringify({ role: "user", content: "u1" }),
      "{bad",
      JSON.stringify({ role: "assistant", content: "a1" }),
      JSON.stringify({ role: "user", content: "incomplete" }),
      JSON.stringify({ role: "user", content: "u2" }),
      JSON.stringify({ role: "assistant", content: "a2" }),
    ].join("\n");
    const parsed = parseTranscript(lines, 2);
    expect(parsed.messages).toEqual([{ role: "user", content: "u2" }, { role: "assistant", content: "a2" }]);
    expect(parsed.skipped).toBeGreaterThanOrEqual(3);
    expect(parsed.truncated).toBe(true);
  });

  it("injects resumed history into the existing REPL core without mutation", () => {
    const initial = [{ role: "user" as const, content: "before" }, { role: "assistant" as const, content: "answer" }];
    const repl = makeReplConversation({
      io: { write: () => {}, prompt: () => {} },
      newRequestId: () => "r1",
      sessionId: "cli-old",
      initialHistory: initial,
    });
    let sent: any;
    repl.ingress.onRequest((request) => { sent = request; });
    expect(repl.submit("next")).toBe(true);
    expect(sent).toMatchObject({ sessionId: "cli-old", messages: [...initial, { role: "user", content: "next" }] });
    expect(initial).toHaveLength(2);
  });
});
