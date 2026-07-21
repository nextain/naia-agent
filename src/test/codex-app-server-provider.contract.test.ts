import { describe, expect, it } from "vitest";
import {
  checkCodexPreflight,
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

  it("현재 app-server 동적 도구 RPC 계약으로 호출 결과를 같은 turn에 응답한다", async () => {
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
      params: { dynamicTools: [{ type: "function", name: "get_time", inputSchema: { type: "object" } }] },
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
