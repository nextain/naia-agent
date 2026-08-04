import type { ChildProcess } from "node:child_process";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildNaiaPiChildEnv,
  buildNaiaPiModelsConfig,
  ensureNaiaPiConfig,
} from "../main/adapters/naia-pi-provider.js";
import { makeCumulativePiLineParser, makePiSubAgent, piLineToEvents, type SpawnFn } from "../main/adapters/subagent-pi.js";

const tempDirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "naia-pi-test-"));
  tempDirs.push(dir);
  return dir;
};
const gatewayBudget = (dir: string) => ({ path: join(dir, "gateway.db"), policy: {
  maxGatewayCalls: 4, maxUsd: 0.2, maxInputTokens: 16_000, maxOutputTokens: 2_000,
  requestAllowance: { reservedUsd: 0.05, reservedInputTokens: 4_000, reservedOutputTokens: 500 },
} });
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("UC-NAIA-PI provider isolation", () => {
  it("writes an env-referenced custom provider without persisting the Naia key", () => {
    const dir = tempDir();
    ensureNaiaPiConfig({ dir, baseUrl: "https://gateway.example/v1/" });
    const text = readFileSync(join(dir, "models.json"), "utf8");
    expect(text).toContain('"grok-4.3"');
    expect(text).toContain('"deepseek-v4-pro"');
    expect(text).not.toContain('"gpt-5.6-sol"');
    expect(text).not.toContain('"gpt-5.6-luna"');
    expect(text).not.toContain("prompt_cache_key");
    expect(text).toContain('"X-AnyLLM-Key": "Bearer $NAIA_API_KEY"');
    expect(text).not.toContain("naia-secret-value");
    expect(buildNaiaPiModelsConfig("https://gateway.example")).toMatchObject({
      providers: { naia: { baseUrl: "https://gateway.example/v1", authHeader: false } },
    });
    expect(buildNaiaPiModelsConfig("https://gateway.example", 321)).toMatchObject({
      providers: { naia: { models: [{ maxTokens: 321 }, { maxTokens: 321 }] } },
    });
    const models = (buildNaiaPiModelsConfig("https://gateway.example") as {
      providers: { naia: { models: Array<{ id: string }> } };
    }).providers.naia.models.map(({ id }) => id);
    expect(models).toEqual(["grok-4.3", "deepseek-v4-pro"]);
  });

  it("child env keeps runtime values and Naia auth but drops global Pi/direct-provider secrets", () => {
    const env = buildNaiaPiChildEnv({
      PATH: "bin", PI_CODING_AGENT_DIR: "global-pi", NAIA_API_KEY: "n-old",
      OPENAI_API_KEY: "openai-secret", XAI_API_KEY: "xai-secret", DEEPSEEK_API_KEY: "deepseek-secret",
    }, "isolated-pi", "naia-secret-value");
    expect(env).toMatchObject({ PATH: "bin", PI_CODING_AGENT_DIR: "isolated-pi", NAIA_API_KEY: "naia-secret-value" });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it("Grok automatically selects Naia and spawns with only the isolated child env", () => {
    let captured: { args: readonly string[]; env?: NodeJS.ProcessEnv } | undefined;
    const spawnFn: SpawnFn = (_command, args, options) => {
      captured = { args, env: options.env };
      return { stdout: { on() {} }, stderr: { on() {} }, on() { return this; }, kill() { return false; } } as unknown as ChildProcess;
    };
    const configDir = tempDir();
    makePiSubAgent({
      resolveBin: () => ({ command: "pi", prefixArgs: [] }), spawnFn,
      env: { PATH: "bin", NAIA_API_KEY: "naia-secret-value", OPENAI_API_KEY: "must-not-leak" },
      piConfigDir: configDir,
    }).spawn({ prompt: "fix it", workdir: ".", model: "grok-4.3" });
    expect(captured?.args).toEqual(["-p", "fix it", "--mode", "json", "--no-session",
      "--no-extensions", "--extension", expect.stringContaining("naia-versioned-billing-extension.mjs"),
      "--provider", "naia", "--model", "grok-4.3"]);
    expect(captured?.env?.NAIA_API_KEY).toBe("naia-secret-value");
    expect(captured?.env?.OPENAI_API_KEY).toBeUndefined();
    expect(captured?.env?.PI_CODING_AGENT_DIR).toBeTruthy();
    expect(captured?.env?.NAIA_PI_EXECUTION_ID).toMatch(/^[0-9a-f-]{36}$/u);
    expect(captured?.env?.NAIA_PI_RECEIPT_PATH).toContain("receipts");
    expect(captured?.env?.NAIA_PI_GATEWAY_BUDGET_PATH).toContain("gateway-budgets");
    expect(JSON.parse(captured?.env?.NAIA_PI_GATEWAY_BUDGET_POLICY ?? "{}")).toMatchObject({
      maxGatewayCalls: 8, maxUsd: 0.2, maxInputTokens: 32_000,
    });
  });

  it("fails before spawn when auth is missing, direct routing is requested, or DeepSeek lacks --no-tools", async () => {
    let spawns = 0;
    const spawnFn: SpawnFn = () => { spawns += 1; throw new Error("must not spawn"); };
    const base = { resolveBin: () => ({ command: "pi", prefixArgs: [] }), spawnFn, piConfigDir: tempDir() };
    const missing = makePiSubAgent({ ...base, env: {} }).spawn({ prompt: "p", workdir: ".", model: "grok-4.3" });
    const direct = makePiSubAgent({ ...base, provider: "xai", env: { NAIA_API_KEY: "k" } }).spawn({ prompt: "p", workdir: ".", model: "grok-4.3" });
    const tools = makePiSubAgent({ ...base, env: { NAIA_API_KEY: "k" } }).spawn({ prompt: "p", workdir: ".", model: "deepseek-v4-pro" });
    for (const session of [missing, direct, tools]) {
      const events = [];
      for await (const event of session.events) events.push(event);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "session_end", ok: false });
    }
    expect(spawns).toBe(0);
  });

  it("DeepSeek analysis adds --no-tools", () => {
    let args: readonly string[] = [];
    const spawnFn: SpawnFn = (_command, next) => {
      args = next;
      return { stdout: { on() {} }, stderr: { on() {} }, on() { return this; }, kill() { return false; } } as unknown as ChildProcess;
    };
    const configDir = tempDir();
    makePiSubAgent({
      resolveBin: () => ({ command: "pi", prefixArgs: [] }), spawnFn, noTools: true,
      env: { NAIA_API_KEY: "k" }, piConfigDir: configDir, gatewayBudget: gatewayBudget(configDir),
    }).spawn({ prompt: "review", workdir: ".", model: "deepseek-v4-pro" });
    expect(args).toContain("--no-tools");
  });

  it("emits Pi-reported provider/model/usage evidence and fails on Pi model mismatch", () => {
    const ok = piLineToEvents(JSON.stringify({
      type: "message_end",
      message: { role: "assistant", provider: "naia", model: "grok-4.3", content: [], usage: { input: 3, output: 4, totalTokens: 7, cost: { total: 0.01 } } },
    }), { provider: "naia", model: "grok-4.3" });
    expect(ok).toEqual([{ kind: "model_evidence", evidence: {
      provider: "naia", selectedModel: "grok-4.3", modelEvidenceSource: "provider_reported",
      usageAvailable: true, inputTokens: 3, cachedInputTokens: 0, outputTokens: 4, totalTokens: 7,
      piEstimatedCost: 0.01,
    } }]);

    const mismatch = piLineToEvents(JSON.stringify({
      type: "message_end",
      message: { provider: "naia", model: "other", content: [], usage: { input: 1, output: 1, totalTokens: 2 } },
    }), { provider: "naia", model: "grok-4.3" });
    expect(mismatch.at(-1)).toMatchObject({ kind: "session_end", ok: false });

    const malformed = piLineToEvents(JSON.stringify({
      type: "message_end",
      message: { provider: "naia", model: "grok-4.3", content: [], usage: { input: "3", output: 4, totalTokens: 7 } },
    }), { provider: "naia", model: "grok-4.3" });
    expect(malformed).toEqual([{ kind: "model_evidence", evidence: {
      provider: "naia", selectedModel: "grok-4.3", modelEvidenceSource: "provider_reported",
      usageAvailable: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0,
    } }]);
  });

  it("accumulates every assistant turn including cache usage and priced cost", () => {
    const parse = makeCumulativePiLineParser({ provider: "naia", model: "grok-4.3" });
    parse(JSON.stringify({ type: "message_end", message: { provider: "naia", model: "grok-4.3", content: [],
      usage: { input: 3, cacheRead: 5, cacheWrite: 2, output: 4, totalTokens: 14, cost: { total: 0.01 } } } }));
    const second = parse(JSON.stringify({ type: "message_end", message: { provider: "naia", model: "grok-4.3", content: [],
      usage: { input: 7, cacheRead: 11, cacheWrite: 3, output: 6, totalTokens: 27, cost: { total: 0.02 } } } }));
    expect(second).toEqual([{ kind: "model_evidence", evidence: expect.objectContaining({
      inputTokens: 15, cachedInputTokens: 16, outputTokens: 10, totalTokens: 41, piEstimatedCost: 0.03,
    }) }]);
  });
});
