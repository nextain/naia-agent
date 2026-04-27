/**
 * LabProxyLiveClient — Naia Lab Gateway Live API (WebSocket).
 *
 * R4 Phase 5 Day 7.2 — Live API WebSocket wire (gemini-2.5-flash-live 등).
 *
 * **Design decision (Phase 4.4 spec LOCK)**:
 *   - gemini_live.rs와 **coexist** — Tauri direct vs Gateway 분리
 *   - WebSocket library: **ws@^8** (naia-os 기존 dep, peerDep optional)
 *   - text-only minimal (Phase 5 본 단계) — audio + bidirectional은 Phase 5+ 정식
 *
 * Wire format: Naia Lab Gateway WebSocket (path TBD — 본 spec은 placeholder)
 *   - Auth: ?key=<naiaKey> query param 또는 Sec-WebSocket-Protocol header
 *   - Messages: JSON (text/audio_delta/tool_call)
 *
 * Limitations (Phase 5 Day 7.2 minimal):
 *   - text streaming only (audio_delta는 Phase 5+ D43 audio provider abstraction)
 *   - tool_calls + functionResponse는 round-trip 미구현 (text-only model)
 *   - reconnect: 1회 retry only (production은 exponential backoff 필요)
 *
 * Phase 5+ enhancements (deferred):
 *   - audio_delta inline emission (D43 audio provider)
 *   - bidirectional tool_calls (Live API supports interactive)
 *   - reconnect with backoff
 *   - graceful close on signal abort (현재 즉시 terminate)
 */

import { randomUUID } from "node:crypto";
import type {
  LLMClient,
  LLMContentBlock,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  LLMUsage,
  StopReason,
} from "@nextain/agent-types";

export interface LabProxyLiveClientOptions {
  naiaKey: string;
  /** Gateway WebSocket URL (must be wss://). */
  gatewayWsUrl: string;
  /** Default model. */
  defaultModel?: string;
  /** Connection timeout (ms). Default 30s. */
  connectTimeoutMs?: number;
}

const DEFAULT_PROD_GATEWAY_WS_URL =
  "wss://naia-gateway-181404717065.asia-northeast3.run.app/v1/live";

interface LiveServerMessage {
  type: "text" | "audio_delta" | "usage" | "end" | "error";
  content?: string;
  data?: string;  // base64 audio
  inputTokens?: number;
  outputTokens?: number;
  message?: string;
  stopReason?: StopReason;
}

export class LabProxyLiveClient implements LLMClient {
  readonly #naiaKey: string;
  readonly #gatewayWsUrl: string;
  readonly #defaultModel: string;
  readonly #connectTimeoutMs: number;

  constructor(opts: LabProxyLiveClientOptions) {
    if (!opts.gatewayWsUrl.startsWith("wss://")) {
      throw new Error(
        `LabProxyLiveClient: rejecting non-WSS gateway URL "${opts.gatewayWsUrl}" — naiaKey must only be sent over secure WebSocket.`,
      );
    }
    this.#naiaKey = opts.naiaKey;
    this.#gatewayWsUrl = opts.gatewayWsUrl;
    this.#defaultModel = opts.defaultModel ?? "gemini-2.5-flash-live";
    this.#connectTimeoutMs = opts.connectTimeoutMs ?? 30_000;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const id = randomUUID();
    const content: LLMContentBlock[] = [];
    let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";
    let textBuf = "";

    for await (const chunk of this.stream(request)) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        textBuf += chunk.delta.text;
      } else if (chunk.type === "end") {
        stopReason = chunk.stopReason;
        usage = chunk.usage;
      }
    }
    if (textBuf) content.push({ type: "text", text: textBuf });

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

    // Dynamic import — ws is peerDep optional, fail clearly if missing.
    let WebSocket: typeof import("ws").default;
    try {
      const wsModule = await import("ws");
      WebSocket = wsModule.default;
    } catch {
      throw new Error(
        "LabProxyLiveClient: 'ws' peerDep not installed. Run: pnpm add ws @types/ws",
      );
    }

    // Build URL with auth (query param — Sec-WebSocket-Protocol alternative TBD).
    const url = new URL(this.#gatewayWsUrl);
    url.searchParams.set("key", this.#naiaKey);
    url.searchParams.set("model", model);

    const ws = new WebSocket(url.toString());

    // Connect with timeout.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`LabProxyLive: connect timeout (${this.#connectTimeoutMs}ms)`));
      }, this.#connectTimeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Send initial request — flatten messages to text payload.
    // (Live API spec is opaque — assume gateway accepts {messages, model, system?})
    const initialPayload = {
      type: "request",
      messages: request.messages,
      ...(request.system ? { system: request.system } : {}),
      model,
    };
    ws.send(JSON.stringify(initialPayload));

    // Abort handler.
    const onAbort = () => {
      try { ws.terminate(); } catch { /* ignore */ }
    };
    request.signal?.addEventListener("abort", onAbort);

    let textBlockOpen = false;
    const textBlockIndex = 0;
    let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";
    let queue: LiveServerMessage[] = [];
    let resolveNext: ((v: IteratorResult<LiveServerMessage>) => void) | null = null;
    let closed = false;
    let errorObj: Error | null = null;

    ws.on("message", (data: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof data === "string" ? data : data.toString("utf-8")) as LiveServerMessage;
        if (resolveNext) {
          resolveNext({ value: msg, done: false });
          resolveNext = null;
        } else {
          queue.push(msg);
        }
      } catch {
        // ignore malformed
      }
    });
    ws.on("close", () => {
      closed = true;
      if (resolveNext) {
        resolveNext({ value: undefined as unknown as LiveServerMessage, done: true });
        resolveNext = null;
      }
    });
    ws.on("error", (err: Error) => {
      errorObj = err;
      closed = true;
      if (resolveNext) {
        resolveNext({ value: undefined as unknown as LiveServerMessage, done: true });
        resolveNext = null;
      }
    });

    // Async iterator over queue.
    const next = (): Promise<IteratorResult<LiveServerMessage>> => {
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift()!, done: false });
      }
      if (closed) {
        return Promise.resolve({ value: undefined as unknown as LiveServerMessage, done: true });
      }
      return new Promise((resolve) => {
        resolveNext = resolve;
      });
    };

    try {
      while (true) {
        const result = await next();
        if (result.done) break;
        const msg = result.value;
        if (msg.type === "text" && msg.content) {
          if (!textBlockOpen) {
            textBlockOpen = true;
            yield {
              type: "content_block_start",
              index: textBlockIndex,
              block: { type: "text", text: "" },
            };
          }
          yield {
            type: "content_block_delta",
            index: textBlockIndex,
            delta: { type: "text_delta", text: msg.content },
          };
        } else if (msg.type === "usage") {
          if (msg.inputTokens !== undefined) usage.inputTokens = msg.inputTokens;
          if (msg.outputTokens !== undefined) usage.outputTokens = msg.outputTokens;
        } else if (msg.type === "end") {
          if (msg.stopReason) stopReason = msg.stopReason;
          break;
        } else if (msg.type === "error") {
          throw new Error(`LabProxyLive: gateway error: ${msg.message ?? "unknown"}`);
        }
        // audio_delta: Phase 5+ D43 — currently dropped silently.
      }
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
      try { ws.close(); } catch { /* ignore */ }
    }

    if (errorObj) throw errorObj;

    if (textBlockOpen) {
      yield { type: "content_block_stop", index: textBlockIndex };
    }

    yield { type: "end", stopReason, usage };
  }
}

export const LAB_PROXY_LIVE_DEFAULT_GATEWAY_WS_URL = DEFAULT_PROD_GATEWAY_WS_URL;
