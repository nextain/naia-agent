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
    expect(buildCodexAxEnv({ PATH: "/bin", CODEX_HOME: "/private/codex", OPENAI_API_KEY: "SECRET", CODEX_API_KEY: "SECRET", NODE_OPTIONS: "SECRET" })).toEqual({ PATH: "/bin", CODEX_HOME: "/private/codex" });
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
    const { mkdirSync, mkdtempSync, readFileSync, lstatSync, writeFileSync, rmSync } = await import("node:fs");
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
  });
});
