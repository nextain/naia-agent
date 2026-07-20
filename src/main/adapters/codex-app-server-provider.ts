// adapters/codex-app-server-provider — Codex app-server 기반 ProviderPort.
//
// `codex` provider는 OpenAI API-key provider가 아니다. 사용자의 로컬 Codex 로그인과
// `codex app-server`를 사용하며 auth.json/token을 읽거나 복사하지 않는다.
// app-server JSONL 프로토콜은 이 파일 안에 격리하고 ProviderPort에는 정규화 chunk만 노출한다.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProviderChatOpts, ProviderPort } from "../ports/uc1.js";
import type { ChatMessage, ProviderChunk, ProviderConfig } from "../domain/chat.js";

export type CodexTurnEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "usage"; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: "completed" };

export interface CodexTurnInput {
  readonly model: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly signal?: AbortSignal;
}

export type CodexRunTurn = (input: CodexTurnInput) => AsyncIterable<CodexTurnEvent>;

export type CodexPreflightStatus =
  | { readonly status: "ready"; readonly detail: string }
  | { readonly status: "not-installed" | "login-required" | "error"; readonly detail: string };

type RunCodexStatus = () => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;

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
    const child = spawn("codex", ["login", "status"], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
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
  }
  return { system: system.join("\n\n"), prompt: transcript.join("\n\n") };
}

export function makeCodexAppServerProvider(deps?: {
  readonly model?: string;
  readonly runTurn?: CodexRunTurn;
}): ProviderPort {
  const runTurn = deps?.runTurn ?? runCodexAppServerTurn;
  return {
    async *chat(
      config: ProviderConfig,
      messages: readonly ChatMessage[],
      opts: ProviderChatOpts,
    ): AsyncIterable<ProviderChunk> {
      const folded = foldMessages(messages);
      const systemPrompt = [opts.systemPrompt, folded.system].filter(Boolean).join("\n\n");
      for await (const event of runTurn({
        model: deps?.model ?? config.model,
        prompt: folded.prompt,
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      })) {
        if (event.kind === "text") yield { kind: "text", text: event.text };
        else if (event.kind === "thinking") yield { kind: "thinking", text: event.text };
        else if (event.kind === "usage") {
          yield { kind: "usage", inputTokens: event.inputTokens, outputTokens: event.outputTokens };
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

interface RpcPeer {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  notifications(): AsyncIterable<RpcMessage>;
  close(): void;
}

type SpawnCodex = () => Promise<ChildProcessWithoutNullStreams>;

async function defaultSpawnCodex(): Promise<ChildProcessWithoutNullStreams> {
  const { spawn } = await import("node:child_process");
  return spawn("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
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
      closed = true;
      lines.close();
      child.kill();
      while (waiters.length) waiters.shift()!({ done: true, value: undefined });
    },
  };
}

/**
 * 한 ProviderPort 호출을 ephemeral Codex thread 한 개로 실행한다.
 * Naia가 대화 transcript를 전달하므로 app-server 자체 영속 thread에 의존하지 않으며,
 * read-only + approval never로 Naia 채팅이 사용자 파일을 변경하지 못하게 한다.
 */
export async function* runCodexAppServerTurn(input: CodexTurnInput): AsyncIterable<CodexTurnEvent> {
  const peer = await makeCodexRpcPeer();
  if (input.signal?.aborted) {
    peer.close();
    return;
  }
  let threadId = "";
  let turnId = "";
  let completed = false;
  let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
  const abort = () => {
    if (threadId && turnId) void peer.request("turn/interrupt", { threadId, turnId }).catch(() => {});
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    await peer.request("initialize", {
      clientInfo: { name: "naia-agent", title: "Naia Agent", version: "0.1.0" },
      capabilities: null,
    });
    peer.notify("initialized");
    const { tmpdir } = await import("node:os");
    const started = await peer.request("thread/start", {
      model: input.model,
      // 앱 채팅은 코딩 workspace가 아니다. 임시 디렉터리에서 시작해 주변 AGENTS.md/소스가
      // 프롬프트에 유입되거나 토큰을 소비하지 않게 한다.
      cwd: tmpdir(),
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      ...(input.systemPrompt ? { baseInstructions: input.systemPrompt } : {}),
    }) as { thread?: { id?: string } };
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
      if (params["threadId"] !== threadId) continue;
      if (message.method === "item/agentMessage/delta" && params["turnId"] === turnId) {
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
    input.signal?.removeEventListener("abort", abort);
    peer.close();
  }
}
