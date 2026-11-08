import { describe, expect, it } from "vitest";
import {
  checkCodexPreflight,
  codexExecutable,
  makeCodexAppServerProvider,
  runCodexAppServerTurn,
  type CodexRunTurn,
  type CodexTurnInput,
  type RpcPeer,
} from "../main/adapters/codex-app-server-provider.js";
import { makeProviderResolver } from "../main/adapters/provider-resolver.js";
import { resolveProviderRoute } from "../main/domain/provider-route.js";
import type { ProviderChunk } from "../main/domain/chat.js";

async function collect(stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const chunks: ProviderChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("Codex app-server main provider", () => {
  it("uses the Windows npm command shim while preserving the POSIX executable", () => {
    expect(codexExecutable("win32")).toBe("codex.cmd");
    expect(codexExecutable("linux")).toBe("codex");
    expect(codexExecutable("darwin")).toBe("codex");
  });

  it("codex는 OpenAI API-key native가 아닌 전용 route다", () => {
    expect(resolveProviderRoute({ provider: "codex", model: "gpt-5.4" })).toBe("codex");
  });

  it("메시지/system/model을 app-server turn에 전달하고 정규화 chunk를 방출한다", async () => {
    let captured: CodexTurnInput | undefined;
    const runTurn: CodexRunTurn = (input) => {
      captured = input;
      return (async function* () {
        yield { kind: "thinking", text: "검토" } as const;
        yield { kind: "text", text: "안녕하세요" } as const;
        yield { kind: "usage", inputTokens: 11, outputTokens: 7 } as const;
        yield { kind: "completed" } as const;
      })();
    };
    const provider = makeCodexAppServerProvider({ runTurn });
    const chunks = await collect(provider.chat(
      { provider: "codex", model: "gpt-5.4" },
      [
        { role: "system", content: "한국어로 답해" },
        { role: "user", content: "안녕" },
      ],
      { systemPrompt: "간결하게" },
    ));

    expect(captured?.model).toBe("gpt-5.4");
    expect(captured?.systemPrompt).toContain("간결하게");
    expect(captured?.systemPrompt).toContain("한국어로 답해");
    expect(captured?.prompt).toContain("User: 안녕");
    expect(chunks).toEqual([
      { kind: "thinking", text: "검토" },
      { kind: "text", text: "안녕하세요" },
      { kind: "usage", inputTokens: 11, outputTokens: 7 },
      { kind: "finish" },
    ]);
  });

  it("resolver는 fetch/API key 없이 Codex transport를 선택한다", async () => {
    let fetchCalls = 0;
    const resolver = makeProviderResolver({
      fetch: (async () => {
        fetchCalls++;
        throw new Error("must not fetch");
      }) as never,
      codexRunTurn: () => (async function* () {
        yield { kind: "text", text: "ok" } as const;
        yield { kind: "completed" } as const;
      })(),
    });
    const config = { provider: "codex", model: "gpt-5.4" };
    const chunks = await collect(resolver.resolve(config).chat(config, [{ role: "user", content: "hi" }], {}));
    expect(fetchCalls).toBe(0);
    expect(chunks).toEqual([{ kind: "text", text: "ok" }, { kind: "finish" }]);
  });

  it("자동승인 도구만 app-server에 광고하고 native 실행 이벤트를 재실행 없이 정규화한다", async () => {
    let captured: CodexTurnInput | undefined;
    const runTurn: CodexRunTurn = (input) => {
      captured = input;
      return (async function* () {
        yield { kind: "toolUse", id: "call-1", name: "get_time", args: { timezone: "Asia/Seoul" } } as const;
        yield { kind: "toolResult", id: "call-1", name: "get_time", output: "10:30", success: true } as const;
        yield { kind: "text", text: "현재 시각은 10:30입니다." } as const;
        yield { kind: "completed" } as const;
      })();
    };
    const executeTool = async () => ({ output: "10:30" });
    const provider = makeCodexAppServerProvider({ runTurn });
    const tools = [{ name: "get_time", description: "현재 시각", parameters: { type: "object" }, tier: "none" }] as const;
    const chunks = await collect(provider.chat(
      { provider: "codex", model: "gpt-5.4" },
      [{ role: "user", content: "몇 시야?" }],
      { tools, executeTool },
    ));

    expect(captured?.tools).toBe(tools);
    expect(captured?.executeTool).toBe(executeTool);
    expect(chunks).toEqual([
      { kind: "toolUse", id: "call-1", name: "get_time", args: { timezone: "Asia/Seoul" }, handled: true },
      { kind: "toolResult", id: "call-1", name: "get_time", output: "10:30", success: true, handled: true },
      { kind: "text", text: "현재 시각은 10:30입니다." },
      { kind: "finish" },
    ]);
  });

  it("현재 app-server 동적 도구 RPC 계약으로 로컬·처리정책 도구 결과를 같은 turn에 응답한다", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const responses: Array<{ id: number | string; result: unknown }> = [];
    let executions = 0;
    let closed = false;
    const peer: RpcPeer = {
      async request(method, params) {
        requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        return {};
      },
      notify() {},
      respond(id, result) { responses.push({ id, result }); },
      notifications() {
        return (async function* () {
          yield { id: 77, method: "item/tool/call", params: {
            threadId: "thread-1", turnId: "turn-1", callId: "call-77",
            namespace: "dynamic", tool: "get_time", arguments: { timezone: "Asia/Seoul" },
          } };
          // app-server/transport retry: JSON-RPC id는 다르지만 callId+입력은 동일.
          yield { id: 78, method: "item/tool/call", params: {
            threadId: "thread-1", turnId: "turn-1", callId: "call-77",
            namespace: "dynamic", tool: "get_time", arguments: { timezone: "Asia/Seoul" },
          } };
          yield { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "지금은 10:30입니다." } };
          yield { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } };
        })();
      },
      close() { closed = true; },
    };
    const events = [];
    for await (const event of runCodexAppServerTurn({
      model: "gpt-5.4",
      prompt: "몇 시야?",
      tools: [
        { name: "get_time", description: "현재 시각", parameters: { type: "object" }, tier: "none" },
        { name: "delegate_agent", description: "역할 위임", parameters: { type: "object" }, tier: "none", processing: {
          workload: "sub_llm", destination: "external_cloud", provider: "codex", model: "luna",
        } },
        { name: "network", description: "외부 호출", parameters: { type: "object" }, tier: "network" },
      ],
      executeTool: async (call) => {
        executions += 1;
        return { output: call.name === "get_time" ? "10:30" : "unexpected" };
      },
    }, async () => peer)) events.push(event);

    expect(requests[0]).toMatchObject({ method: "initialize", params: { capabilities: { experimentalApi: true } } });
    expect(requests[1]).toMatchObject({
      method: "thread/start",
      params: { dynamicTools: [
        { type: "function", name: "get_time", inputSchema: { type: "object" } },
        { type: "function", name: "delegate_agent", inputSchema: { type: "object" } },
      ] },
    });
    expect(JSON.stringify(requests[1])).not.toContain("network");
    expect(responses).toEqual([
      { id: 77, result: { contentItems: [{ type: "inputText", text: "10:30" }], success: true } },
      { id: 78, result: { contentItems: [{ type: "inputText", text: "10:30" }], success: true } },
    ]);
    expect(executions).toBe(1);
    expect(events).toEqual([
      { kind: "toolUse", id: "call-77", name: "get_time", args: { timezone: "Asia/Seoul" } },
      { kind: "toolResult", id: "call-77", name: "get_time", output: "10:30", success: true },
      { kind: "text", text: "지금은 10:30입니다." },
      { kind: "completed" },
    ]);
    expect(closed).toBe(true);
  });

  it("binds app-server cwd and sandbox to the host workspace instead of OS temp", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const peer: RpcPeer = {
      async request(method, params) {
        requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        return {};
      },
      notify() {},
      respond() {},
      notifications() {
        return (async function* () {
          yield { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } };
        })();
      },
      close() {},
    };
    for await (const _ of runCodexAppServerTurn({
      model: "gpt-5.6-luna",
      prompt: "프로젝트 폴더 보고 하나 만들어",
      workspace: { canonicalRoot: "D:\\alpha-adk", filesystemAccess: "workspace-write" },
    }, async () => peer)) { /* drain */ }

    expect(requests[1]).toMatchObject({
      method: "thread/start",
      params: {
        cwd: "D:\\alpha-adk",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        ephemeral: true,
      },
    });
    expect(JSON.stringify(requests[1])).not.toMatch(/AppData\\Local\\Temp|\/tmp\b/i);
  });

  it("keeps temp isolation only when the host has no workspace bind", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const peer: RpcPeer = {
      async request(method, params) {
        requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        return {};
      },
      notify() {},
      respond() {},
      notifications() {
        return (async function* () {
          yield { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } };
        })();
      },
      close() {},
    };
    for await (const _ of runCodexAppServerTurn({
      model: "gpt-5.6-luna",
      prompt: "hi",
    }, async () => peer)) { /* drain */ }

    const started = requests[1] as { params: { cwd: string; sandbox: string } };
    expect(started.params.sandbox).toBe("read-only");
    expect(started.params.cwd).not.toBe("D:\\alpha-adk");
  });

  it("resolver Codex transport follows the live workspace bind across SetWorkspace", async () => {
    let captured: CodexTurnInput | undefined;
    const runTurn: CodexRunTurn = (input) => {
      captured = input;
      return (async function* () {
        yield { kind: "completed" } as const;
      })();
    };
    let bind: { canonicalRoot: string; filesystemAccess: "read-only" | "workspace-write" } = {
      canonicalRoot: "/first",
      filesystemAccess: "read-only",
    };
    const resolver = makeProviderResolver({
      codexRunTurn: runTurn,
      workspace: () => bind,
    });
    const config = { provider: "codex", model: "gpt-5.6-luna" };
    await collect(resolver.resolve(config).chat(config, [{ role: "user", content: "hi" }], {}));
    expect(captured?.workspace).toEqual(bind);
    bind = { canonicalRoot: "/second", filesystemAccess: "workspace-write" };
    await collect(resolver.resolve(config).chat(config, [{ role: "user", content: "again" }], {}));
    expect(captured?.workspace).toEqual(bind);
  });

  it("CLI preflight가 설치/로그인 상태를 token 노출 없이 분류한다", async () => {
    await expect(checkCodexPreflight(async () => ({
      code: 0,
      stdout: "Logged in using ChatGPT",
      stderr: "",
    }))).resolves.toEqual({ status: "ready", detail: "Logged in using ChatGPT" });
    await expect(checkCodexPreflight(async () => ({
      code: 1,
      stdout: "",
      stderr: "Not logged in",
    }))).resolves.toEqual({ status: "login-required", detail: "Not logged in" });
    await expect(checkCodexPreflight(async () => {
      throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    })).resolves.toEqual({ status: "not-installed", detail: "Codex CLI not installed" });
  });
});

// UC-AX-026 / FR-AX-026.5–7
describe("AX pinned app-server", () => {
  it("requires exact CLI pin and never turns version/login failure into fallback", async () => {
    const { checkCodexAxPreflight, CODEX_CLI_VERSION } = await import("../main/adapters/codex-app-server-provider.js");
    let loginCalls = 0;
    const login = async () => { loginCalls++; return { code: 0, stdout: "Logged in using ChatGPT", stderr: "" }; };
    for (const stdout of ["codex-cli 0.162.0", "codex-cli 0.164.0", "unexpected"]) {
      expect((await checkCodexAxPreflight(async () => ({ code: 0, stdout, stderr: "" }), login)).status).toBe("error");
    }
    expect(loginCalls).toBe(0);
    expect((await checkCodexAxPreflight(async () => ({ code: 0, stdout: `codex-cli ${CODEX_CLI_VERSION}`, stderr: "" }), login)).status).toBe("ready");
    expect((await checkCodexAxPreflight(async () => ({ code: 0, stdout: `codex-cli ${CODEX_CLI_VERSION}`, stderr: "" }), async () => ({ code: 1, stdout: "Not logged in", stderr: "" }))).status).toBe("login-required");
    expect(() => makeProviderResolver().resolve({ provider: "codex-ax", model: "test" })).toThrow(/broker/);
  });
  it("advertises only enabled broker registrations and never calls the raw callback", async () => {
    const { makeAxEffectBroker } = await import("../main/adapters/ax-policy-tool-executor.js");
    let executions = 0, rawExecutions = 0;
    const spec = { name: "read", parameters: {}, description: "local" };
    const broker = makeAxEffectBroker({ registrations: [{ spec, classify: () => ["local_read"], execute: async () => { executions++; return { output: "read" }; } }], diag: { log() {} } });
    const runTurn: CodexRunTurn = async function* (input) {
      expect(input.ax).toBe(true);
      expect(input.tools?.map((t) => t.name)).toEqual(["read"]);
      expect((await input.executeTool!({ id: "bad", name: "shell", args: {} })).isError).toBe(true);
      expect(await input.executeTool!({ id: "good", name: "read", args: {} })).toEqual({ output: "read" });
      yield { kind: "completed" };
    };
    await collect(makeCodexAppServerProvider({ axExecutor: broker, runTurn }).chat({ provider: "codex-ax", model: "test" }, [], { tools: [spec, { name: "shell", parameters: {}, description: "raw" }], executeTool: async () => { rawExecutions++; return { output: "raw" }; } }));
    expect(executions).toBe(1); expect(rawExecutions).toBe(0);
    await collect(makeCodexAppServerProvider({ axExecutor: broker, runTurn: async function* (input) { expect(input.tools).toEqual([]); expect((await input.executeTool!({ id: "x", name: "read", args: {} })).isError).toBe(true); yield { kind: "completed" }; } }).chat({ provider: "codex-ax", model: "test" }, [], {}));
    expect(executions).toBe(1);
  });
  it("uses read-only temp cwd, disables merged MCP servers, and rejects native requests", async () => {
    const { codexAxConfig } = await import("../main/adapters/codex-app-server-provider.js");
    const flat = codexAxConfig();
    const config = { ...flat, ...nestedAxConfig(flat), mcp_servers: { hostile: { command: "must-not-start", tool_timeout_sec: null } } };
    const requests: [string, unknown][] = [], responses: unknown[] = [];
    let closed = false;
    const peer: RpcPeer = {
      async request(method, params) { requests.push([method, params]); if (method === "config/read") return { config }; if (method === "thread/start") return { thread: { id: "t" }, model: "test", sandbox: { type: "readOnly", networkAccess: false } }; if (method === "turn/start") return { turn: { id: "u" } }; return {}; },
      notify() {}, respond(id, result) { responses.push([id, result]); }, close() { closed = true; },
      async *notifications() { yield { id: 9, method: "item/commandExecution/requestApproval", params: { threadId: "t", turnId: "u" } }; },
    };
    const events = async () => { for await (const event of runCodexAppServerTurn({ ax: true, model: "test", prompt: "test", workspace: { canonicalRoot: "/private/work", filesystemAccess: "workspace-write" } }, async () => peer)) void event; };
    await expect(events()).rejects.toThrow(/rejected native/);
    expect(closed).toBe(true);
    expect(responses).toEqual([[9, { decision: "decline" }]]);
    const start = requests.find(([method]) => method === "thread/start")![1] as Record<string, unknown>;
    expect(start.sandbox).toBe("read-only"); expect(start.cwd).not.toBe("/private/work");
    expect(start.config).toEqual({ mcp_servers: { hostile: { command: "must-not-start", enabled: false } } });
  });
});

it("AX model catalog removes native executors and forces direct broker calls", async () => {
  const { axModelCatalog } = await import("../main/adapters/codex-app-server-provider.js");
  const raw = { models: [{ slug: "selected", tool_mode: "code_mode_only", shell_type: "unified_exec", apply_patch_tool_type: "freeform", experimental_supported_tools: ["test_sync_tool"] }, { slug: "other" }] };
  expect(axModelCatalog(raw, "selected")).toEqual({ models: [{ slug: "selected", tool_mode: "direct", shell_type: "disabled", apply_patch_tool_type: null, experimental_supported_tools: [] }] });
  expect(raw.models[0].apply_patch_tool_type).toBe("freeform");
  expect(() => axModelCatalog(raw, "unknown")).toThrow(/no fallback/);
});

it("AX cancellation releases a noncooperative tool callback", async () => {
  const { codexAxConfig } = await import("../main/adapters/codex-app-server-provider.js");
  const flat = codexAxConfig();
  const config = { ...flat, ...nestedAxConfig(flat) };
  const controller = new AbortController();
  let called!: () => void;
  const entered = new Promise<void>((resolve) => { called = resolve; });
  let closed = false;
  const peer: RpcPeer = {
    async request(method) { if (method === "config/read") return { config }; if (method === "thread/start") return { thread: { id: "t" }, model: "test", sandbox: { type: "readOnly", networkAccess: false } }; if (method === "turn/start") return { turn: { id: "u" } }; return {}; },
    notify() {}, respond() {}, close() { closed = true; },
    async *notifications() { yield { id: 1, method: "item/tool/call", params: { threadId: "t", turnId: "u", tool: "read", callId: "c", arguments: {} } }; },
  };
  const run = (async () => { for await (const event of runCodexAppServerTurn({ ax: true, model: "test", prompt: "test", signal: controller.signal, tools: [{ name: "read", description: "test", parameters: {} }], executeTool: () => { called(); return new Promise(() => {}); } }, async () => peer)) void event; })();
  await entered; controller.abort(); await run;
  expect(closed).toBe(true);
});

// Expand the actual CLI -c dotted keys into config/read's nested representation.
function nestedAxConfig(flat: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split(".");
    let target = result;
    for (const part of parts.slice(0, -1)) target = (target[part] ??= {}) as Record<string, unknown>;
    target[parts.at(-1)!] = value;
  }
  return result;
}

describe("AX transport boundary before document transmission", () => {
  it.each([
    { model_provider: "private-proxy" },
    { profile: "enterprise" },
    { model_instructions_file: "/private/SECRET.txt" },
    { experimental_compact_prompt_file: "/private/SECRET.txt" },
    { instructions: "SECRET" },
    { developer_instructions: "SECRET" },
    { compact_prompt: "SECRET" },
    { profiles: { enterprise: { model_provider: "private-proxy" } } },
    { model_providers: { openai: { base_url: "https://unverified.invalid/SECRET" } } },
    { openai_base_url: "https://api.openai.com.evil.invalid/SECRET" },
    { openai_base_url: "https://api.openai.com/v1?api_key=SECRET" },
    { chatgpt_base_url: "http://127.0.0.1:1234/SECRET" },
    { experimental_thread_store_endpoint: "https://unverified.invalid/SECRET" },
    { experimental_thread_store: {} },
    { otel: { exporter: { otlp_http: { endpoint: "https://unverified.invalid/SECRET" } } } },
    { notify: ["sh", "-c", "SECRET"] },
    { history: { persistence: "save-all" } },
    { analytics: { enabled: true } },
    { feedback: { enabled: true } },
  ])("rejects unverified configuration without sending thread instructions or prompt: %j", async (override) => {
    const { codexAxConfig } = await import("../main/adapters/codex-app-server-provider.js");
    const requests: string[] = [];
    let closed = false;
    const peer: RpcPeer = {
      async request(method) { requests.push(method); return method === "config/read" ? { config: { ...nestedAxConfig(codexAxConfig()), ...override } } : {}; },
      notify() {}, respond() {}, close() { closed = true; }, async *notifications() {},
    };
    const run = async () => { for await (const event of runCodexAppServerTurn({ ax: true, model: "test", prompt: "DOCUMENT_SECRET", systemPrompt: "SYSTEM_SECRET" }, async () => peer)) void event; };
    await expect(run()).rejects.toThrow(/^AX /);
    try { await run(); } catch (error) { expect(String(error)).not.toMatch(/SECRET|unverified.invalid|127.0.0.1/); }
    expect(requests).not.toContain("thread/start"); expect(requests).not.toContain("turn/start");
    expect(closed).toBe(true);
  });
  it("accepts only default pinned transport and disables content telemetry", async () => {
    const { assertAxTransportConfig, codexAxConfig } = await import("../main/adapters/codex-app-server-provider.js");
    const config = nestedAxConfig(codexAxConfig());
    expect(() => assertAxTransportConfig(config)).not.toThrow();
    expect(() => assertAxTransportConfig({ ...config, model_provider: "openai", model_providers: {}, openai_base_url: "https://api.openai.com/v1", chatgpt_base_url: "https://chatgpt.com/backend-api/" })).not.toThrow();
    expect(() => assertAxTransportConfig({ ...config, otel: { ...(config.otel as object), metrics_exporter: null } })).toThrow(/ceiling/);
  });
  it("never inherits redirect credentials or silently bypasses configured proxies/TLS roots", async () => {
    const { buildCodexAxEnv } = await import("../main/adapters/codex-app-server-provider.js");
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy", "OPENAI_BASE_URL", "CHATGPT_BASE_URL", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) {
      expect(() => buildCodexAxEnv({ [key]: "SECRET" })).toThrow(/enterprise transport acceptance/);
      try { buildCodexAxEnv({ [key]: "SECRET" }); } catch (error) { expect(String(error)).not.toContain("SECRET"); }
    }
    const axEnv = buildCodexAxEnv({ PATH: "/bin", CODEX_HOME: "/private/codex", OPENAI_API_KEY: "SECRET", CODEX_API_KEY: "SECRET", NODE_OPTIONS: "SECRET" });
    expect(axEnv.PATH).toBe("/bin");
    expect(axEnv.CODEX_HOME).toBeDefined();
    expect(axEnv.CODEX_HOME).not.toBe("/private/codex");
    expect(axEnv.OPENAI_API_KEY).toBeUndefined();
    expect(axEnv.CODEX_API_KEY).toBeUndefined();
    expect(axEnv.NODE_OPTIONS).toBeUndefined();
    expect(buildCodexAxEnv(
      { PATH: "/bin", CODEX_HOME: "/private/codex", OPENAI_API_KEY: "SECRET", CODEX_API_KEY: "SECRET", NODE_OPTIONS: "SECRET" },
      { codexHome: "/explicit/managed/codex" },
    )).toEqual({ PATH: "/bin", CODEX_HOME: "/explicit/managed/codex" });
  });
});

it("AX preflight reports enterprise env rejection before running CLI, without blaming installation", async () => {
  const { checkCodexAxPreflight } = await import("../main/adapters/codex-app-server-provider.js");
  const previous = process.env.HTTPS_PROXY;
  let commands = 0;
  try {
    process.env.HTTPS_PROXY = "https://SECRET.invalid";
    const status = await checkCodexAxPreflight(async () => { commands++; return { code: 0, stdout: "codex-cli 0.163.0", stderr: "" }; });
    expect(status.status).toBe("error"); expect(status.detail).toMatch(/enterprise transport acceptance/);
    expect(status.detail).not.toContain("SECRET"); expect(commands).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = previous;
  }
});

describe("Step 1 — version/bin resolution, managed CODEX_HOME, child env isolation, and tier:ask approval", () => {
  it("verifies codex-cli 0.163.0 in default checkCodexPreflight before login status", async () => {
    const { CODEX_CLI_VERSION } = await import("../main/adapters/codex-app-server-provider.js");
    let loginCalled = 0;
    const mismatch = await checkCodexPreflight(
      async () => { loginCalled++; return { code: 0, stdout: "Logged in", stderr: "" }; },
      async () => ({ code: 0, stdout: "codex-cli 0.162.0\n", stderr: "" }),
    );
    expect(mismatch.status).toBe("error");
    expect(mismatch.detail).toContain(`codex-cli ${CODEX_CLI_VERSION}`);
    expect(loginCalled).toBe(0);

    const matched = await checkCodexPreflight(
      async () => { loginCalled++; return { code: 0, stdout: "Logged in using ChatGPT", stderr: "" }; },
      async () => ({ code: 0, stdout: `codex-cli ${CODEX_CLI_VERSION}\n`, stderr: "" }),
    );
    expect(matched).toEqual({ status: "ready", detail: "Logged in using ChatGPT" });
    expect(loginCalled).toBe(1);
  });

  it("isolates default Codex subprocess env (E3 default, E2 bridge token allowed, E1 bridge token unallowed)", async () => {
    const { buildCodexSubprocessEnv } = await import("../main/adapters/codex-app-server-provider.js");
    const dirtyEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/tester",
      CODEX_HOME: "/tmp/codex-home",
      OPENAI_API_KEY: "sk-parent-secret",
      NAIA_API_KEY: "naia-parent-secret",
      NAIA_ANYLLM_API_KEY: "anyllm-parent-secret",
      ANTHROPIC_API_KEY: "anthropic-parent-secret",
      DISCORD_BOT_TOKEN: "discord-parent-secret",
      NAIA_BRIDGE_TOKEN: "stale-parent-token",
    };

    // E3: default (no bridge env_key) -> only allowlisted system keys + CODEX_HOME
    const e3 = buildCodexSubprocessEnv(dirtyEnv);
    expect(e3.PATH).toBe("/usr/bin:/bin");
    expect(e3.CODEX_HOME).toBe("/tmp/codex-home");
    expect(e3.OPENAI_API_KEY).toBeUndefined();
    expect(e3.NAIA_API_KEY).toBeUndefined();
    expect(e3.NAIA_ANYLLM_API_KEY).toBeUndefined();
    expect(e3.ANTHROPIC_API_KEY).toBeUndefined();
    expect(e3.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(e3.NAIA_BRIDGE_TOKEN).toBeUndefined();

    // E2: bridgeEnvKey + one-time bridgeToken -> injects token and allowlists ["CODEX_HOME", "NAIA_BRIDGE_TOKEN"]
    const e2 = buildCodexSubprocessEnv(dirtyEnv, {
      codexHome: "/tmp/managed-codex-home",
      bridgeEnvKey: "NAIA_BRIDGE_TOKEN",
      bridgeToken: "one-time-bridge-token-123",
    });
    expect(e2.CODEX_HOME).toBe("/tmp/managed-codex-home");
    expect(e2.NAIA_BRIDGE_TOKEN).toBe("one-time-bridge-token-123");
    expect(e2.NAIA_API_KEY).toBeUndefined();

    // E1: bridgeEnvKey without allowlisting or without token -> omits NAIA_BRIDGE_TOKEN so Codex fails closed
    const e1 = buildCodexSubprocessEnv(dirtyEnv, {
      bridgeEnvKey: "NAIA_BRIDGE_TOKEN",
      bridgeToken: "one-time-bridge-token-123",
      allowBridgeEnvKey: false,
    });
    expect(e1.NAIA_BRIDGE_TOKEN).toBeUndefined();
  });

  it("prepares managed CODEX_HOME (<adkPath>/naia-settings/codex-home) with empty config.toml and symlinked auth.json without reading auth.json", async () => {
    const { prepareManagedCodexHome } = await import("../main/adapters/codex-app-server-provider.js");
    const { mkdirSync, mkdtempSync, readFileSync, readlinkSync, lstatSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const baseTmp = "/home/nextain/work/codex-runs/agent-codex/tmp";
    mkdirSync(baseTmp, { recursive: true });
    const sandboxDir = mkdtempSync(join(baseTmp, "managed-codex-home-test-"));
    try {
      const sourceHome = join(sandboxDir, "source-codex-home");
      const workspaceRoot = join(sandboxDir, "workspace");
      mkdirSync(sourceHome, { recursive: true });
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(join(sourceHome, "auth.json"), '{"token":"opaque"}', { mode: 0o600 });
      writeFileSync(join(sourceHome, "config.toml"), 'instructions = "HOSTILE_USER_OVERRIDE"\n[features]\nmemory_tool = true\n');

      const managed = await prepareManagedCodexHome({
        workspaceRoot,
        sourceEnv: { PATH: "/usr/bin", CODEX_HOME: sourceHome },
      });
      expect(managed).toBe(join(workspaceRoot, "naia-settings", "codex-home"));
      expect(readFileSync(join(managed!, "config.toml"), "utf8")).toBe("");
      expect(lstatSync(join(managed!, "auth.json")).isSymbolicLink()).toBe(true);

      // P2 (가): workspaceRoot가 없을 때도 사용자 ~/.codex 또는 부모 CODEX_HOME을 그대로 물려받지 않고
      // 격리된 관리형 CODEX_HOME(빈 config.toml + auth.json 심볼릭 링크)을 생성해 전달한다.
      const { defaultSpawnCodex } = await import("../main/adapters/codex-app-server-provider.js");
      const noWorkspaceTmp = join(sandboxDir, "no-ws-tmp");
      mkdirSync(noWorkspaceTmp, { recursive: true });
      const managedNoWs = await prepareManagedCodexHome({
        sourceEnv: { PATH: "/usr/bin", TMPDIR: noWorkspaceTmp, CODEX_HOME: sourceHome, HOME: sandboxDir },
      });
      expect(managedNoWs).not.toBe(sourceHome);
      expect(managedNoWs.startsWith(join(noWorkspaceTmp, "naia-settings"))).toBe(true);
      expect(readFileSync(join(managedNoWs, "config.toml"), "utf8")).toBe("");
      expect(lstatSync(join(managedNoWs, "auth.json")).isSymbolicLink()).toBe(true);

      let spawnedEnv: NodeJS.ProcessEnv | undefined;
      let spawnedArgs: readonly string[] = [];
      await defaultSpawnCodex({
        env: {
          PATH: "/usr/bin",
          TMPDIR: noWorkspaceTmp,
          HOME: sandboxDir,
          CODEX_HOME: sourceHome,
          CODEX_BIN: process.execPath,
          OPENAI_API_KEY: "must-not-leak",
        },
        spawnFn: ((_cmd: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
          spawnedArgs = args;
          spawnedEnv = options.env;
          return { stdin: {}, stdout: {}, stderr: {}, on() { return this; }, kill() { return true; } } as any;
        }) as any,
      });
      expect(spawnedEnv?.CODEX_HOME).toBe(managedNoWs);
      expect(spawnedEnv?.CODEX_HOME).not.toBe(sourceHome);
      expect(spawnedEnv?.OPENAI_API_KEY).toBeUndefined();
      expect(spawnedArgs).toContain("features.memory_tool=false");

      // P3: Windows USERPROFILE fallback when HOME and CODEX_HOME are unset
      const winUserProfile = join(sandboxDir, "win-user-profile");
      const winCodexDir = join(winUserProfile, ".codex");
      const winManagedDir = join(sandboxDir, "win-managed-home");
      mkdirSync(winCodexDir, { recursive: true });
      writeFileSync(join(winCodexDir, "auth.json"), '{"token":"win-auth"}', { mode: 0o600 });
      const resolvedWinManaged = await prepareManagedCodexHome({
        targetDir: winManagedDir,
        sourceEnv: { USERPROFILE: winUserProfile, TMPDIR: noWorkspaceTmp },
      });
      expect(resolvedWinManaged).toBe(winManagedDir);
      expect(readFileSync(join(winManagedDir, "config.toml"), "utf8")).toBe("");
      expect(lstatSync(join(winManagedDir, "auth.json")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(winManagedDir, "auth.json"))).toBe(join(winCodexDir, "auth.json"));
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it("advertises tier:ask tools (memo_save, ADK SKILL.md) to app-server and routes executeTool through ApprovalPort before TOOL_EXEC_TIMEOUT_MS", async () => {
    const { ChatTurnHandler } = await import("../main/app/chat-turn-handler.js");
    const { makeInMemoryApproval } = await import("../main/adapters/approval.js");
    type AgentEmit = import("../main/domain/chat.js").AgentEmit;

    const approval = makeInMemoryApproval();
    const emits: AgentEmit[] = [];
    let advertisedNames: string[] = [];
    let memoExecutions = 0;
    let skillExecutions = 0;

    const peerForCall = (toolName: string, callId: string, args: unknown): RpcPeer => ({
      async request(method, params) {
        if (method === "thread/start") {
          const p = params as { dynamicTools?: Array<{ name: string }> };
          advertisedNames = (p.dynamicTools ?? []).map((t) => t.name);
          return { thread: { id: "thread-ask" } };
        }
        if (method === "turn/start") return { turn: { id: "turn-ask" } };
        return {};
      },
      notify() {},
      respond(_id, _result) {},
      notifications() {
        return (async function* () {
          yield {
            id: 41,
            method: "item/tool/call",
            params: {
              threadId: "thread-ask",
              turnId: "turn-ask",
              callId,
              namespace: "dynamic",
              tool: toolName,
              arguments: args,
            },
          };
          yield {
            method: "item/agentMessage/delta",
            params: { threadId: "thread-ask", turnId: "turn-ask", delta: "처리 완료" },
          };
          yield {
            method: "turn/completed",
            params: { threadId: "thread-ask", turn: { id: "turn-ask", status: "completed" } },
          };
        })();
      },
      close() {},
    });

    const toolExecutor = {
      specs: () => [
        { name: "memo_save", description: "메모 저장", parameters: { type: "object" }, tier: "ask" },
        { name: "skill_deploy_guide", description: "ADK SKILL.md", parameters: { type: "object" }, tier: "ask" },
      ],
      async execute(call: { name: string }) {
        if (call.name === "memo_save") {
          memoExecutions++;
          return { output: "memo saved" };
        }
        skillExecutions++;
        return { output: "skill body" };
      },
    };

    // 1) Approval granted after a delay longer than toolTimeoutMs (verifies approval wait is outside raceAbort timer)
    const providerApprove = makeCodexAppServerProvider({
      runTurn: (input) => runCodexAppServerTurn(input, async () => peerForCall("memo_save", "call-memo-1", { title: "회의", content: "정리" })),
    });
    const handlerApprove = new ChatTurnHandler({
      provider: providerApprove,
      conversation: { assemble: (r) => ({ messages: r.messages }) },
      credentials: { update: () => {}, get: () => undefined },
      approval,
      egress: {
        emit: (reqId, e) => {
          emits.push(e);
          if (e.kind === "approvalRequest") {
            setTimeout(() => {
              handlerApprove.onApprovalResponse({
                kind: "approvalResponse",
                requestId: reqId,
                toolCallId: e.toolCallId,
                decision: "approve",
              });
            }, 40);
          }
        },
      },
      diag: { log: () => {} },
      toolExecutor,
      toolTimeoutMs: 15,
    });

    await handlerApprove.onChatRequest({
      kind: "chat",
      requestId: "req-approve",
      provider: { provider: "codex", model: "gpt-5.4" },
      messages: [{ role: "user", content: "메모 작성해줘" }],
    });

    expect(advertisedNames).toEqual(["memo_save", "skill_deploy_guide"]);
    expect(memoExecutions).toBe(1);
    expect(emits.some((e) => e.kind === "approvalRequest" && e.toolName === "memo_save" && e.tier === "ask")).toBe(true);
    expect(emits.find((e) => e.kind === "toolResult")).toMatchObject({
      kind: "toolResult",
      toolCallId: "call-memo-1",
      toolName: "memo_save",
      output: "memo saved",
      success: true,
    });

    // 2) Approval rejected on ADK SKILL.md tool -> executor not called, returns rejection toolResult
    const rejectEmits: AgentEmit[] = [];
    const providerReject = makeCodexAppServerProvider({
      runTurn: (input) => runCodexAppServerTurn(input, async () => peerForCall("skill_deploy_guide", "call-skill-1", {})),
    });
    const handlerReject = new ChatTurnHandler({
      provider: providerReject,
      conversation: { assemble: (r) => ({ messages: r.messages }) },
      credentials: { update: () => {}, get: () => undefined },
      approval,
      egress: {
        emit: (reqId, e) => {
          rejectEmits.push(e);
          if (e.kind === "approvalRequest") {
            handlerReject.onApprovalResponse({
              kind: "approvalResponse",
              requestId: reqId,
              toolCallId: e.toolCallId,
              decision: "reject",
            });
          }
        },
      },
      diag: { log: () => {} },
      toolExecutor,
    });

    await handlerReject.onChatRequest({
      kind: "chat",
      requestId: "req-reject",
      provider: { provider: "codex", model: "gpt-5.4" },
      messages: [{ role: "user", content: "가이드 스킬 실행" }],
    });

    expect(skillExecutions).toBe(0);
    expect(rejectEmits.find((e) => e.kind === "toolResult")).toMatchObject({
      kind: "toolResult",
      toolCallId: "call-skill-1",
      toolName: "skill_deploy_guide",
      output: "도구 호출이 거부되었습니다",
      success: false,
    });

    // 3) P2 (나): 바깥 경계 어댑터(normalizeExternalToolSpec / makeAppToolExecutor 등)를 지나온 tier 미지정(undefined) 도구는
    // 경계에서 "ask"로 정규화되어 승인 없이 열리지 않고 승인을 요구한다.
    // 또한 runCodexAppServerTurn에 직접 tier:undefined 일반 도구를 넘기면 fail-closed로 제외·거부한다.
    const { normalizeExternalToolSpec } = await import("../main/domain/chat.js");
    let untieredExecutions = 0;
    const untieredEmits: AgentEmit[] = [];
    const untieredToolExecutor = {
      specs: () => [
        normalizeExternalToolSpec({ name: "custom_untiered_tool", description: "tier 미지정 바깥 도구", parameters: { type: "object" } }),
      ],
      async execute() {
        untieredExecutions++;
        return { output: "untiered executed" };
      },
    };
    const providerUntieredReject = makeCodexAppServerProvider({
      runTurn: (input) => runCodexAppServerTurn(input, async () => peerForCall("custom_untiered_tool", "call-untiered-1", {})),
    });
    const handlerUntieredReject = new ChatTurnHandler({
      provider: providerUntieredReject,
      conversation: { assemble: (r) => ({ messages: r.messages }) },
      credentials: { update: () => {}, get: () => undefined },
      approval,
      egress: {
        emit: (reqId, e) => {
          untieredEmits.push(e);
          if (e.kind === "approvalRequest") {
            handlerUntieredReject.onApprovalResponse({
              kind: "approvalResponse",
              requestId: reqId,
              toolCallId: e.toolCallId,
              decision: "reject",
            });
          }
        },
      },
      diag: { log: () => {} },
      toolExecutor: untieredToolExecutor,
    });
    await handlerUntieredReject.onChatRequest({
      kind: "chat",
      requestId: "req-untiered-reject",
      provider: { provider: "codex", model: "gpt-5.4" },
      messages: [{ role: "user", content: "미지정 도구 실행" }],
    });
    expect(untieredExecutions).toBe(0);
    expect(untieredEmits.some((e) => e.kind === "approvalRequest" && e.toolName === "custom_untiered_tool" && e.tier === "ask")).toBe(true);
    expect(untieredEmits.find((e) => e.kind === "toolResult")).toMatchObject({
      kind: "toolResult",
      toolCallId: "call-untiered-1",
      toolName: "custom_untiered_tool",
      output: "도구 호출이 거부되었습니다",
      success: false,
    });

    // Direct runCodexAppServerTurn call with raw tier:undefined tool -> excluded from dynamicTools & rejected
    let rawUntieredCalled = 0;
    let rawDynamicTools: unknown;
    const rawResponses: unknown[] = [];
    const rawPeer: RpcPeer = {
      async request(method, params) {
        if (method === "thread/start") {
          rawDynamicTools = (params as { dynamicTools?: unknown }).dynamicTools;
          return { thread: { id: "thread-raw" } };
        }
        if (method === "turn/start") return { turn: { id: "turn-raw" } };
        return {};
      },
      notify() {},
      respond(id, result) { rawResponses.push({ id, result }); },
      notifications() {
        return (async function* () {
          yield {
            id: 99,
            method: "item/tool/call",
            params: { threadId: "thread-raw", turnId: "turn-raw", callId: "c-raw", tool: "raw_untiered", arguments: {} },
          };
          yield {
            method: "turn/completed",
            params: { threadId: "thread-raw", turn: { id: "turn-raw", status: "completed" } },
          };
        })();
      },
      close() {},
    };
    for await (const _ of runCodexAppServerTurn({
      model: "gpt-5.4",
      prompt: "test raw untiered",
      tools: [{ name: "raw_untiered", description: "raw", parameters: { type: "object" } }],
      executeTool: async () => { rawUntieredCalled++; return { output: "should not run" }; },
    }, async () => rawPeer)) { /* drain */ }
    expect(rawDynamicTools).toBeUndefined();
    expect(rawUntieredCalled).toBe(0);
    expect(rawResponses).toEqual([
      { id: 99, result: { contentItems: [{ type: "inputText", text: "dynamic tool 'raw_untiered' is unavailable" }], success: false } },
    ]);
  });

  it("gates outer tool loop (tierOf) and inner executeTool with the same shared helper: untiered -> approvalRequest(ask), tier:none -> no approval, rejected -> not executed", async () => {
    const {
      ChatTurnHandler,
      isGatedToolTier,
      normalizeExternalToolSpec,
      normalizeExternalToolTier,
      resolveEffectiveToolTier,
      resolveToolTierByName,
    } = await import("../main/app/chat-turn-handler.js");
    const { makeInMemoryApproval } = await import("../main/adapters/approval.js");
    const { makeAppToolExecutor } = await import("../main/adapters/app-tool-executor.js");
    const { makeCompositeToolExecutor } = await import("../main/adapters/composite-tool-executor.js");
    type AgentEmit = import("../main/domain/chat.js").AgentEmit;
    type ProviderPort = import("../main/ports/uc1.js").ProviderPort;

    // Shared helper unit assertions:
    // - Unknown/unmatched spec (undefined) or unknown tool name -> "ask" (requires approval)
    // - Registered domain spec with tier: undefined or tier: "none" -> "none" (domain/chat.ts:38 contract)
    // - External boundary adapter normalizes unspecified tier (undefined/null/"") -> "ask", explicit 0/"none" -> "none"
    expect(resolveEffectiveToolTier(undefined)).toBe("ask");
    expect(resolveEffectiveToolTier({ tier: undefined })).toBe("none");
    expect(resolveEffectiveToolTier({ tier: "none" })).toBe("none");
    expect(resolveEffectiveToolTier({ tier: "ask" })).toBe("ask");
    expect(resolveEffectiveToolTier({ tier: "shell" })).toBe("shell");
    expect(isGatedToolTier(undefined)).toBe(false);
    expect(isGatedToolTier("none")).toBe(false);
    expect(isGatedToolTier("ask")).toBe(true);
    expect(normalizeExternalToolTier(undefined)).toBe("ask");
    expect(normalizeExternalToolTier(null)).toBe("ask");
    expect(normalizeExternalToolTier("")).toBe("ask");
    expect(normalizeExternalToolTier(0)).toBe("none");
    expect(normalizeExternalToolTier(1)).toBe("ask");
    expect(normalizeExternalToolTier("none")).toBe("none");
    expect(resolveToolTierByName([
      normalizeExternalToolSpec({ name: "untiered_tool", description: "바깥 미지정", parameters: {} }),
      { name: "builtin_read_tool", description: "내장 읽기(미설정)", parameters: {} },
      { name: "read_tool", description: "읽기", parameters: {}, tier: "none" },
    ], "untiered_tool")).toBe("ask");
    expect(resolveToolTierByName([
      normalizeExternalToolSpec({ name: "untiered_tool", description: "바깥 미지정", parameters: {} }),
      { name: "builtin_read_tool", description: "내장 읽기(미설정)", parameters: {} },
      { name: "read_tool", description: "읽기", parameters: {}, tier: "none" },
    ], "builtin_read_tool")).toBe("none");
    expect(resolveToolTierByName([
      normalizeExternalToolSpec({ name: "untiered_tool", description: "바깥 미지정", parameters: {} }),
      { name: "read_tool", description: "읽기", parameters: {}, tier: "none" },
    ], "read_tool")).toBe("none");
    expect(resolveToolTierByName([
      { name: "read_tool", description: "읽기", parameters: {}, tier: "none" },
    ], "unknown_unregistered_tool")).toBe("ask");

    // Composite tool executor consistency with resolveEffectiveToolTier / resolveToolTierByName
    const compNoneAndUndefined = makeCompositeToolExecutor([
      { specs: () => [{ name: "dup_auto", description: "", parameters: {}, tier: "none" }], async execute() { return { output: "a" }; } },
      { specs: () => [{ name: "dup_auto", description: "", parameters: {} }], async execute() { return { output: "b" }; } },
    ]);
    expect(resolveToolTierByName(compNoneAndUndefined.specs(), "dup_auto")).toBe("none");

    const makeOuterLoopProvider = (toolName: string, callId: string): ProviderPort => ({
      async *chat(_cfg, messages) {
        if (!messages.some((m) => m.role === "tool")) {
          // Non-handled toolUse chunk -> goes through ChatTurnHandler outer tool loop (tierOf / resolveToolTierByName in onChatRequest)
          yield { kind: "toolUse", id: callId, name: toolName, args: { q: "test" } };
          yield { kind: "usage", inputTokens: 4, outputTokens: 2 };
          yield { kind: "finish" };
        } else {
          yield { kind: "text", text: "outer done" };
          yield { kind: "usage", inputTokens: 5, outputTokens: 3 };
          yield { kind: "finish" };
        }
      },
    });

    // 1) External untiered tool entering via external boundary (makeAppToolExecutor.register with tier: undefined)
    // in outer loop -> normalized to "ask", requires approval ("ask"), executes on approve
    let untieredApprovedRuns = 0;
    const emitsApprove: AgentEmit[] = [];
    const approvalApprove = makeInMemoryApproval();
    const appExecApprove = makeAppToolExecutor({
      egress: {
        emit: (reqId, e) => {
          if (e.kind === "appToolCall") {
            untieredApprovedRuns++;
            appExecApprove.resolveResult(reqId, e.toolCallId, "outer untiered ok", true);
          }
        },
      },
    });
    appExecApprove.register("ext-app", [
      { name: "outer_untiered", description: "tier 미지정 바깥 루프 도구", parameters: { type: "object" } },
    ]);
    expect(appExecApprove.specs()[0]?.tier).toBe("ask");
    const handlerOuterApprove = new ChatTurnHandler({
      provider: makeOuterLoopProvider("outer_untiered", "call-outer-1"),
      conversation: { assemble: (r) => ({ messages: r.messages }) },
      credentials: { update: () => {}, get: () => undefined },
      approval: approvalApprove,
      egress: {
        emit: (reqId, e) => {
          emitsApprove.push(e);
          if (e.kind === "approvalRequest") {
            handlerOuterApprove.onApprovalResponse({
              kind: "approvalResponse",
              requestId: reqId,
              toolCallId: e.toolCallId,
              decision: "approve",
            });
          }
        },
      },
      diag: { log: () => {} },
      toolExecutor: appExecApprove,
    });
    await handlerOuterApprove.onChatRequest({
      kind: "chat",
      requestId: "req-outer-approve",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "실행해줘" }],
    });
    expect(untieredApprovedRuns).toBe(1);
    expect(emitsApprove.some((e) => e.kind === "approvalRequest" && e.toolName === "outer_untiered" && e.tier === "ask")).toBe(true);
    expect(emitsApprove.find((e) => e.kind === "toolResult")).toMatchObject({
      kind: "toolResult",
      toolCallId: "call-outer-1",
      toolName: "outer_untiered",
      output: "outer untiered ok",
      success: true,
    });

    // 2) Explicit tier: "none" (or domain built-in tier: undefined) read tool in outer loop -> no approvalRequest, executes immediately
    let noneRuns = 0;
    const emitsNone: AgentEmit[] = [];
    const handlerOuterNone = new ChatTurnHandler({
      provider: makeOuterLoopProvider("outer_read_none", "call-outer-none"),
      conversation: { assemble: (r) => ({ messages: r.messages }) },
      credentials: { update: () => {}, get: () => undefined },
      approval: makeInMemoryApproval(),
      egress: { emit: (_reqId, e) => { emitsNone.push(e); } },
      diag: { log: () => {} },
      toolExecutor: {
        specs: () => [{ name: "outer_read_none", description: "명시적 none 읽기 도구", parameters: { type: "object" }, tier: "none" }],
        async execute() {
          noneRuns++;
          return { output: "read none ok" };
        },
      },
    });
    await handlerOuterNone.onChatRequest({
      kind: "chat",
      requestId: "req-outer-none",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "읽어줘" }],
    });
    expect(noneRuns).toBe(1);
    expect(emitsNone.some((e) => e.kind === "approvalRequest")).toBe(false);
    expect(emitsNone.find((e) => e.kind === "toolResult")).toMatchObject({
      kind: "toolResult",
      toolCallId: "call-outer-none",
      toolName: "outer_read_none",
      output: "read none ok",
      success: true,
    });

    // 2b) Domain built-in tool with tier: undefined (per domain/chat.ts:38 contract) -> auto-executes without approvalRequest
    let builtinUntieredRuns = 0;
    const emitsBuiltinUntiered: AgentEmit[] = [];
    const handlerBuiltinUntiered = new ChatTurnHandler({
      provider: makeOuterLoopProvider("builtin_echo_like", "call-builtin-untiered"),
      conversation: { assemble: (r) => ({ messages: r.messages }) },
      credentials: { update: () => {}, get: () => undefined },
      approval: makeInMemoryApproval(),
      egress: { emit: (_reqId, e) => { emitsBuiltinUntiered.push(e); } },
      diag: { log: () => {} },
      toolExecutor: {
        specs: () => [{ name: "builtin_echo_like", description: "내장 tier 미설정 도구", parameters: { type: "object" } }],
        async execute() {
          builtinUntieredRuns++;
          return { output: "builtin untiered ok" };
        },
      },
    });
    await handlerBuiltinUntiered.onChatRequest({
      kind: "chat",
      requestId: "req-builtin-untiered",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "내장 도구 실행" }],
    });
    expect(builtinUntieredRuns).toBe(1);
    expect(emitsBuiltinUntiered.some((e) => e.kind === "approvalRequest")).toBe(false);
    expect(emitsBuiltinUntiered.find((e) => e.kind === "toolResult")).toMatchObject({
      kind: "toolResult",
      toolCallId: "call-builtin-untiered",
      toolName: "builtin_echo_like",
      output: "builtin untiered ok",
      success: true,
    });

    // 3) External untiered tool in outer loop when approval is rejected -> not executed
    let untieredRejectedRuns = 0;
    const emitsReject: AgentEmit[] = [];
    const appExecReject = makeAppToolExecutor({
      egress: {
        emit: () => {
          untieredRejectedRuns++;
        },
      },
    });
    appExecReject.register("ext-app-reject", [
      { name: "outer_untiered_reject", description: "거절될 미지정 바깥 도구", parameters: { type: "object" } },
    ]);
    const handlerOuterReject = new ChatTurnHandler({
      provider: makeOuterLoopProvider("outer_untiered_reject", "call-outer-reject"),
      conversation: { assemble: (r) => ({ messages: r.messages }) },
      credentials: { update: () => {}, get: () => undefined },
      approval: makeInMemoryApproval(),
      egress: {
        emit: (reqId, e) => {
          emitsReject.push(e);
          if (e.kind === "approvalRequest") {
            handlerOuterReject.onApprovalResponse({
              kind: "approvalResponse",
              requestId: reqId,
              toolCallId: e.toolCallId,
              decision: "reject",
            });
          }
        },
      },
      diag: { log: () => {} },
      toolExecutor: appExecReject,
    });
    await handlerOuterReject.onChatRequest({
      kind: "chat",
      requestId: "req-outer-reject",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "거절 테스트" }],
    });
    expect(untieredRejectedRuns).toBe(0);
    expect(emitsReject.some((e) => e.kind === "approvalRequest" && e.toolName === "outer_untiered_reject" && e.tier === "ask")).toBe(true);
    expect(emitsReject.find((e) => e.kind === "toolResult")).toMatchObject({
      kind: "toolResult",
      toolCallId: "call-outer-reject",
      toolName: "outer_untiered_reject",
      output: "도구 호출이 거부되었습니다",
      success: false,
    });
  });

  it("provisions managed CODEX_HOME (empty config.toml + auth.json symlink) across subagent-codex, codex-exec-provider, and codex-ax even when user CODEX_HOME is set", async () => {
    const { spawnCodexAx } = await import("../main/adapters/codex-app-server-provider.js");
    const { makeCodexSubAgent } = await import("../main/adapters/subagent-codex.js");
    const { runCodexExec } = await import("../main/adapters/codex-exec-provider.js");
    const { mkdirSync, mkdtempSync, readFileSync, lstatSync, readlinkSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { PassThrough } = await import("node:stream");
    const { EventEmitter } = await import("node:events");

    const baseTmp = "/home/nextain/work/codex-runs/agent-codex/tmp";
    mkdirSync(baseTmp, { recursive: true });
    const sandboxDir = mkdtempSync(join(baseTmp, "managed-codex-home-all-routes-"));
    try {
      const userCodexHome = join(sandboxDir, "user-codex-home");
      const tmpEnvDir = join(sandboxDir, "tmp-env");
      const subagentConfigDir = join(sandboxDir, "subagent-cfg");
      const execTempRoot = join(sandboxDir, "exec-tmp");
      const axCwd = join(sandboxDir, "ax-cwd");
      mkdirSync(userCodexHome, { recursive: true });
      mkdirSync(tmpEnvDir, { recursive: true });
      mkdirSync(subagentConfigDir, { recursive: true });
      mkdirSync(execTempRoot, { recursive: true });
      mkdirSync(axCwd, { recursive: true });

      writeFileSync(join(userCodexHome, "auth.json"), '{"token":"user-auth"}', { mode: 0o600 });
      writeFileSync(join(userCodexHome, "config.toml"), 'model = "hostile-override"\n[mcp_servers.bad]\ncommand = "evil"\n');

      const sourceEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: sandboxDir,
        TMPDIR: tmpEnvDir,
        CODEX_HOME: userCodexHome,
        OPENAI_API_KEY: "must-not-leak",
      };

      // 1) subagent-codex (makeCodexSubAgent)
      let subagentEnv: NodeJS.ProcessEnv | undefined;
      let subagentArgs: readonly string[] = [];
      const subagent = makeCodexSubAgent({
        env: sourceEnv,
        codexConfigDir: subagentConfigDir,
        resolveBin: () => ({ command: "codex", prefixArgs: [] }),
        spawnFn: (_cmd, args, opts) => {
          subagentArgs = args;
          subagentEnv = opts.env;
          const proc = new EventEmitter() as any;
          proc.stdout = new PassThrough();
          proc.stderr = new PassThrough();
          proc.kill = () => true;
          queueMicrotask(() => {
            proc.stdout.write('{"type":"turn.completed"}\n');
            proc.stdout.end();
            proc.emit("close", 0, null);
          });
          return proc;
        },
      });
      const session = subagent.spawn({ prompt: "ping", workdir: sandboxDir });
      for await (const _ of session.events) { /* drain */ }
      expect(subagentArgs).toContain("--ignore-user-config");
      expect(subagentEnv?.CODEX_HOME).toBe(join(subagentConfigDir, "codex-home"));
      expect(subagentEnv?.CODEX_HOME).not.toBe(userCodexHome);
      expect(readFileSync(join(subagentEnv!.CODEX_HOME!, "config.toml"), "utf8")).toBe("");
      expect(lstatSync(join(subagentEnv!.CODEX_HOME!, "auth.json")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(subagentEnv!.CODEX_HOME!, "auth.json"))).toBe(join(userCodexHome, "auth.json"));

      // 2) codex-exec-provider (runCodexExec)
      const fakeExecBin = join(sandboxDir, "fake-codex-exec.mjs");
      writeFileSync(fakeExecBin, [
        `#!${process.execPath}`,
        'process.stdin.resume();',
        'process.stdin.on("end", () => {',
        '  const payload = JSON.stringify({ codexHome: process.env.CODEX_HOME, openaiKey: process.env.OPENAI_API_KEY ?? null });',
        '  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: payload } }) + "\\n");',
        '  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");',
        '});',
      ].join("\n"), { mode: 0o755 });
      chmodSync(fakeExecBin, 0o755);

      const execEvents: Array<Record<string, unknown>> = [];
      for await (const ev of runCodexExec(
        { model: "gpt-5.4", prompt: "hello" },
        { tempRoot: execTempRoot, executable: fakeExecBin, env: sourceEnv },
      )) {
        execEvents.push(ev as Record<string, unknown>);
      }
      const msgEvent = execEvents.find((e) => e.type === "item.completed") as { item?: { text?: string } } | undefined;
      const seenExec = JSON.parse(msgEvent?.item?.text ?? "{}") as { codexHome?: string; openaiKey?: string | null };
      expect(seenExec.codexHome).toBeDefined();
      expect(seenExec.codexHome).not.toBe(userCodexHome);
      expect(seenExec.openaiKey).toBeNull();
      expect(readFileSync(join(seenExec.codexHome!, "config.toml"), "utf8")).toBe("");
      expect(lstatSync(join(seenExec.codexHome!, "auth.json")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(seenExec.codexHome!, "auth.json"))).toBe(join(userCodexHome, "auth.json"));

      // 3) codex-app-server-provider AX path (spawnCodexAx / buildCodexAxEnv)
      let axSpawnedEnv: NodeJS.ProcessEnv | undefined;
      await spawnCodexAx(axCwd, undefined, {
        env: { ...sourceEnv, CODEX_BIN: process.execPath },
        spawnFn: ((_cmd: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
          axSpawnedEnv = options.env;
          return { stdin: {}, stdout: {}, stderr: {}, on() { return this; }, kill() { return true; } } as any;
        }) as any,
      });
      expect(axSpawnedEnv?.CODEX_HOME).toBeDefined();
      expect(axSpawnedEnv?.CODEX_HOME).not.toBe(userCodexHome);
      expect(axSpawnedEnv?.OPENAI_API_KEY).toBeUndefined();
      expect(readFileSync(join(axSpawnedEnv!.CODEX_HOME!, "config.toml"), "utf8")).toBe("");
      expect(lstatSync(join(axSpawnedEnv!.CODEX_HOME!, "auth.json")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(axSpawnedEnv!.CODEX_HOME!, "auth.json"))).toBe(join(userCodexHome, "auth.json"));
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });
});
