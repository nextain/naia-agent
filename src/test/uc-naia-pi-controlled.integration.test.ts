import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makePiSubAgent } from "../main/adapters/subagent-pi.js";
import type { SubAgentEvent } from "../main/domain/orchestration.js";

const dirs: string[] = [];
const makeTemp = (): string => { const dir = mkdtempSync(join(tmpdir(), "naia-pi-e2e-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows child handles can close late */ } } });

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendCompletion(res: ServerResponse, request: Record<string, unknown>, model: string,
  message: Record<string, unknown>, finishReason: string, usage: Record<string, number>): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id: "chatcmpl-controlled", object: "chat.completion", created: 1, model,
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finishReason }], usage,
    customer_cost: "0.00001000", price_version_id: "controlled-price-v1", currency: "USD",
    settlement_status: "settled", billing_status: "settled",
    gateway_request_id: request.gateway_request_id, gateway_attempt: request.gateway_attempt }));
}

const gatewayBudget = (dir: string, maxGatewayCalls: number) => ({ path: join(dir, "gateway.db"), policy: {
  maxGatewayCalls, maxUsd: 0.1, maxInputTokens: 8_000, maxOutputTokens: 1_000,
  requestAllowance: { reservedUsd: 0.05, reservedInputTokens: 4_000, reservedOutputTokens: 500 },
} });

async function collect(events: AsyncIterable<SubAgentEvent>): Promise<SubAgentEvent[]> {
  const out: SubAgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("UC-NAIA-PI controlled Agent -> real Pi -> Naia-compatible gateway", () => {
  it("Grok receives tools, executes write, and reports the selected model", async () => {
    let calls = 0;
    const server = createServer(async (req, res) => {
      const body = await bodyOf(req);
      calls += 1;
      expect(req.url).toBe("/v1/chat/completions");
      expect(req.headers["x-anyllm-key"]).toBe("Bearer controlled-key");
      expect(body.model).toBe("grok-4.3");
      expect(body.stream).toBe(false);
      if (calls === 1) {
        expect(Array.isArray(body.tools)).toBe(true);
        sendCompletion(res, body, "grok-4.3", { content: null,
          tool_calls: [{ id: "call_write", type: "function", function: { name: "write",
            arguments: JSON.stringify({ path: "proof.txt", content: "made by grok" }) } }] },
        "tool_calls", { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
      } else {
        sendCompletion(res, body, "grok-4.3", { content: "done" }, "stop",
          { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 });
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing server address");
      const workdir = makeTemp();
      const configDir = makeTemp();
      const session = makePiSubAgent({
        env: { ...process.env, NAIA_API_KEY: "controlled-key", NAIA_ANYLLM_BASE_URL: `http://127.0.0.1:${address.port}` },
        piConfigDir: configDir, gatewayBudget: gatewayBudget(configDir, 2),
      }).spawn({ prompt: "Create proof.txt with the requested content.", workdir, model: "grok-4.3" });
      const events = await collect(session.events);
      expect(events.at(-1), JSON.stringify(events)).toMatchObject({ kind: "session_end", ok: true });
      expect(events.some((event) => event.kind === "model_evidence" && event.evidence.selectedModel === "grok-4.3")).toBe(true);
      expect(events.some((event) => event.kind === "tool_use_start" && event.tool === "write")).toBe(true);
      expect(events.some((event) => event.kind === "tool_use_end" && event.tool === "write" && event.ok)).toBe(true);
      expect(readFileSync(join(workdir, "proof.txt"), "utf8")).toBe("made by grok");
      expect(readdirSync(workdir)).toEqual(["proof.txt"]);
      expect(calls).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("DeepSeek --no-tools sends no tool definitions and completes analysis", async () => {
    const server = createServer(async (req, res) => {
      const body = await bodyOf(req);
      expect(body.model).toBe("deepseek-v4-pro");
      expect(body.tools).toBeUndefined();
      expect(body.stream).toBe(false);
      sendCompletion(res, body, "deepseek-v4-pro", { content: "review ok" }, "stop",
        { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing server address");
      const configDir = makeTemp();
      const session = makePiSubAgent({
        noTools: true,
        env: { ...process.env, NAIA_API_KEY: "controlled-key", NAIA_ANYLLM_BASE_URL: `http://127.0.0.1:${address.port}` },
        piConfigDir: configDir, gatewayBudget: gatewayBudget(configDir, 1),
      }).spawn({ prompt: "Review this text.", workdir: makeTemp(), model: "deepseek-v4-pro" });
      const events = await collect(session.events);
      expect(events.at(-1), JSON.stringify(events)).toMatchObject({ kind: "session_end", ok: true });
      expect(events.some((event) => event.kind === "model_evidence" && event.evidence.totalTokens === 5)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
