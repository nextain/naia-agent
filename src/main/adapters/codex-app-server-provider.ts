// adapters/codex-app-server-provider — Codex app-server 기반 ProviderPort.
//
// `codex` provider는 OpenAI API-key provider가 아니다. 사용자의 로컬 Codex 로그인과
// `codex app-server`를 사용하며 auth.json/token을 읽거나 복사하지 않는다.
// app-server JSONL 프로토콜은 이 파일 안에 격리하고 ProviderPort에는 정규화 chunk만 노출한다.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { buildIsolatedSubprocessEnv } from "./subprocess-session.js";
import type { ProviderChatOpts, ProviderPort, ToolExecutorPort } from "../ports/uc1.js";
import type { ChatMessage, ProviderChunk, ProviderConfig, ToolCall, ToolSpec } from "../domain/chat.js";
import { codexThreadWorkspace, type WorkspaceBind } from "../domain/workspace-bind.js";

export type CodexTurnEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "usage"; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: "toolUse"; readonly id: string; readonly name: string; readonly args: unknown }
  | { readonly kind: "toolResult"; readonly id: string; readonly name: string; readonly output: string; readonly success: boolean }
  | { readonly kind: "completed" };

export const CODEX_CLI_VERSION = "0.163.0";
export const CODEX_PROVIDER_CATALOG = Object.freeze([
  { id: "codex", transport: "app-server", tools: true },
  { id: "codex-ax", transport: "app-server", tools: true, cliVersion: CODEX_CLI_VERSION },
  { id: "codex-exec", transport: "exec", tools: false },
]);

export interface CodexTurnInput {
  readonly ax?: boolean;
  readonly model: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly signal?: AbortSignal;
  readonly tools?: readonly ToolSpec[];
  readonly executeTool?: (call: ToolCall, signal?: AbortSignal) => Promise<{ output: string; isError?: boolean }>;
  /** Host workspace bind. When set, app-server cwd/sandbox follow this root instead of OS temp. */
  readonly workspace?: WorkspaceBind;
}

export type CodexRunTurn = (input: CodexTurnInput) => AsyncIterable<CodexTurnEvent>;

export type CodexPreflightStatus =
  | { readonly status: "ready"; readonly detail: string }
  | { readonly status: "not-installed" | "login-required" | "error"; readonly detail: string };

type RunCodexStatus = () => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;

/** Global npm installs expose `codex.cmd` on Windows. */
export function codexExecutable(platform = process.platform): string {
  return platform === "win32" ? "codex.cmd" : "codex";
}

/** token/auth.json을 읽지 않고 Codex CLI의 안정 명령만으로 설치·로그인 상태를 확인한다. */
export async function checkCodexPreflight(run?: RunCodexStatus): Promise<CodexPreflightStatus> {
  const execute = run ?? defaultRunCodexStatus;
  try {
    const result = await execute();
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.code === 0 && /logged in/i.test(output)) return { status: "ready", detail: output };
    if (/not logged in|login required|unauthorized/i.test(output)) {
      return { status: "login-required", detail: output || "Codex login required" };
    }
    return { status: "error", detail: output || `codex login status exited ${result.code}` };
  } catch (error) {
    const value = error as { code?: string; message?: string };
    if (value.code === "ENOENT") return { status: "not-installed", detail: "Codex CLI not installed" };
    return { status: "error", detail: value.message ?? "Codex preflight failed" };
  }
}

async function defaultRunCodexStatus(): Promise<{ code: number; stdout: string; stderr: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = process.platform === "win32"
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `${codexExecutable()} login status`], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        windowsHide: true,
      })
      : spawn(codexExecutable(), ["login", "status"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        windowsHide: true,
      });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function foldMessages(messages: readonly ChatMessage[]): { system: string; prompt: string } {
  const system: string[] = [];
  const transcript: string[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) system.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      transcript.push(`Tool result: ${message.content}`);
      continue;
    }
    if (message.role === "assistant") {
      if (message.content) transcript.push(`Assistant: ${message.content}`);
      for (const call of message.toolCalls ?? []) {
        transcript.push(`Assistant called tool ${call.name}(${JSON.stringify(call.args ?? {})})`);
      }
      continue;
    }
    transcript.push(`User: ${message.content}`);
    if (message.inlineImages?.length) transcript.push("[Inline image omitted: this provider adapter does not support image input.]");
  }
  return { system: system.join("\n\n"), prompt: transcript.join("\n\n") };
}

export function makeCodexAppServerProvider(deps?: {
  readonly axExecutor?: ToolExecutorPort;
  readonly model?: string;
  readonly runTurn?: CodexRunTurn;
  readonly workspace?: () => WorkspaceBind | undefined;
}): ProviderPort {
  const runTurn = deps?.runTurn ?? runCodexAppServerTurn;
  return {
    async *chat(
      config: ProviderConfig,
      messages: readonly ChatMessage[],
      opts: ProviderChatOpts,
    ): AsyncIterable<ProviderChunk> {
      if (deps?.axExecutor && messages.some((m) => m.inlineImages?.length || m.attachments?.length)) {
        throw new Error("codex-ax currently accepts text and broker tools only");
      }
      const folded = foldMessages(messages);
      const systemPrompt = [opts.systemPrompt, folded.system].filter(Boolean).join("\n\n");
      const workspace = deps?.workspace?.();
      const axTools = deps?.axExecutor?.specs().filter((spec) => opts.tools?.some((t) => t.name === spec.name)) ?? [];
      for await (const event of runTurn({
        model: deps?.model ?? config.model,
        prompt: folded.prompt,
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(deps?.axExecutor ? {
          ax: true, tools: axTools,
          executeTool: (call: ToolCall, signal?: AbortSignal) => axTools.some((t) => t.name === call.name)
            ? deps.axExecutor!.execute(call, { signal: signal ?? opts.signal, requestId: opts.requestId })
            : Promise.resolve({ output: "AX tool unavailable in this turn", isError: true }),
        } : {
          ...(opts.tools ? { tools: opts.tools } : {}),
          ...(opts.executeTool ? { executeTool: opts.executeTool } : {}),
        }),
        ...(workspace ? { workspace } : {}),
      })) {
        if (event.kind === "text") yield { kind: "text", text: event.text };
        else if (event.kind === "thinking") yield { kind: "thinking", text: event.text };
        else if (event.kind === "usage") {
          yield { kind: "usage", inputTokens: event.inputTokens, outputTokens: event.outputTokens };
        } else if (event.kind === "toolUse") {
          yield { kind: "toolUse", id: event.id, name: event.name, args: event.args, handled: true };
        } else if (event.kind === "toolResult") {
          yield { kind: "toolResult", id: event.id, name: event.name, output: event.output, success: event.success, handled: true };
        } else {
          yield { kind: "finish" };
        }
      }
    },
  };
}

interface RpcMessage {
  readonly id?: number | string;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
  readonly params?: unknown;
}

export interface RpcPeer {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  respond(id: number | string, result: unknown): void;
  notifications(): AsyncIterable<RpcMessage>;
  close(): void;
}

type SpawnCodex = () => Promise<ChildProcessWithoutNullStreams>;

// app-server 는 reasoning effort 를 안 실으면 Codex CLI 기본값(`max`)을 쓴다.
// 그런데 gpt-5.4 는 `max` 를 더는 받지 않는다(지원: none/low/medium/high/xhigh) —
// 그대로 두면 앱 채팅 turn 이 400(unsupported_value)으로 통째로 죽는다. 그래서 항상
// 지원되는 값을 명시한다. 기본은 대화형 음성 채팅에 맞춘 `medium`(낮은 지연으로
// 문장 단위 스트리밍이 자연스럽게 겹치게) 이고, `NAIA_CODEX_REASONING_EFFORT` 로
// 덮을 수 있다. subagent 경로(subagent-codex.ts)가 쓰는 `--config
// model_reasoning_effort` 와 동일한 검증된 스위치다.
const ALLOWED_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh"]);
const APP_SERVER_REASONING_EFFORT = ALLOWED_EFFORTS.has(
  process.env.NAIA_CODEX_REASONING_EFFORT ?? "",
)
  ? (process.env.NAIA_CODEX_REASONING_EFFORT as string)
  : "medium";

async function defaultSpawnCodex(): Promise<ChildProcessWithoutNullStreams> {
  const { spawn } = await import("node:child_process");
  const effortConfig = `model_reasoning_effort="${APP_SERVER_REASONING_EFFORT}"`;
  if (process.platform === "win32") {
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `${codexExecutable()} app-server --config ${effortConfig}`], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });
  }
  return spawn(codexExecutable(), ["app-server", "--config", effortConfig], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    windowsHide: true,
  });
}

/** JSONL app-server peer. Exported for deterministic protocol tests through injected spawn. */
export async function makeCodexRpcPeer(
  spawnCodex: SpawnCodex = defaultSpawnCodex,
): Promise<RpcPeer> {
  const child = await spawnCodex();
  const { createInterface } = await import("node:readline");
  let nextId = 1;
  let closed = false;
  const pending = new Map<number | string, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
  const queued: RpcMessage[] = [];
  const waiters: Array<(value: IteratorResult<RpcMessage>) => void> = [];

  const push = (message: RpcMessage) => {
    const waiter = waiters.shift();
    if (waiter) waiter({ done: false, value: message });
    else queued.push(message);
  };
  const fail = (error: Error) => {
    if (closed) return;
    closed = true;
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    while (waiters.length) waiters.shift()!({ done: true, value: undefined });
  };

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id);
      if (message.error) p.reject(new Error(`Codex app-server: ${message.error.message ?? "request failed"}`));
      else p.resolve(message.result);
      return;
    }
    if (message.method) push(message);
  });
  child.stderr.resume();
  child.once("error", (error) => fail(new Error(`Codex app-server unavailable: ${error.message}`)));
  child.once("exit", (code) => fail(new Error(`Codex app-server exited (${code ?? "signal"})`)));

  const write = (value: unknown) => {
    if (closed || !child.stdin.writable) throw new Error("Codex app-server is closed");
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };

  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        write({ method, id, params });
      });
    },
    notify(method, params) {
      write(params === undefined ? { method } : { method, params });
    },
    respond(id, result) {
      write({ id, result });
    },
    notifications() {
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<RpcMessage>> {
              const value = queued.shift();
              if (value) return Promise.resolve({ done: false, value });
              if (closed) return Promise.resolve({ done: true, value: undefined });
              return new Promise((resolve) => waiters.push(resolve));
            },
          };
        },
      };
    },
    close() {
      if (closed) return;
      fail(new Error("Codex app-server closed"));
      lines.close();
      child.kill();
      while (waiters.length) waiters.shift()!({ done: true, value: undefined });
    },
  };
}

/**
 * 한 ProviderPort 호출을 ephemeral Codex thread 한 개로 실행한다.
 * Naia가 대화 transcript를 전달하므로 app-server 자체 영속 thread에 의존하지 않는다.
 * cwd/sandbox follow the host workspace bind when one exists; otherwise temp + read-only.
 */
export async function* runCodexAppServerTurn(
  input: CodexTurnInput,
  peerFactory?: () => Promise<RpcPeer>,
): AsyncIterable<CodexTurnEvent> {
  input.signal?.throwIfAborted();
  const axController = input.ax ? new AbortController() : undefined;
  if (axController) input = { ...input, signal: input.signal ? AbortSignal.any([input.signal, axController.signal]) : axController.signal };
  let axCwd: string | undefined;
  let axModelCatalog: string | undefined;
  if (input.ax && !peerFactory) {
    const status = await checkCodexAxPreflight();
    if (status.status !== "ready") throw new Error(status.detail);
    const { mkdtemp } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    axCwd = await mkdtemp(join(tmpdir(), "naia-codex-ax-"));
    try { axModelCatalog = await prepareAxModelCatalog(input.model, axCwd); }
    catch (error) { await (await import("node:fs/promises")).rm(axCwd, { recursive: true, force: true }); throw error; }
  }
  let peer: RpcPeer;
  try {
    peer = await (peerFactory ? peerFactory() : input.ax
      ? makeCodexRpcPeer(() => spawnCodexAx(axCwd!, axModelCatalog)) : makeCodexRpcPeer());
  } catch (error) {
    if (axCwd) await (await import("node:fs/promises")).rm(axCwd, { recursive: true, force: true });
    throw error;
  }
  if (input.signal?.aborted) {
    peer.close();
    if (axCwd) await (await import("node:fs/promises")).rm(axCwd, { recursive: true, force: true });
    return;
  }
  let threadId = "";
  let turnId = "";
  let completed = false;
  let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
  const completedDynamicCalls = new Map<string, {
    readonly signature: string;
    readonly result: { output: string; isError?: boolean };
  }>();
  const deadline = input.ax ? setTimeout(() => { axController?.abort(new Error("AX Codex timed out")); peer.close(); }, 120_000) : undefined;
  deadline?.unref();
  const abort = () => {
    if (input.ax) { peer.close(); return; }
    if (threadId && turnId) void peer.request("turn/interrupt", { threadId, turnId }).catch(() => {});
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    await peer.request("initialize", {
      clientInfo: { name: "naia-agent", title: "Naia Agent", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    peer.notify("initialized");
    const { tmpdir } = await import("node:os");
    // Host workspace bind is the Codex sandbox root. Temp isolation remains only
    // when the host has no canonical workspace (first-run / missing ADK).
    const threadWorkspace = input.ax
      ? { cwd: axCwd ?? tmpdir(), sandbox: "read-only" }
      : codexThreadWorkspace(input.workspace, tmpdir());
    let axThreadConfig: Record<string, unknown> = {};
    if (input.ax) {
      const effective = await peer.request("config/read", { includeLayers: false }) as { config?: Record<string, unknown> };
      assertAxConfig(effective.config);
      // TOML table overrides merge: {} does not erase user MCP entries.
      // Disable every configured server before thread/start can initialize it.
      const servers = effective.config?.mcp_servers as Record<string, unknown> | undefined;
      axThreadConfig = { mcp_servers: Object.fromEntries(Object.entries(servers ?? {}).map(([name, server]) => [name, { ...withoutNullConfig(server as Record<string, unknown>), enabled: false }])) };
    }
    // app-server 동적 도구는 한 RPC 안에서 즉시 결과를 돌려줘야 한다. 승인 필요 도구는 제외한다.
    // processing metadata가 있는 도구는 ChatTurnHandler의 executeTool callback이 승인/공개한 뒤 실행한다.
    const dynamicTools = (input.tools ?? [])
      // continue_speaking은 ChatTurnHandler가 인용 검증/상태 전이를 소유하는 내부 제어 도구다.
      // app-server 안에서 선실행하면 그 검증을 우회하므로 외부 executor 도구만 native 실행한다.
      .filter((tool) => tool.name !== "continue_speaking" && (tool.tier === undefined || tool.tier === "none"))
      .map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      }));
    const advertised = new Set(dynamicTools.map((tool) => tool.name));
    const started = await peer.request("thread/start", {
      model: input.model,
      cwd: threadWorkspace.cwd,
      approvalPolicy: "never",
      sandbox: threadWorkspace.sandbox,
      ephemeral: true,
      ...(input.ax ? { config: axThreadConfig } : {}),
      ...(dynamicTools.length ? { dynamicTools } : {}),
      ...(input.systemPrompt ? { baseInstructions: input.systemPrompt } : {}),
    }) as { thread?: { id?: string }; model?: string; sandbox?: { type?: string; networkAccess?: boolean } };
    if (input.ax && (started.model !== input.model || started.sandbox?.type !== "readOnly" || started.sandbox.networkAccess === true)) {
      throw new Error("AX effective model/sandbox differs from explicit selection");
    }
    threadId = started.thread?.id ?? "";
    if (!threadId) throw new Error("Codex app-server returned no thread id");
    const turn = await peer.request("turn/start", {
      threadId,
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
      model: input.model,
    }) as { turn?: { id?: string } };
    turnId = turn.turn?.id ?? "";
    if (!turnId) throw new Error("Codex app-server returned no turn id");

    for await (const message of peer.notifications()) {
      const params = (message.params ?? {}) as Record<string, unknown>;
      if (input.ax && message.id !== undefined && message.method !== "item/tool/call") {
        // Native command, patch, permissions, MCP elicitation and unknown requests
        // never inherit a Naia grant. Reply fail closed so the server cannot hang.
        peer.respond(message.id, { decision: "decline" });
        throw new Error("AX rejected native or unknown Codex request");
      }
      if (params["threadId"] !== threadId) continue;
      if (input.ax && (message.method === "item/started" || message.method === "item/completed")) {
        const item = params["item"] as { type?: string } | undefined;
        if (["commandExecution", "fileChange", "mcpToolCall", "webSearch", "collabAgentToolCall"].includes(item?.type ?? "")) {
          throw new Error("AX unexpected native execution event");
        }
      }
      if (message.method === "item/tool/call" && params["turnId"] === turnId && message.id !== undefined) {
        const id = typeof params["callId"] === "string" ? params["callId"] : String(message.id);
        const name = typeof params["tool"] === "string" ? params["tool"] : "";
        const args = params["arguments"] ?? {};
        const signature = JSON.stringify({ name, args });
        const prior = completedDynamicCalls.get(id);
        if (prior) {
          const result = prior.signature === signature
            ? prior.result
            : { output: `dynamic tool call '${id}' was replayed with different input`, isError: true };
          peer.respond(message.id, {
            contentItems: [{ type: "inputText", text: result.output }],
            success: !result.isError,
          });
          continue;
        }
        yield { kind: "toolUse", id, name, args };
        let result: { output: string; isError?: boolean };
        if (!name || !advertised.has(name) || !input.executeTool) {
          result = { output: `dynamic tool '${name || "unknown"}' is unavailable`, isError: true };
        } else {
          try {
            const pending = input.executeTool({ id, name, args }, input.signal);
            result = input.ax ? await abortableCodexTool(pending, input.signal!) : await pending;
          } catch (error) {
            result = { output: error instanceof Error ? error.message : String(error), isError: true };
          }
        }
        completedDynamicCalls.set(id, { signature, result });
        peer.respond(message.id, {
          contentItems: [{ type: "inputText", text: result.output }],
          success: !result.isError,
        });
        yield { kind: "toolResult", id, name, output: result.output, success: !result.isError };
      } else if (message.method === "item/agentMessage/delta" && params["turnId"] === turnId) {
        const delta = params["delta"];
        if (typeof delta === "string" && delta) yield { kind: "text", text: delta };
      } else if (message.method === "item/reasoning/summaryTextDelta" && params["turnId"] === turnId) {
        const delta = params["delta"];
        if (typeof delta === "string" && delta) yield { kind: "thinking", text: delta };
      } else if (message.method === "thread/tokenUsage/updated" && params["turnId"] === turnId) {
        const usage = (params["tokenUsage"] as { last?: { inputTokens?: number; outputTokens?: number } } | undefined)?.last;
        if (usage) {
          // notification은 한 turn에서 여러 번 올 수 있다. 최신 snapshot만 보관해 완료 시 1회 방출한다.
          lastUsage = {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
          };
        }
      } else if (message.method === "turn/completed") {
        const turnResult = params["turn"] as { id?: string; status?: string; error?: { message?: string } } | undefined;
        if (turnResult?.id !== turnId) continue;
        if (turnResult.status === "failed") {
          throw new Error(`Codex turn failed: ${turnResult.error?.message ?? "unknown"}`);
        }
        if (input.ax && turnResult?.status !== "completed" && turnResult?.status !== "interrupted") throw new Error("AX invalid terminal status");
        completed = true;
        if (turnResult.status === "interrupted" || input.signal?.aborted) break;
        if (lastUsage) yield { kind: "usage", ...lastUsage };
        yield { kind: "completed" };
        break;
      } else if (message.method === "error") {
        if (params["turnId"] && params["turnId"] !== turnId) continue;
        const error = params["error"] as { message?: string } | undefined;
        throw new Error(`Codex app-server error: ${error?.message ?? "unknown"}`);
      }
    }
    if (!completed && !input.signal?.aborted) throw new Error("Codex app-server closed before turn completion");
  } finally {
    if (deadline) clearTimeout(deadline);
    input.signal?.removeEventListener("abort", abort);
    peer.close();
    if (axCwd) await (await import("node:fs/promises")).rm(axCwd, { recursive: true, force: true });
  }
}

// AX is pinned independently of legacy Codex. SDK is deliberately not installed.
export async function checkCodexAxPreflight(runVersion?: RunCodexStatus, runLogin?: RunCodexStatus): Promise<CodexPreflightStatus> {
  if (!runVersion || !runLogin) {
    try { buildCodexAxEnv(); }
    catch { return { status: "error", detail: "AX proxy/TLS override requires enterprise transport acceptance" }; }
  }
  try {
    const version = await (runVersion ?? (() => runCodexCommand(["--version"])))();
    if (version.code !== 0 || version.stdout.trim() !== `codex-cli ${CODEX_CLI_VERSION}`) {
      return { status: "error", detail: `codex-ax requires codex-cli ${CODEX_CLI_VERSION}; no fallback` };
    }
    return await checkCodexPreflight(runLogin ?? (() => runCodexCommand(["login", "status"])));
  } catch {
    return { status: "not-installed", detail: `Install @openai/codex@${CODEX_CLI_VERSION}; no fallback` };
  }
}

async function runCodexCommand(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { execFile } = await import("node:child_process");
  const { resolveFallbackCommand } = await import("./subprocess-session.js");
  const bin = resolveFallbackCommand("codex");
  return new Promise((resolve, reject) => {
    execFile(bin.command, [...bin.prefixArgs, ...args], {
      timeout: 10_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
      env: buildCodexAxEnv(),
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") reject(error);
      else resolve({ code: error?.code as number ?? 0, stdout, stderr });
    });
  });
}

const AX_DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "js_repl", "code_mode", "code_mode_only", "code_mode_host",
  "apps", "plugins", "plugin_hooks", "hooks", "codex_hooks", "multi_agent", "multi_agent_v2",
  "browser_use", "browser_use_external", "computer_use", "view_image", "image_generation",
  "memory_tool", "skill_mcp_dependency_install", "tool_suggest", "workspace_dependencies",
  "remote_plugin", "plugin_sharing", "recommended_plugins", "in_app_browser", "browser_use_full_cdp_access",
  "request_permissions_tool", "sleep_tool", "deferred_executor", "send_message_to_user_async",
];

export function codexAxConfig(): Record<string, unknown> {
  return {
    ...Object.fromEntries(AX_DISABLED_FEATURES.map((name) => [`features.${name}`, false])),
    "mcp_servers": {}, "hooks": {}, "plugins": {}, "web_search": "disabled",
    "approval_policy": "never", "sandbox_mode": "read-only",
    "project_doc_max_bytes": 0, "model_reasoning_effort": "low",
    "analytics.enabled": false, "otel.exporter": "none", "otel.trace_exporter": "none",
    "otel.metrics_exporter": "none", "otel.log_user_prompt": false, "otel.log_agent_responses": false,
    "history.persistence": "none", "feedback.enabled": false, "check_for_update_on_startup": false,
    "notify": [],
  };
}

function assertAxConfig(config: Record<string, unknown> | undefined): void {
  if (!config || config.web_search !== "disabled" || config.sandbox_mode !== "read-only" || config.approval_policy !== "never") {
    throw new Error("AX Codex configuration ceiling not established");
  }
  assertAxTransportConfig(config);
  const features = config.features as Record<string, unknown> | undefined;
  if (AX_DISABLED_FEATURES.some((key) => features?.[key] !== false)) throw new Error("AX native tools are not disabled");
}

/** Default pinned CLI transport only. Never print untrusted config values. */
export function assertAxTransportConfig(config: Record<string, unknown>): void {
  const provider = config.model_provider;
  const providers = config.model_providers;
  const profiles = config.profiles;
  const defaultUrl = (value: unknown, expected: string) => value == null || value === expected;
  if (["model_instructions_file", "experimental_compact_prompt_file", "instructions", "developer_instructions", "compact_prompt"].some((key) => config[key] != null) ||
      config.profile != null ||
      (profiles != null && (typeof profiles !== "object" || Array.isArray(profiles) || Object.keys(profiles).length !== 0)) ||
      (provider != null && provider !== "openai") ||
      (providers != null && (typeof providers !== "object" || Array.isArray(providers) || Object.keys(providers).length !== 0)) ||
      !defaultUrl(config.openai_base_url, "https://api.openai.com/v1") ||
      !defaultUrl(config.chatgpt_base_url, "https://chatgpt.com/backend-api/") ||
      config.experimental_thread_store_endpoint != null || config.experimental_thread_store != null) {
    throw new Error("AX unverified model transport configuration; no fallback");
  }
  const otel = config.otel as Record<string, unknown> | undefined;
  const analytics = config.analytics as Record<string, unknown> | undefined;
  const history = config.history as Record<string, unknown> | undefined;
  const feedback = config.feedback as Record<string, unknown> | undefined;
  if (otel?.exporter !== "none" || otel.trace_exporter !== "none" || otel.metrics_exporter !== "none" ||
      otel.log_user_prompt !== false || otel.log_agent_responses !== false || analytics?.enabled !== false ||
      history?.persistence !== "none" || feedback?.enabled !== false || config.check_for_update_on_startup !== false ||
      (config.notify != null && (!Array.isArray(config.notify) || config.notify.length !== 0))) {
    throw new Error("AX telemetry/history/notification ceiling not established");
  }
}

/** A proxy or alternate trust root needs a separately reviewed enterprise policy.
 * Reject rather than silently bypassing the organization's configured proxy. */
export function buildCodexAxEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const overrides = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy",
    "OPENAI_BASE_URL", "CHATGPT_BASE_URL",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];
  if (overrides.some((key) => !!source[key])) throw new Error("AX proxy/TLS override requires enterprise transport acceptance");
  return buildIsolatedSubprocessEnv(source, ["CODEX_HOME"]);
}

async function spawnCodexAx(cwd: string, modelCatalog?: string): Promise<ChildProcessWithoutNullStreams> {
  const { spawn } = await import("node:child_process");
  const { resolveFallbackCommand } = await import("./subprocess-session.js");
  const bin = resolveFallbackCommand("codex");
  const args = Object.entries({ ...codexAxConfig(), ...(modelCatalog ? { model_catalog_json: modelCatalog } : {}) }).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
  return spawn(bin.command, [...bin.prefixArgs, "app-server", ...args], {
    cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: buildCodexAxEnv(),
  });
}

/** CLI catalog is discovery, never an entitlement check or automatic fallback. */
export async function listCodexAxModels(): Promise<readonly { id: string; provider: string; tools: boolean; use: string }[]> {
  const status = await checkCodexAxPreflight();
  if (status.status !== "ready") throw new Error(status.detail);
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const cwd = await mkdtemp(join(tmpdir(), "naia-codex-catalog-"));
  let peer: RpcPeer | undefined;
  const deadline = setTimeout(() => peer?.close(), 15_000);
  try {
    peer = await makeCodexRpcPeer(() => spawnCodexAx(cwd));
    await peer.request("initialize", { clientInfo: { name: "naia-agent", version: "0.2.6" } });
    peer.notify("initialized");
    const effective = await peer.request("config/read", { includeLayers: false }) as { config?: Record<string, unknown> };
    assertAxConfig(effective.config);
    const result = await peer.request("model/list", { limit: 100 }) as { data?: { id?: string; model?: string }[] };
    if (!Array.isArray(result.data)) throw new Error("Invalid Codex model catalog");
    return result.data.map((model) => ({ id: model.model ?? model.id ?? "", provider: "codex-ax", tools: true, use: "chat" })).filter((m) => m.id);
  } finally {
    clearTimeout(deadline);
    peer?.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Pin model tool construction too: current Codex models can force Code Mode,
 * and native apply_patch is independent of the shell feature flag. */
export function axModelCatalog(raw: unknown, model: string): { models: Record<string, unknown>[] } {
  const models = (raw as { models?: Record<string, unknown>[] } | null)?.models;
  const selected = models?.find((entry) => entry.slug === model);
  if (!selected) throw new Error("AX model is absent from the pinned CLI catalog; no fallback");
  return { models: [{ ...selected, tool_mode: "direct", shell_type: "disabled", apply_patch_tool_type: null, experimental_supported_tools: [] }] };
}

async function prepareAxModelCatalog(model: string, cwd: string): Promise<string> {
  const bundled = await runCodexCommand(["debug", "models", "--bundled"]);
  if (bundled.code !== 0) throw new Error("AX pinned model catalog unavailable");
  const catalog = axModelCatalog(JSON.parse(bundled.stdout), model);
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const path = join(cwd, "models.json");
  await writeFile(path, JSON.stringify(catalog), { mode: 0o600 });
  return path;
}

function abortableCodexTool<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new Error("AX aborted")); };
    pending.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

// config/read serializes optional fields as null; thread config translates JSON
// to TOML, where null would become an invalid empty-string timeout/transport.
function withoutNullConfig(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([key, v]) => [key,
    v && typeof v === "object" && !Array.isArray(v) ? withoutNullConfig(v as Record<string, unknown>) : v,
  ]));
}
