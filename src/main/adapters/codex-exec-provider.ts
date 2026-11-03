// UC1 / FR-AX-026.1–2 — opt-in text-only Codex exec ProviderPort.
// The app-server provider remains the tool-capable Codex route.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type { ChatMessage, ProviderChunk } from "../domain/chat.js";
import type { DiagnosticLog, ProviderPort } from "../ports/uc1.js";
import { buildIsolatedSubprocessEnv, resolveSpawnableBin, resolveFallbackCommand } from "./subprocess-session.js";

export interface CodexExecInput {
  readonly model: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
  readonly apiKey?: string;
}

export type CodexExecRunner = (input: CodexExecInput) => AsyncIterable<unknown>;

export function makeCodexExecProvider(deps: {
  readonly run?: CodexExecRunner;
  readonly tempRoot?: string;
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly diag?: DiagnosticLog;
} = {}): ProviderPort {
  const run = deps.run ?? ((input) => runCodexExec(input, deps));
  return {
    async *chat(config, messages, opts): AsyncIterable<ProviderChunk> {
      opts.signal?.throwIfAborted();
      if (opts.tools?.length) throw new Error("codex-exec text preview does not support tools; use codex app-server");
      if (messages.some((message) => message.inlineImages?.length)) throw new Error("codex-exec text preview does not support images");
      if (messages.some((message) => message.attachments?.length)) throw new Error("codex-exec text preview does not support attachments");
      deps.diag?.debug?.("CodexExecProvider start", { messageCount: messages.length });
      let completed = false;
      for await (const raw of run({
        model: config.model,
        prompt: JSON.stringify({ instructions: opts.systemPrompt ?? "", messages: transcript(messages) }),
        signal: opts.signal,
        // Secret comes only from the credential port, never argv or diagnostics.
        apiKey: config.apiKey,
      })) {
        opts.signal?.throwIfAborted();
        if (!raw || typeof raw !== "object") throw new Error("Codex exec invalid event");
        const event = raw as Record<string, unknown>;
        if (typeof event.type !== "string") throw new Error("Codex exec invalid event type");
        if (completed) throw new Error("Codex exec event after completion");
        if (event.type === "error" || event.type === "turn.failed") throw new Error("Codex exec turn failed (check authentication or provider status)");
        if (event.type === "item.completed") {
          const item = event.item as Record<string, unknown> | undefined;
          if (item?.type === "agent_message" && typeof item.text === "string") yield { kind: "text", text: item.text };
          else if (item?.type !== "reasoning") throw new Error("Codex exec unexpected native tool/item in text preview");
        }
        if (event.type === "turn.completed") {
          completed = true;
          const usage = event.usage as Record<string, unknown> | undefined;
          if (usage) {
            const inputTokens = tokenCount(usage.input_tokens);
            const outputTokens = tokenCount(usage.output_tokens);
            yield { kind: "usage", inputTokens, outputTokens };
          }
        }
      }
      opts.signal?.throwIfAborted();
      if (!completed) throw new Error("Codex exec closed before turn completion");
      deps.diag?.debug?.("CodexExecProvider finish");
      yield { kind: "finish" };
    },
  };
}

function tokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Codex exec invalid usage");
  return value;
}

function transcript(messages: readonly ChatMessage[]): unknown {
  return messages.map((message) => ({ role: message.role, content: message.content, ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}), ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}) }));
}

/** No workspace files are implicitly attached. Empty temporary cwd, user config
 * disabled, no shell/web/MCP integration. This preview is not a B2B egress sandbox.
 * Executable selection is trusted host configuration, never wire/model input.
 */
export async function* runCodexExec(input: CodexExecInput, deps: {
  readonly tempRoot?: string;
  readonly executable?: string;
  readonly timeoutMs?: number;
} = {}): AsyncIterable<unknown> {
  input.signal?.throwIfAborted();
  const timeoutMs = deps.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid Codex exec timeout");
  const cwd = await mkdtemp(join(deps.tempRoot ?? tmpdir(), "naia-codex-exec-"));
  let cleanup: (() => Promise<void>) | undefined;
  try {
    input.signal?.throwIfAborted();
    const bin = deps.executable ? resolveSpawnableBin(deps.executable) : resolveFallbackCommand("codex");
    const env = buildIsolatedSubprocessEnv(process.env, ["CODEX_HOME"]);
    if (input.apiKey) env.CODEX_API_KEY = input.apiKey;
    const child = spawn(bin.command, [...bin.prefixArgs,
      "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "--sandbox", "read-only", "--skip-git-repo-check", "--cd", cwd,
      "--config", 'approval_policy="never"',
      "--config", "features.shell_tool=false",
      "--config", "features.apply_patch_freeform=false",
      "--config", 'web_search="disabled"',
      "--config", "mcp_servers={}",
      "--model", input.model, "-",
    ], { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const killTree = (signal: "SIGTERM" | "SIGKILL") => {
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
      } else if (process.platform === "win32" && child.pid) {
        // Kill the tree on the FIRST stop: killing the parent first would lose
        // the PID ancestry taskkill needs to find its descendants.
        const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => { child.kill("SIGKILL"); });
        killer.unref();
      } else child.kill(signal);
    };
    const stop = (error: Error) => {
      failure ??= error;
      if (!closed) {
        killTree("SIGTERM");
        killTimer ??= setTimeout(() => {
          killTree("SIGKILL");
          // Even an escaped descendant cannot keep inherited pipes open here.
          lines.close();
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        }, 500);
        killTimer.unref();
      }
    };
    const exited = new Promise<void>((resolve) => {
      child.once("error", () => { failure ??= new Error("Codex exec unavailable"); });
      child.once("close", (code) => {
        closed = true;
        if (code !== 0) failure ??= new Error("Codex exec process failed");
        resolve();
      });
    });
    const abort = () => stop(new Error("Codex exec aborted"));
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    const timer = setTimeout(() => stop(new Error("Codex exec timed out")), timeoutMs);
    timer.unref();
    let bytes = 0;
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 8 * 1024 * 1024) stop(new Error("Codex exec output limit exceeded"));
    });
    // Drain stderr without persisting prompts, document data or credentials.
    child.stderr.resume();
    child.stdin.on("error", () => stop(new Error("Codex exec input failed")));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    cleanup = async () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      lines.close();
      if (!closed) stop(new Error("Codex exec consumer closed"));
      await exited;
      if (killTimer) clearTimeout(killTimer);
    };
    child.stdin.end(input.prompt);
    for await (const line of lines) {
      if (failure) throw failure;
      if (!line.trim()) continue;
      let event: unknown;
      try { event = JSON.parse(line); } catch { throw new Error("Codex exec malformed JSONL"); }
      yield event;
    }
    await exited;
    if (failure) throw failure;
  } finally {
    await cleanup?.();
    await rm(cwd, { recursive: true, force: true });
  }
}
