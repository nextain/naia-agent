import type { ChildProcess } from "node:child_process";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_NO_TOOLS_CONFIG_FLAGS,
  buildCodexModelCatalogEntry,
  buildIsolatedPiChildEnv,
  buildNaiaCodexModelCatalog,
  buildNaiaPiModelsConfig,
  ensureNaiaPiConfig,
  isNaiaPiModel,
  normalizeNaiaGatewayModel,
  writeCodexModelCatalogFile,
} from "../main/adapters/naia-pi-provider.js";
import { codexWorkerEnv, makeCodexSubAgent } from "../main/adapters/subagent-codex.js";
import type { SpawnFn } from "../main/adapters/subprocess-session.js";

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

describe("UC-NAIA-PI provider isolation and Codex [model_providers.naia] loopback catalog", () => {
  it("writes an env-referenced custom provider without persisting the Naia key and preserves all 8 Naia models", () => {
    const dir = tempDir();
    ensureNaiaPiConfig({ dir, baseUrl: "https://gateway.example/v1/" });
    const text = readFileSync(join(dir, "models.json"), "utf8");
    expect(text).toContain('"grok-4.3"');
    expect(text).toContain('"deepseek-v4-flash"');
    expect(text).toContain('"deepseek-v4-pro"');
    expect(text).not.toContain('"gpt-5.6-sol"');
    expect(text).not.toContain('"gpt-5.6-luna"');
    expect(text).not.toContain("prompt_cache_key");
    expect(text).toContain('"X-AnyLLM-Key": "Bearer $NAIA_API_KEY"');
    expect(text).not.toContain("naia-secret-value");
    expect(buildNaiaPiModelsConfig("https://gateway.example")).toMatchObject({
      providers: { naia: { baseUrl: "https://gateway.example/v1", authHeader: false, models: [
        { id: "grok-4.3", cost: { input: 1.375, output: 2.75, cacheRead: 1.375 } },
        { id: "deepseek-v4-flash", cost: { input: 0.209, output: 0.561, cacheRead: 0.0308 } },
        { id: "deepseek-v4-pro" },
        { id: "solar-pro4", cost: { input: 0.33, output: 1.32, cacheRead: 0.066 } },
        { id: "solar-mini", cost: { input: 0.165, output: 0.165, cacheRead: 0.165 } },
        { id: "motif-3", reasoning: true, contextWindow: 262144, maxTokens: 8192,
          cost: { input: 0.26, output: 1.04, cacheRead: 0.052, cacheWrite: 0.26 } },
        { id: "HCX-007", cost: { input: 0.97, output: 3.88 } },
        { id: "HCX-DASH-002", cost: { input: 0.388, output: 1.552 } },
      ] } },
    });
    const models = (buildNaiaPiModelsConfig("https://gateway.example") as {
      providers: { naia: { models: Array<{ id: string }> } };
    }).providers.naia.models.map(({ id }) => id);
    expect(models).toEqual([
      "grok-4.3",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "solar-pro4",
      "solar-mini",
      "motif-3",
      "HCX-007",
      "HCX-DASH-002",
    ]);
  });

  it("recognizes Naia models case-insensitively including CLOVA uppercase ids and DASH-002 alias", () => {
    expect(isNaiaPiModel("grok-4.3")).toBe(true);
    expect(isNaiaPiModel("solar-pro4")).toBe(true);
    expect(isNaiaPiModel("motif-3")).toBe(true);
    expect(isNaiaPiModel("HCX-007")).toBe(true);
    expect(isNaiaPiModel("hcx-007")).toBe(true);
    expect(isNaiaPiModel("HCX-DASH-002")).toBe(true);
    expect(isNaiaPiModel("DASH-002")).toBe(true);
    expect(isNaiaPiModel("dash-002")).toBe(true);
    expect(normalizeNaiaGatewayModel("dash-002")).toBe("HCX-DASH-002");
    expect(normalizeNaiaGatewayModel("hcx-007")).toBe("HCX-007");
    expect(isNaiaPiModel("gpt-4o")).toBe(false);
    expect(isNaiaPiModel(undefined)).toBe(false);
  });

  it("builds Codex model_catalog_json entries with all 4 mandatory fields and noTools overrides", () => {
    const standardEntry = buildCodexModelCatalogEntry({
      slug: "motif-3",
      displayName: "Motif 3",
      contextWindow: 262_144,
      noTools: false,
    });
    expect(standardEntry).toMatchObject({
      slug: "motif-3",
      context_window: 262_144,
      use_responses_lite: false,
      tool_mode: "direct",
      experimental_supported_tools: [],
      supports_search_tool: false,
      shell_type: "shell_command",
      apply_patch_tool_type: null,
      input_modalities: ["text"],
    });

    const noToolsEntry = buildCodexModelCatalogEntry({
      slug: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      contextWindow: 128_000,
      noTools: true,
    });
    expect(noToolsEntry).toMatchObject({
      slug: "deepseek-v4-flash",
      use_responses_lite: false,
      tool_mode: "direct",
      experimental_supported_tools: [],
      supports_search_tool: false,
      shell_type: "disabled",
      apply_patch_tool_type: null,
      input_modalities: ["text"],
    });

    const dir = tempDir();
    const catalogPath = writeCodexModelCatalogFile(dir, buildNaiaCodexModelCatalog({ noTools: true }));
    const parsed = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Array<Record<string, unknown>> };
    expect(parsed.models).toHaveLength(9);
    for (const model of parsed.models) {
      expect(model).toMatchObject({
        use_responses_lite: false,
        tool_mode: "direct",
        experimental_supported_tools: [],
        supports_search_tool: false,
        shell_type: "disabled",
        apply_patch_tool_type: null,
        input_modalities: ["text"],
      });
    }
    expect(CODEX_NO_TOOLS_CONFIG_FLAGS).toHaveLength(16);
  });

  it("child env keeps runtime values and one-time NAIA_BRIDGE_TOKEN while dropping NAIA_API_KEY and direct-provider secrets", () => {
    const isolated = buildIsolatedPiChildEnv({
      PATH: "bin", PI_CODING_AGENT_DIR: "global-pi", NAIA_API_KEY: "n-old",
      OPENAI_API_KEY: "openai-secret", XAI_API_KEY: "xai-secret", DEEPSEEK_API_KEY: "deepseek-secret",
    }, "isolated-pi");
    expect(isolated).toMatchObject({ PATH: "bin", PI_CODING_AGENT_DIR: "isolated-pi" });
    expect(isolated.NAIA_API_KEY).toBeUndefined();
    expect(isolated.OPENAI_API_KEY).toBeUndefined();
    expect(isolated.XAI_API_KEY).toBeUndefined();
    expect(isolated.DEEPSEEK_API_KEY).toBeUndefined();

    const workerEnv = codexWorkerEnv({
      PATH: "bin",
      NAIA_API_KEY: "naia-secret-value",
      OPENAI_API_KEY: "openai-secret",
    }, {
      bridgeEnvKey: "NAIA_BRIDGE_TOKEN",
      bridgeToken: "naia-bridge-one-time-token",
      allowBridgeEnvKey: true,
    });
    expect(workerEnv.PATH).toBe("bin");
    expect(workerEnv.NAIA_BRIDGE_TOKEN).toBe("naia-bridge-one-time-token");
    expect(workerEnv.NAIA_API_KEY).toBeUndefined();
    expect(workerEnv.OPENAI_API_KEY).toBeUndefined();
  });

  it("spawns Codex with [model_providers.naia] (wire_api=responses), model_catalog_json, and NAIA_BRIDGE_TOKEN while keeping NAIA_API_KEY in parent only", async () => {
    let captured: { args: readonly string[]; env?: NodeJS.ProcessEnv } | undefined;
    const spawnFn: SpawnFn = (_command, args, options) => {
      captured = { args, env: options.env };
      return { stdout: { on() {} }, stderr: { on() {} }, on() { return this; }, kill() { return false; } } as unknown as ChildProcess;
    };
    const configDir = tempDir();
    const session = makeCodexSubAgent({
      resolveBin: () => ({ command: "codex", prefixArgs: [] }),
      spawnFn,
      provider: "naia",
      env: { PATH: "bin", NAIA_API_KEY: "naia-secret-value", OPENAI_API_KEY: "must-not-leak" },
      piConfigDir: configDir,
      gatewayBudget: gatewayBudget(configDir),
    }).spawn({ prompt: "fix it", workdir: ".", model: "motif-3" });
    await session.cancel("done");
    expect(captured?.args).toEqual(expect.arrayContaining([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-c", 'model_provider="naia"',
      "-c", expect.stringMatching(/^model_providers\.naia\.base_url="http:\/\/127\.0\.0\.1:\d+\/v1"$/),
      "-c", 'model_providers.naia.wire_api="responses"',
      "-c", 'model_providers.naia.env_key="NAIA_BRIDGE_TOKEN"',
      "-c", expect.stringMatching(/^model_catalog_json=/),
      "-c", "model_context_window=262144",
      "--model", "motif-3",
    ]));
    expect(captured?.env?.NAIA_BRIDGE_TOKEN).toMatch(/^naia-bridge-[0-9a-f-]{36}$/u);
    expect(captured?.env?.NAIA_API_KEY).toBeUndefined();
    expect(captured?.env?.OPENAI_API_KEY).toBeUndefined();
  });

  it("fails before spawn when Naia auth is missing or direct vendor routing is requested", async () => {
    let spawns = 0;
    const spawnFn: SpawnFn = () => { spawns += 1; throw new Error("must not spawn"); };
    const base = { resolveBin: () => ({ command: "codex", prefixArgs: [] }), spawnFn, piConfigDir: tempDir() };
    const missing = makeCodexSubAgent({ ...base, provider: "naia", env: {} }).spawn({ prompt: "p", workdir: ".", model: "grok-4.3" });
    const direct = makeCodexSubAgent({ ...base, provider: "xai", env: { NAIA_API_KEY: "k" } }).spawn({ prompt: "p", workdir: ".", model: "grok-4.3" });
    for (const session of [missing, direct]) {
      const events = [];
      for await (const event of session.events) events.push(event);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "session_end", ok: false });
    }
    expect(spawns).toBe(0);
  });

  it("passes all 8 noTools config flags and disabled catalog shell_type when noTools is requested on DeepSeek V4", async () => {
    let args: readonly string[] = [];
    const spawnFn: SpawnFn = (_command, next) => {
      args = next;
      return { stdout: { on() {} }, stderr: { on() {} }, on() { return this; }, kill() { return false; } } as unknown as ChildProcess;
    };
    const configDir = tempDir();
    const s1 = makeCodexSubAgent({
      resolveBin: () => ({ command: "codex", prefixArgs: [] }),
      spawnFn,
      provider: "naia",
      env: { NAIA_API_KEY: "k" },
      piConfigDir: configDir,
      gatewayBudget: gatewayBudget(configDir),
    }).spawn({ prompt: "review", workdir: ".", model: "deepseek-v4-flash", filesystemAccess: "read_only" });
    await s1.cancel("done");
    expect(args).not.toContain("features.shell_tool=false");

    const s2 = makeCodexSubAgent({
      resolveBin: () => ({ command: "codex", prefixArgs: [] }),
      spawnFn,
      provider: "naia",
      noTools: true,
      env: { NAIA_API_KEY: "k" },
      piConfigDir: configDir,
      gatewayBudget: gatewayBudget(configDir),
    }).spawn({ prompt: "review", workdir: ".", model: "deepseek-v4-pro" });
    await s2.cancel("done");
    for (const flag of CODEX_NO_TOOLS_CONFIG_FLAGS) {
      expect(args).toContain(flag);
    }
  });

  it("runs the beforeSpawn integrity gate for every spawn and fails before creating a child", async () => {
    let gates = 0; let spawns = 0;
    const configDir = tempDir();
    const adapter = makeCodexSubAgent({
      resolveBin: () => ({ command: "codex", prefixArgs: [] }),
      provider: "naia",
      spawnFn: () => {
        spawns += 1;
        return { stdout: { on() {} }, stderr: { on() {} }, on() { return this; }, kill() { return false; } } as unknown as ChildProcess;
      },
      beforeSpawn: () => {
        gates += 1; if (gates === 2) throw new Error("runtime changed");
      },
      env: { NAIA_API_KEY: "k" },
      piConfigDir: configDir,
      gatewayBudget: gatewayBudget(configDir),
    });
    const first = adapter.spawn({ prompt: "one", workdir: ".", model: "grok-4.3" });
    await first.cancel("done");
    const second = adapter.spawn({ prompt: "two", workdir: ".", model: "grok-4.3" });
    const events = [];
    for await (const event of second.events) events.push(event);
    expect(gates).toBe(2);
    expect(spawns).toBe(1);
    expect(events).toEqual([{ kind: "session_end", ok: false,
      reason: "Codex pre-spawn integrity gate failed: runtime changed" }]);
  });

  it("verifies bridge turns, provider_reported model, and settled billing receipts on turn.completed", async () => {
    const configDir = tempDir();
    let stdoutListener: ((chunk: Buffer) => void) | undefined;
    let closeListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    let capturedArgs: readonly string[] = [];
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let resolveSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => { resolveSpawned = resolve; });

    const spawnFn: SpawnFn = (_command, args, options) => {
      capturedArgs = args;
      capturedEnv = options.env;
      resolveSpawned();
      return {
        stdout: { on(ev: string, cb: (chunk: Buffer) => void) { if (ev === "data") stdoutListener = cb; } },
        stderr: { on() {} },
        on(ev: string, cb: (...a: any[]) => void) { if (ev === "close") closeListener = cb; return this; },
        kill() { closeListener?.(0, null); return true; },
      } as unknown as ChildProcess;
    };

    const fakeGatewayFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "chatcmpl-bridge-1",
        object: "chat.completion",
        created: 1,
        model: "grok-4.3",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_tokens_details: { cached_tokens: 4 } },
        customer_cost: "0.00004321",
        price_version_id: "pv-1",
        currency: "USD",
        settlement_status: "settled",
        billing_status: "settled",
        gateway_request_id: body.gateway_request_id,
        gateway_attempt: body.gateway_attempt,
      }), { status: 200 });
    };

    const session = makeCodexSubAgent({
      resolveBin: () => ({ command: "codex", prefixArgs: [] }),
      spawnFn,
      provider: "naia",
      env: { NAIA_API_KEY: "test-naia-key" },
      piConfigDir: configDir,
      gatewayBudget: gatewayBudget(configDir),
      fetch: fakeGatewayFetch,
    }).spawn({ prompt: "hello", workdir: ".", model: "grok-4.3" });

    await spawned;
    const baseUrlArg = capturedArgs.find((a) => a.startsWith("model_providers.naia.base_url="))!;
    const baseUrl = JSON.parse(baseUrlArg.slice("model_providers.naia.base_url=".length)) as string;
    const res = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${capturedEnv?.NAIA_BRIDGE_TOKEN}`,
      },
      body: JSON.stringify({
        model: "grok-4.3",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    stdoutListener?.(Buffer.from(
      `${JSON.stringify({ type: "thread.started", thread_id: "t-1" })}\n` +
      `${JSON.stringify({ type: "item.completed", item: { id: "i-1", type: "agent_message", text: "ok" } })}\n` +
      `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 4, output_tokens: 5 } })}\n`,
    ));
    closeListener?.(0, null);

    const events = [];
    for await (const ev of session.events) events.push(ev);
    const modelEv = events.find((e) => e.kind === "model_evidence");
    expect(modelEv).toMatchObject({
      kind: "model_evidence",
      evidence: {
        provider: "naia",
        selectedModel: "grok-4.3",
        modelEvidenceSource: "provider_reported",
        usageAvailable: true,
        inputTokens: 16,
        cachedInputTokens: 4,
        outputTokens: 5,
        totalTokens: 25,
        measuredCostUsd: 0.00004321,
        gatewayBillingReceipts: [
          expect.objectContaining({
            provider: "naia",
            model: "grok-4.3",
            responseModel: "grok-4.3",
            customerCostDecimal: "0.00004321",
          }),
        ],
      },
    });
    expect(events.at(-1)).toMatchObject({ kind: "session_end", ok: true });
  });

  it("reconciles and attaches orphan receipts to failed session_end evidence when settleGatewayRequest throws reservation exceeded (P3)", async () => {
    const configDir = tempDir();
    let stdoutListener: ((chunk: Buffer) => void) | undefined;
    let closeListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    let capturedArgs: readonly string[] = [];
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let resolveSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => { resolveSpawned = resolve; });

    const spawnFn: SpawnFn = (_command, args, options) => {
      capturedArgs = args;
      capturedEnv = options.env;
      resolveSpawned();
      return {
        stdout: { on(ev: string, cb: (chunk: Buffer) => void) { if (ev === "data") stdoutListener = cb; } },
        stderr: { on() {} },
        on(ev: string, cb: (...a: any[]) => void) { if (ev === "close") closeListener = cb; return this; },
        kill() { closeListener?.(0, null); return true; },
      } as unknown as ChildProcess;
    };

    const overrunningFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "chatcmpl-overrun-1",
        object: "chat.completion",
        created: 1,
        model: "grok-4.3",
        choices: [{ index: 0, message: { role: "assistant", content: "overrun" }, finish_reason: "stop" }],
        // Exceeds reservedUsd: 0.05 -> settleGatewayRequest throws after appendNaiaPiGatewayReceipt
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_tokens_details: { cached_tokens: 4 } },
        customer_cost: "0.09000000",
        price_version_id: "pv-1",
        currency: "USD",
        settlement_status: "settled",
        billing_status: "settled",
        gateway_request_id: body.gateway_request_id,
        gateway_attempt: body.gateway_attempt,
      }), { status: 200 });
    };

    const session = makeCodexSubAgent({
      resolveBin: () => ({ command: "codex", prefixArgs: [] }),
      spawnFn,
      provider: "naia",
      env: { NAIA_API_KEY: "test-naia-key" },
      piConfigDir: configDir,
      gatewayBudget: gatewayBudget(configDir),
      fetch: overrunningFetch,
    }).spawn({ prompt: "hello", workdir: ".", model: "grok-4.3" });

    await spawned;
    const baseUrlArg = capturedArgs.find((a) => a.startsWith("model_providers.naia.base_url="))!;
    const baseUrl = JSON.parse(baseUrlArg.slice("model_providers.naia.base_url=".length)) as string;
    const res = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${capturedEnv?.NAIA_BRIDGE_TOKEN}`,
      },
      body: JSON.stringify({
        model: "grok-4.3",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    });
    expect(res.status).toBe(502);
    await res.text();

    stdoutListener?.(Buffer.from(
      `${JSON.stringify({ type: "thread.started", thread_id: "t-overrun" })}\n` +
      `${JSON.stringify({ type: "turn.failed", error: { message: "bridge returned 502" } })}\n`,
    ));
    closeListener?.(1, null);

    const events = [];
    for await (const ev of session.events) events.push(ev);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "model_evidence",
        evidence: expect.objectContaining({
          provider: "naia",
          selectedModel: "grok-4.3",
          measuredCostUsd: 0.09,
          gatewayBillingReceipts: [
            expect.objectContaining({
              customerCostDecimal: "0.09000000",
            }),
          ],
        }),
      }),
      expect.objectContaining({
        kind: "session_end",
        ok: false,
        reason: expect.stringContaining("gateway receipt exceeded its durable reservation"),
        evidence: expect.objectContaining({
          measuredCostUsd: 0.09,
          gatewayBillingReceipts: [
            expect.objectContaining({
              customerCostDecimal: "0.09000000",
            }),
          ],
        }),
      }),
    ]));
  });
});
