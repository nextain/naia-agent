// adapters/grok-cli-provider — Grok Build CLI 구독 ProviderPort.
//
// `provider=grok` 는 xAI API-key(`provider=xai`)가 아니다. SuperGrok / X Premium+ 로컬
// `grok login` OAuth를 쓰며 ~/.grok/auth.json 을 읽거나 복사하지 않는다.
// spawn env에서 XAI_API_KEY를 제거해 종량 API로 새지 않게 한다.
//
// 채팅은 Claude Code `-p` 동형 헤드리스: streaming-messages-json NDJSON → ProviderChunk.
// 사용자 workspace를 만지지 않도록 cwd=tmpdir, 내장 tool 비활성, --always-approve 금지.
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import type { ProviderChatOpts, ProviderPort } from "../ports/uc1.js";
import type { ChatMessage, ProviderChunk, ProviderConfig } from "../domain/chat.js";

export type GrokPreflightStatus =
  | { readonly status: "ready"; readonly detail: string }
  | { readonly status: "not-installed" | "login-required" | "error"; readonly detail: string };

export type GrokTurnEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "usage"; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: "toolUse"; readonly id: string; readonly name: string; readonly args: unknown }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "completed" };

export interface GrokTurnInput {
  readonly model: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly signal?: AbortSignal;
}

export type GrokRunTurn = (input: GrokTurnInput) => AsyncIterable<GrokTurnEvent>;

type RunGrokStatus = () => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
type SpawnGrok = (args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<ChildProcess>;

/** 채팅에서 막을 Grok 내장 도구(2026-09-02 grok 1.0.13 init.tools 실측). */
export const GROK_CHAT_DISALLOWED_TOOLS = [
  "run_terminal_command",
  "read_file",
  "search_replace",
  "list_dir",
  "grep",
  "kill_command_or_subagent",
  "todo_write",
  "get_command_or_subagent_output",
  "spawn_subagent",
  "scheduler_create",
  "scheduler_delete",
  "scheduler_list",
  "monitor",
  "search_tool",
  "use_tool",
  "workflow",
  "enter_plan_mode",
  "exit_plan_mode",
  "ask_user_question",
  "web_search",
  "web_fetch",
  "image_gen",
  "image_edit",
  "image_to_video",
  "reference_to_video",
  "write",
].join(",");

export function grokExecutable(platform = process.platform): string {
  return platform === "win32" ? "grok.cmd" : "grok";
}

/** 구독 OAuth를 쓰기 위해 종량 API 키를 제거한다. */
export function grokSubscriptionEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.XAI_API_KEY;
  return env;
}

export function grokChatArgs(input: {
  readonly prompt: string;
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly cwd: string;
}): string[] {
  const args = [
    "-p", input.prompt,
    "--output-format", "streaming-messages-json",
    "--include-partial-messages",
    "--max-turns", "1",
    "--no-subagents",
    "--disable-web-search",
    "--disallowed-tools", GROK_CHAT_DISALLOWED_TOOLS,
    "--cwd", input.cwd,
  ];
  if (input.model) args.push("-m", input.model);
  if (input.systemPrompt) args.push("--system-prompt-override", input.systemPrompt);
  return args;
}

export function classifyGrokPreflight(
  exitSuccess: boolean,
  output: string,
  errorCode?: string,
): GrokPreflightStatus {
  if (errorCode === "ENOENT") return { status: "not-installed", detail: "Grok CLI not installed" };
  const normalized = output.toLowerCase();
  if (
    normalized.includes("not recognized")
    || normalized.includes("command not found")
    || normalized.includes("no such file")
  ) {
    return { status: "not-installed", detail: output || "Grok CLI not installed" };
  }
  if (
    /not logged in|login required|unauthorized|unauthenticated|please (log|sign) in|auth(?:entication)? required/.test(
      normalized,
    )
  ) {
    return { status: "login-required", detail: "Grok login required" };
  }
  if (exitSuccess && /logged in/.test(normalized)) {
    return { status: "ready", detail: "logged in" };
  }
  return { status: "error", detail: "Grok preflight failed" };
}

export async function checkGrokPreflight(run?: RunGrokStatus): Promise<GrokPreflightStatus> {
  const execute = run ?? defaultRunGrokModels;
  try {
    const result = await execute();
    return classifyGrokPreflight(result.code === 0, `${result.stdout}\n${result.stderr}`.trim());
  } catch (error) {
    const value = error as { code?: string; message?: string };
    return classifyGrokPreflight(false, value.message ?? "", value.code);
  }
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

interface StreamEventLike {
  type?: string;
  index?: number;
  message?: { usage?: UsageLike };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
  usage?: UsageLike;
}
interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
interface ToolAcc { id: string; name: string; json: string }

export interface GrokNdjsonAcc {
  inTok: number;
  outTok: number;
  toolAcc: Map<number, ToolAcc>;
}

export function createGrokNdjsonAcc(): GrokNdjsonAcc {
  return { inTok: 0, outTok: 0, toolAcc: new Map() };
}

/** streaming-messages-json 한 줄 → 이벤트. 파싱 불능 줄은 무시. */
export function grokNdjsonLineToEvents(line: string, acc: GrokNdjsonAcc): GrokTurnEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let msg: { type?: string; event?: StreamEventLike; is_error?: boolean; result?: string; usage?: UsageLike };
  try {
    msg = JSON.parse(trimmed) as typeof msg;
  } catch {
    return [];
  }
  if (msg.type === "result") {
    if (msg.is_error) return [{ kind: "error", message: msg.result ?? "Grok CLI error" }];
    const u = msg.usage;
    if (u) {
      acc.inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (u.output_tokens !== undefined) acc.outTok = u.output_tokens;
    }
    return [];
  }
  if (msg.type !== "stream_event" || !msg.event) return [];
  return mapStreamEvent(msg.event, acc);
}

function mapStreamEvent(ev: StreamEventLike, acc: GrokNdjsonAcc): GrokTurnEvent[] {
  const out: GrokTurnEvent[] = [];
  switch (ev.type) {
    case "message_start": {
      const u = ev.message?.usage;
      if (u) acc.inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      break;
    }
    case "content_block_start": {
      const idx = ev.index ?? 0;
      const cb = ev.content_block;
      if (cb?.type === "tool_use") acc.toolAcc.set(idx, { id: cb.id ?? `call_${idx}`, name: cb.name ?? "", json: "" });
      break;
    }
    case "content_block_delta": {
      const idx = ev.index ?? 0;
      const d = ev.delta;
      if (d?.type === "text_delta" && d.text) out.push({ kind: "text", text: d.text });
      else if (d?.type === "thinking_delta" && d.thinking) out.push({ kind: "thinking", text: d.thinking });
      else if (d?.type === "input_json_delta") {
        const a = acc.toolAcc.get(idx);
        if (a && typeof d.partial_json === "string") a.json += d.partial_json;
      }
      break;
    }
    case "content_block_stop": {
      const idx = ev.index ?? 0;
      const a = acc.toolAcc.get(idx);
      if (a) {
        let args: unknown = {};
        if (a.json.trim()) {
          try { args = JSON.parse(a.json); } catch { args = {}; }
        }
        out.push({ kind: "toolUse", id: a.id, name: a.name, args });
        acc.toolAcc.delete(idx);
      }
      break;
    }
    case "message_delta": {
      const u = ev.usage;
      if (u?.output_tokens !== undefined) acc.outTok = u.output_tokens;
      if (u?.input_tokens !== undefined) {
        acc.inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      }
      break;
    }
  }
  return out;
}

export function makeGrokCliProvider(deps?: {
  readonly model?: string;
  readonly runTurn?: GrokRunTurn;
}): ProviderPort {
  const runTurn = deps?.runTurn ?? runGrokCliTurn;
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
        else if (event.kind === "usage") yield { kind: "usage", inputTokens: event.inputTokens, outputTokens: event.outputTokens };
        else if (event.kind === "toolUse") yield { kind: "toolUse", id: event.id, name: event.name, args: event.args };
        else if (event.kind === "error") throw new Error(event.message);
        else yield { kind: "finish" };
      }
    },
  };
}

export async function* runGrokCliTurn(
  input: GrokTurnInput,
  spawnGrok: SpawnGrok = defaultSpawnGrok,
): AsyncIterable<GrokTurnEvent> {
  if (input.signal?.aborted) return;
  const cwd = tmpdir();
  const args = grokChatArgs({
    prompt: input.prompt,
    model: input.model,
    cwd,
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
  });
  const child = await spawnGrok(args, cwd, grokSubscriptionEnv());
  const { createInterface } = await import("node:readline");
  if (!child.stdout) throw new Error("Grok CLI stdout is unavailable");
  const lines = createInterface({ input: child.stdout });
  const acc = createGrokNdjsonAcc();
  let failed: Error | undefined;
  const abort = () => {
    try { child.kill(); } catch { /* already exited */ }
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  child.once("error", (error) => {
    failed = error;
    lines.close();
  });
  try {
    for await (const line of lines) {
      if (input.signal?.aborted) return;
      for (const event of grokNdjsonLineToEvents(line, acc)) {
        if (event.kind === "error") {
          throw new Error(event.message);
        }
        yield event;
      }
    }
    if (failed) {
      const err = failed as { code?: string; message?: string };
      if (err.code === "ENOENT") throw new Error("Grok CLI not installed");
      throw failed;
    }
    if (input.signal?.aborted) return;
    if (acc.inTok > 0 || acc.outTok > 0) {
      yield { kind: "usage", inputTokens: acc.inTok, outputTokens: acc.outTok };
    }
    yield { kind: "completed" };
  } finally {
    input.signal?.removeEventListener("abort", abort);
    lines.close();
    abort();
  }
}

async function defaultSpawnGrok(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ChildProcess> {
  const { spawn } = await import("node:child_process");
  if (process.platform === "win32") {
    const quoted = args.map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(" ");
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `${grokExecutable()} ${quoted}`], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      cwd,
    });
  }
  return spawn(grokExecutable(), [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    cwd,
  });
}

async function defaultRunGrokModels(): Promise<{ code: number; stdout: string; stderr: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = process.platform === "win32"
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `${grokExecutable()} models`], {
        stdio: ["ignore", "pipe", "pipe"],
        env: grokSubscriptionEnv(),
      })
      : spawn(grokExecutable(), ["models"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: grokSubscriptionEnv(),
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
