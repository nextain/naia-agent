import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  checkGrokPreflight,
  classifyGrokPreflight,
  createGrokNdjsonAcc,
  grokChatArgs,
  grokExecutable,
  grokNdjsonLineToEvents,
  grokSubscriptionEnv,
  makeGrokCliProvider,
  runGrokCliTurn,
  type GrokRunTurn,
  type GrokTurnInput,
  GROK_CHAT_DISALLOWED_TOOLS,
} from "../main/adapters/grok-cli-provider.js";
import { makeProviderResolver } from "../main/adapters/provider-resolver.js";
import { resolveProviderRoute } from "../main/domain/provider-route.js";
import { calculateCost } from "../main/domain/cost.js";
import type { ProviderChunk } from "../main/domain/chat.js";

async function collect(stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const chunks: ProviderChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const PROBE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", apiKeySource: "oauth", model: "grok-4.6" }),
  JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 5 } } } }),
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ok " } } }),
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "pong" } } }),
  JSON.stringify({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 5, output_tokens: 2 } } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "pong", usage: { input_tokens: 5, output_tokens: 2 } }),
];

describe("Grok CLI subscription main provider", () => {
  it("uses the Windows command shim while preserving the POSIX executable", () => {
    expect(grokExecutable("win32")).toBe("grok.cmd");
    expect(grokExecutable("linux")).toBe("grok");
    expect(grokExecutable("darwin")).toBe("grok");
  });

  it("grok는 xAI API-key native가 아닌 전용 route다", () => {
    expect(resolveProviderRoute({ provider: "grok", model: "grok-4.6" })).toBe("grok");
    expect(resolveProviderRoute({ provider: "xai", model: "grok-4.3" })).toBe("native");
  });

  it("구독 env는 XAI_API_KEY를 제거한다", () => {
    const env = grokSubscriptionEnv({ XAI_API_KEY: "xai-secret", PATH: "/usr/bin", HOME: "/tmp" });
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(JSON.stringify(env)).not.toContain("xai-secret");
  });

  it("채팅 args는 헤드리스 구독 경로이고 always-approve/auth.json이 없다", () => {
    const args = grokChatArgs({ prompt: "hi", model: "grok-4.6", systemPrompt: "brief", cwd: "/tmp" });
    expect(args).toContain("-p");
    expect(args).toContain("streaming-messages-json");
    expect(args).toContain("--include-partial-messages");
    expect(args).toContain("--max-turns");
    expect(args).toContain("--disallowed-tools");
    expect(args.join(" ")).toContain(GROK_CHAT_DISALLOWED_TOOLS.split(",")[0]);
    expect(args).toContain("-m");
    expect(args).toContain("grok-4.6");
    expect(args).not.toContain("--always-approve");
    expect(args.join(" ")).not.toContain("auth.json");
    expect(args.join(" ")).not.toContain("XAI_API_KEY");
  });

  it("NDJSON stream_event를 thinking/text로 접는다", () => {
    const acc = createGrokNdjsonAcc();
    const events = PROBE_LINES.flatMap((line) => grokNdjsonLineToEvents(line, acc));
    expect(events).toEqual([
      { kind: "thinking", text: "ok " },
      { kind: "text", text: "pong" },
    ]);
    expect(acc.inTok).toBe(5);
    expect(acc.outTok).toBe(2);
  });

  it("result is_error는 error 이벤트다", () => {
    const acc = createGrokNdjsonAcc();
    expect(grokNdjsonLineToEvents(JSON.stringify({ type: "result", is_error: true, result: "quota" }), acc)).toEqual([
      { kind: "error", message: "quota" },
    ]);
  });

  it("메시지/system/model을 turn에 전달하고 정규화 chunk를 방출한다", async () => {
    let captured: GrokTurnInput | undefined;
    const runTurn: GrokRunTurn = (input) => {
      captured = input;
      return (async function* () {
        yield { kind: "thinking", text: "검토" } as const;
        yield { kind: "text", text: "pong" } as const;
        yield { kind: "usage", inputTokens: 5, outputTokens: 2 } as const;
        yield { kind: "completed" } as const;
      })();
    };
    const provider = makeGrokCliProvider({ runTurn });
    const chunks = await collect(provider.chat(
      { provider: "grok", model: "grok-4.6" },
      [
        { role: "system", content: "한국어로 답해" },
        { role: "user", content: "ping" },
      ],
      { systemPrompt: "간결하게" },
    ));
    expect(captured?.model).toBe("grok-4.6");
    expect(captured?.systemPrompt).toContain("간결하게");
    expect(captured?.systemPrompt).toContain("한국어로 답해");
    expect(captured?.prompt).toContain("User: ping");
    expect(chunks).toEqual([
      { kind: "thinking", text: "검토" },
      { kind: "text", text: "pong" },
      { kind: "usage", inputTokens: 5, outputTokens: 2 },
      { kind: "finish" },
    ]);
  });

  it("resolver는 fetch/API key 없이 Grok transport를 선택한다", async () => {
    let fetchCalls = 0;
    const resolver = makeProviderResolver({
      fetch: (async () => {
        fetchCalls++;
        throw new Error("must not fetch");
      }) as never,
      grokRunTurn: () => (async function* () {
        yield { kind: "text", text: "ok" } as const;
        yield { kind: "completed" } as const;
      })(),
    });
    const config = { provider: "grok", model: "grok-4.6" };
    const chunks = await collect(resolver.resolve(config).chat(config, [{ role: "user", content: "hi" }], {}));
    expect(fetchCalls).toBe(0);
    expect(chunks).toEqual([{ kind: "text", text: "ok" }, { kind: "finish" }]);
  });

  it("구독 grok 과금은 0이고 xai 동일 모델은 per-token이다", () => {
    expect(calculateCost("grok-4.6", 1_000_000, 1_000_000, "grok")).toBe(0);
    expect(calculateCost("grok-4.3", 1_000_000, 1_000_000, "xai")).toBeGreaterThan(0);
  });

  it("preflight는 안전한 상태만 분류하고 계정 문자열을 결과 detail에 넣지 않는다", async () => {
    expect(classifyGrokPreflight(true, "You are logged in with grok.com.\nDefault model: grok-4.6")).toEqual({
      status: "ready",
      detail: "logged in",
    });
    expect(classifyGrokPreflight(false, "Not logged in. Run grok login.")).toMatchObject({ status: "login-required" });
    expect(classifyGrokPreflight(false, "", "ENOENT")).toMatchObject({ status: "not-installed" });
    const ready = await checkGrokPreflight(async () => ({
      code: 0,
      stdout: "You are logged in as private@example.com",
      stderr: "",
    }));
    expect(ready.status).toBe("ready");
    expect(ready.detail).not.toContain("private@example.com");
  });

  it("주입 spawn의 실 NDJSON 라인을 읽어 usage+finish까지 통합한다", async () => {
    const spawn = async () => {
      const stdout = Readable.from(PROBE_LINES.map((line) => `${line}\n`));
      const child = {
        stdout,
        stderr: Readable.from([]),
        kill() { return true; },
        once(event: string, cb: (...args: unknown[]) => void) {
          if (event === "error") return child;
          if (event === "exit") queueMicrotask(() => cb(0));
          return child;
        },
      };
      return child as unknown as ChildProcess;
    };
    const events: string[] = [];
    for await (const event of runGrokCliTurn(
      { model: "grok-4.6", prompt: "ping" },
      spawn,
    )) {
      events.push(event.kind);
    }
    expect(events).toEqual(["thinking", "text", "usage", "completed"]);
  });
});
