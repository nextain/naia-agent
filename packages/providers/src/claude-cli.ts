/**
 * ClaudeCliClient — LLMClient implementation over the `claude` CLI binary
 * (Claude Code CLI subprocess).
 *
 * R4 Phase 4.1 Day 4.3.3 — Strangler Fig horizontal expansion (Claude-CLI family).
 * Minimal (Phase 4.1 transition) — Flatpak / Windows specific flows are
 * deferred to Phase 4.2 (use native naia-os createClaudeCodeCliProvider during
 * transition for those paths).
 *
 * Required env: `CLAUDE_CODE_PATH` (default: "claude") must resolve to the
 * Claude Code CLI binary.
 *
 * Stream format: `claude --output-format stream-json` emits one JSON object
 * per line (system/assistant/error/result). This client parses each line into
 * LLMStreamChunk values.
 *
 * Limitations (vs naia-os native 460 LOC):
 *   - No Flatpak `flatpak-spawn --host` wrap (caller's responsibility for now)
 *   - No Windows .cmd shim resolution
 *   - No partial-JSON recovery across chunk boundaries
 *   - No system-prompt-file fallback for >64KB prompts
 *   - Disallowed-tools list is opinionated (matches naia-os defaults)
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  LLMClient,
  LLMContentBlock,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  LLMUsage,
  StopReason,
} from "@nextain/agent-types";

export interface ClaudeCliClientOptions {
  /** Path to the `claude` binary. Default: process.env.CLAUDE_CODE_PATH ?? "claude". */
  binaryPath?: string;
  /** Default model. */
  defaultModel?: string;
  /** Comma-separated list of CLI tool names to disallow. Defaults to naia-os list. */
  disallowedTools?: string;
  /** Subprocess timeout (ms). Default 600_000 (10 min). */
  timeoutMs?: number;
  /** Max output tokens (CLAUDE_CODE_MAX_OUTPUT_TOKENS env). Default "32000". */
  maxOutputTokens?: string;
}

const DEFAULT_DISALLOWED_TOOLS = [
  "Task", "Bash", "Glob", "Grep", "LS", "Read", "Edit", "MultiEdit", "Write",
  "NotebookRead", "NotebookEdit", "WebFetch", "TodoRead", "TodoWrite", "WebSearch",
].join(",");

const DEFAULT_MAX_OUTPUT_TOKENS = "32000";

interface ClaudeCliMessage {
  type: "system" | "assistant" | "error" | "result";
  message?: {
    content?: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }>;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    stop_reason?: string;
  };
  error?: { message?: string; type?: string };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
}

export class ClaudeCliClient implements LLMClient {
  readonly #binaryPath: string;
  readonly #defaultModel: string;
  readonly #disallowedTools: string;
  readonly #timeoutMs: number;
  readonly #maxOutputTokens: string;

  constructor(opts: ClaudeCliClientOptions = {}) {
    this.#binaryPath =
      opts.binaryPath ?? process.env["CLAUDE_CODE_PATH"] ?? "claude";
    this.#defaultModel = opts.defaultModel ?? "claude-opus-4-7";
    this.#disallowedTools = opts.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS;
    this.#timeoutMs = opts.timeoutMs ?? 600_000;
    this.#maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    // Single-shot: collect all stream chunks, return final assembly.
    const id = randomUUID();
    const content: LLMContentBlock[] = [];
    let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";

    let textBuf = "";
    for await (const chunk of this.stream(request)) {
      if (chunk.type === "content_block_delta") {
        if (chunk.delta.type === "text_delta") textBuf += chunk.delta.text;
      } else if (chunk.type === "content_block_start" && chunk.block.type === "tool_use") {
        content.push(chunk.block);
      } else if (chunk.type === "usage") {
        if (chunk.usage.inputTokens !== undefined) usage.inputTokens = chunk.usage.inputTokens;
        if (chunk.usage.outputTokens !== undefined) usage.outputTokens = chunk.usage.outputTokens;
      } else if (chunk.type === "end") {
        stopReason = chunk.stopReason;
        usage = chunk.usage;
      }
    }
    if (textBuf) content.unshift({ type: "text", text: textBuf });

    return {
      id,
      model: request.model ?? this.#defaultModel,
      content,
      stopReason,
      usage,
    };
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    const id = randomUUID();
    const model = request.model ?? this.#defaultModel;
    yield { type: "start", id, model };

    const systemPrompt = this.#systemString(request);
    const args = [
      "--system-prompt", systemPrompt,
      "--verbose",
      "--output-format", "stream-json",
      "--disallowedTools", this.#disallowedTools,
      "--max-turns", "1",
      "--model", model,
      "-p",
    ];

    // Phase 4.2 Day 5.1 (Cross-review Paranoid P0-3 fix) — env allowlist.
    // Previous behavior: spread `process.env` then `delete` selected keys.
    // Risk: PATH manipulation, LD_PRELOAD trojan, DYLD_* injection — child
    // inherits ALL parent env, attacker controls execution context.
    // Fix: explicit allowlist of required env vars only. New process env =
    // ONLY allowlisted entries + Claude Code-specific overrides.
    const ALLOWED_ENV_KEYS = [
      "PATH",          // binary resolution (claude CLI lookup)
      "HOME",          // ~/.claude config / cache
      "USER",          // some CLI tools require it
      "LANG", "LC_ALL", "LC_CTYPE",  // locale for stdout encoding
      "TERM",          // terminal type (subprocess may check)
      "TZ",            // time zone for timestamps
      "TMPDIR", "TEMP", "TMP",  // temp file paths
      "FLATPAK", "FLATPAK_ID",  // Flatpak detect (caller may need)
      "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",  // XDG dirs
    ];
    const env: NodeJS.ProcessEnv = {};
    for (const key of ALLOWED_ENV_KEYS) {
      const v = process.env[key];
      if (v !== undefined) env[key] = v;
    }
    // Forward CLAUDE_* config keys (subset, no API_KEY family).
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("CLAUDE_CODE_") && key !== "CLAUDE_CODE_MAX_OUTPUT_TOKENS"
          && key !== "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC") {
        env[key] = process.env[key];
      }
    }
    // Apply Claude Code-specific overrides (always set, regardless of env).
    env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = this.#maxOutputTokens;
    env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] =
      process.env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] ?? "1";
    env["DISABLE_NON_ESSENTIAL_MODEL_CALLS"] =
      process.env["DISABLE_NON_ESSENTIAL_MODEL_CALLS"] ?? "1";
    // NOTE: ANTHROPIC_API_KEY / CLAUDECODE / LD_PRELOAD / LD_LIBRARY_PATH /
    // DYLD_* are NEVER added — implicit by allowlist construction.
    //
    // Cross-review (Phase 4.2 Paranoid P2 caveat) — additional excluded keys:
    //   - NPM_*, NODE_OPTIONS (would inject Node flags if claude were
    //     npm-invoked; mitigated by direct binary spawn)
    //   - GIT_SSH_COMMAND, SSH_AUTH_SOCK (claude CLI does not need SSH)
    //   - subprocess env inheritance via ptrace is possible if attacker
    //     shares uid; mitigated at host level (HostContext trust model).

    const child = spawn(this.#binaryPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    const onAbort = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    request.signal?.addEventListener("abort", onAbort);

    if (!child.stdin || !child.stdout) {
      throw new Error("ClaudeCliClient: failed to open subprocess stdio");
    }

    // stdin: send conversation messages as JSON.
    const payload = JSON.stringify(messagesToClaude(request.messages));
    child.stdin.write(payload);
    child.stdin.end();

    let buffer = "";
    let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";
    let blockIndex = 0;

    child.stdout.setEncoding("utf8");
    try {
      for await (const rawChunk of child.stdout) {
        if (request.signal?.aborted) break;
        buffer += rawChunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let msg: ClaudeCliMessage | null = null;
          try {
            msg = JSON.parse(trimmed) as ClaudeCliMessage;
          } catch {
            continue;  // partial JSON recovery deferred to Phase 4.2
          }
          if (msg.type === "assistant" && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === "text" && typeof block.text === "string") {
                yield {
                  type: "content_block_start",
                  index: blockIndex,
                  block: { type: "text", text: block.text },
                };
                yield {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "text_delta", text: block.text },
                };
                yield { type: "content_block_stop", index: blockIndex };
                blockIndex++;
              } else if (block.type === "tool_use" && block.id && block.name) {
                yield {
                  type: "content_block_start",
                  index: blockIndex,
                  block: {
                    type: "tool_use",
                    id: block.id,
                    name: block.name,
                    input: block.input ?? {},
                  },
                };
                yield { type: "content_block_stop", index: blockIndex };
                blockIndex++;
              } else if (block.type === "thinking" && typeof block.thinking === "string") {
                yield {
                  type: "content_block_start",
                  index: blockIndex,
                  block: { type: "thinking", thinking: block.thinking },
                };
                yield {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "thinking_delta", thinking: block.thinking },
                };
                yield { type: "content_block_stop", index: blockIndex };
                blockIndex++;
              }
            }
            if (msg.message.usage) {
              if (msg.message.usage.input_tokens !== undefined) {
                usage.inputTokens = msg.message.usage.input_tokens;
              }
              if (msg.message.usage.output_tokens !== undefined) {
                usage.outputTokens = msg.message.usage.output_tokens;
              }
            }
            if (msg.message.stop_reason) {
              stopReason = mapStopReason(msg.message.stop_reason);
            }
          } else if (msg.type === "error") {
            throw new Error(`Claude CLI error: ${msg.error?.message ?? "unknown"}`);
          } else if (msg.type === "result" && msg.is_error) {
            throw new Error(`Claude CLI result error: ${msg.result ?? "unknown"}`);
          }
        }
      }
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
      if (!child.killed) child.kill();
    }

    yield { type: "end", stopReason, usage };
  }

  #systemString(request: LLMRequest): string {
    if (!request.system) return "";
    if (typeof request.system === "string") return request.system;
    return request.system
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
  }
}

function mapStopReason(s: string): StopReason {
  switch (s) {
    case "end_turn": return "end_turn";
    case "max_tokens": return "max_tokens";
    case "stop_sequence": return "stop_sequence";
    case "tool_use": return "tool_use";
    case "pause_turn": return "pause_turn";
    case "refusal": return "refusal";
    default: return "end_turn";
  }
}

/** Convert LLMMessage[] to Claude Code CLI message JSON shape. */
function messagesToClaude(messages: LLMMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role === "tool" ? "user" : m.role, content: m.content });
      continue;
    }
    // Block array content
    if (m.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      for (const b of m.content) {
        if (b.type === "text") content.push({ type: "text", text: b.text });
        else if (b.type === "tool_use") {
          content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
        } else if (b.type === "thinking") {
          content.push({ type: "thinking", thinking: b.thinking });
        }
      }
      out.push({ role: "assistant", content });
      continue;
    }
    // user / tool
    const content: Array<Record<string, unknown>> = [];
    for (const b of m.content) {
      if (b.type === "text") content.push({ type: "text", text: b.text });
      else if (b.type === "tool_result") {
        content.push({ type: "tool_result", tool_use_id: b.toolCallId, content: b.content });
      }
    }
    out.push({ role: "user", content });
  }
  return out;
}
