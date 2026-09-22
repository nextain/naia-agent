// nextain/naia-shell#687 promised-tool guard contract test
import { describe, it, expect } from "vitest";
import {
  ChatTurnHandler,
  isUnfulfilledActionPromise,
  ACTION_PROMISE_RETRY_INSTRUCTION,
  ACTION_EXECUTION_POLICY,
  type HandlerDeps,
} from "../main/app/chat-turn-handler.js";
import { makeFakeProvider } from "../main/adapters/fake-provider.js";
import { makeInMemoryCredentials } from "../main/composition/index.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import type { ProviderPort, ToolExecutorPort } from "../main/ports/uc1.js";
import type { AgentEmit, ChatMessage, ChatRequest, ProviderChunk, ToolCall } from "../main/domain/chat.js";

function capture() {
  const emits: { requestId: string; e: AgentEmit }[] = [];
  const executedCalls: ToolCall[] = [];
  const toolExecutor: ToolExecutorPort = {
    specs: () => [{ name: "skill_workspace_get_open_file", description: "open file", parameters: {} }],
    execute: async (call) => {
      executedCalls.push(call);
      return { output: '{"open":true,"path":"D:/x/a.md"}' };
    },
  };
  const deps: HandlerDeps = {
    provider: makeFakeProvider(),
    conversation: { assemble: (r) => ({ messages: r.messages, ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}) }) },
    credentials: makeInMemoryCredentials(),
    approval: makeInMemoryApproval(),
    egress: { emit: (requestId, e) => emits.push({ requestId, e }) },
    diag: { log: () => {} },
    toolExecutor,
  };
  return { deps, emits, executedCalls };
}

const req = (o: Partial<ChatRequest> = {}): ChatRequest => ({
  kind: "chat",
  requestId: "r1",
  provider: { provider: "nextain", model: "deepseek-v4-flash" },
  messages: [{ role: "user", content: "워크스페이스에 열린거 보여 ?" }],
  ...o,
});

describe("nextain/naia-shell#687 promised-tool guard", () => {
  it("(a) retry leads to a real tool call", async () => {
    const { deps, emits, executedCalls } = capture();
    let calls = 0;
    const seenMessages: (readonly ChatMessage[])[] = [];
    const provider: ProviderPort = {
      async *chat(_config, messages): AsyncIterable<ProviderChunk> {
        seenMessages.push(messages);
        calls++;
        if (calls === 1) {
          yield { kind: "text", text: "지금 에디터에 열려 있는 파일을 확인해 보겠습니다." };
        } else if (calls === 2) {
          yield { kind: "toolUse", id: "t1", name: "skill_workspace_get_open_file", args: {} };
        } else {
          yield { kind: "text", text: "a.md 가 열려 있습니다." };
        }
        yield { kind: "finish" };
      },
    };

    await new ChatTurnHandler({ ...deps, provider }).onChatRequest(req());

    expect(calls).toBe(3);
    expect(executedCalls.length).toBe(1);
    expect(seenMessages[1]?.at(-1)).toEqual({ role: "user", content: ACTION_PROMISE_RETRY_INSTRUCTION });
    expect(seenMessages[1]?.at(-2)).toEqual({ role: "assistant", content: "지금 에디터에 열려 있는 파일을 확인해 보겠습니다." });
    const toolUseEmit = emits.find(({ e }) => e.kind === "toolUse");
    expect(toolUseEmit).toBeDefined();
    expect((toolUseEmit?.e as { toolName?: string })?.toolName).toBe("skill_workspace_get_open_file");
    expect(emits.at(-1)?.e.kind).toBe("finish");
    expect(emits.some(({ e }) => e.kind === "error")).toBe(false);
  });

  it("(b1) no retry when no real tools", async () => {
    const { deps, emits } = capture();
    let calls = 0;
    const provider: ProviderPort = {
      async *chat(): AsyncIterable<ProviderChunk> {
        calls++;
        yield { kind: "text", text: "지금 에디터에 열려 있는 파일을 확인해 보겠습니다." };
        yield { kind: "finish" };
      },
    };
    const depsWithoutTools: HandlerDeps = { ...deps, provider, toolExecutor: undefined };

    await new ChatTurnHandler(depsWithoutTools).onChatRequest(req());

    expect(calls).toBe(1);
    expect(emits.at(-1)?.e.kind).toBe("finish");
    expect(emits.some(({ e }) => e.kind === "error")).toBe(false);
  });

  it("(b2) no retry when enableTools: false with executor present", async () => {
    const { deps, emits } = capture();
    let calls = 0;
    const provider: ProviderPort = {
      async *chat(): AsyncIterable<ProviderChunk> {
        calls++;
        yield { kind: "text", text: "지금 에디터에 열려 있는 파일을 확인해 보겠습니다." };
        yield { kind: "finish" };
      },
    };

    await new ChatTurnHandler({ ...deps, provider }).onChatRequest(req({ enableTools: false }));

    expect(calls).toBe(1);
    expect(emits.at(-1)?.e.kind).toBe("finish");
    expect(emits.some(({ e }) => e.kind === "error")).toBe(false);
  });

  it("(b3) no retry when a tool was already called this turn", async () => {
    const { deps, emits, executedCalls } = capture();
    let calls = 0;
    const provider: ProviderPort = {
      async *chat(): AsyncIterable<ProviderChunk> {
        calls++;
        if (calls === 1) {
          yield { kind: "toolUse", id: "t1", name: "skill_workspace_get_open_file", args: {} };
        } else {
          yield { kind: "text", text: "추가로 더 살펴보겠습니다." };
        }
        yield { kind: "finish" };
      },
    };

    await new ChatTurnHandler({ ...deps, provider }).onChatRequest(req());

    expect(calls).toBe(2);
    expect(executedCalls.length).toBe(1);
    expect(emits.at(-1)?.e.kind).toBe("finish");
    expect(emits.some(({ e }) => e.kind === "error")).toBe(false);
  });

  it("(b4) no retry after a provider-native tool", async () => {
    const { deps, emits } = capture();
    let calls = 0;
    const provider: ProviderPort = {
      async *chat(): AsyncIterable<ProviderChunk> {
        calls++;
        yield { kind: "toolUse", id: "n1", name: "skill_workspace_get_open_file", args: {}, handled: true };
        yield { kind: "toolResult", id: "n1", name: "skill_workspace_get_open_file", output: "ok", success: true, handled: true };
        yield { kind: "text", text: "확인해 보겠습니다." };
        yield { kind: "finish" };
      },
    };

    await new ChatTurnHandler({ ...deps, provider }).onChatRequest(req());

    expect(calls).toBe(1);
    expect(emits.at(-1)?.e.kind).toBe("finish");
    expect(emits.some(({ e }) => e.kind === "error")).toBe(false);
  });

  it("(c) only one retry per turn", async () => {
    const { deps, emits } = capture();
    let calls = 0;
    const provider: ProviderPort = {
      async *chat(): AsyncIterable<ProviderChunk> {
        calls++;
        yield { kind: "text", text: "확인해 보겠습니다." };
        yield { kind: "finish" };
      },
    };

    await new ChatTurnHandler({ ...deps, provider }).onChatRequest(req());

    expect(calls).toBe(2);
    expect(emits.at(-1)?.e.kind).toBe("finish");
    expect(emits.some(({ e }) => e.kind === "error")).toBe(false);
  });

  it("(d) negative: a normal final answer with tools does not retry", async () => {
    const { deps, emits } = capture();
    let calls = 0;
    const seenMessages: (readonly ChatMessage[])[] = [];
    const provider: ProviderPort = {
      async *chat(_config, messages): AsyncIterable<ProviderChunk> {
        seenMessages.push(messages);
        calls++;
        yield { kind: "text", text: "서울은 지금 맑습니다." };
        yield { kind: "finish" };
      },
    };

    await new ChatTurnHandler({ ...deps, provider }).onChatRequest(req());

    expect(calls).toBe(1);
    expect(emits.at(-1)?.e.kind).toBe("finish");
    expect(seenMessages.length).toBe(1);
    expect(seenMessages[0]?.every((m) => m.content !== ACTION_PROMISE_RETRY_INSTRUCTION)).toBe(true);
  });

  it("English: non-DeepSeek provider retries on action promise", async () => {
    const { deps, emits, executedCalls } = capture();
    let calls = 0;
    const provider: ProviderPort = {
      async *chat(): AsyncIterable<ProviderChunk> {
        calls++;
        if (calls === 1) {
          yield { kind: "text", text: "Sure, I'll check the open file." };
        } else if (calls === 2) {
          yield { kind: "toolUse", id: "t1", name: "skill_workspace_get_open_file", args: {} };
        } else {
          yield { kind: "text", text: "The open file is a.md." };
        }
        yield { kind: "finish" };
      },
    };

    await new ChatTurnHandler({ ...deps, provider }).onChatRequest(req({
      provider: { provider: "openai", model: "gpt-x" },
    }));

    expect(calls).toBe(3);
    expect(executedCalls.length).toBe(1);
    expect(emits.at(-1)?.e.kind).toBe("finish");
    expect(emits.some(({ e }) => e.kind === "error")).toBe(false);
  });

  describe("isUnfulfilledActionPromise unit table", () => {
    it.each([
      ["확인해 보겠습니다.", true, false, true],
      ["지금 확인해볼게", true, false, true],
      ["제가 한 번 확인해볼게요!", true, false, true],
      ["바로 검색할게요.", true, false, true],
      ["찾아보겠습니다", true, false, true],
      ["살펴볼게요… 아니 살펴보겠습니다.", true, false, true],
      ["Let me check that.", true, false, true],
      ["확인해 보겠습니다.", false, false, false],
      ["확인해 보겠습니다.", true, true, false],
      ["서울은 맑습니다.", true, false, false],
      ["", true, false, false],
      ["먼저 확인해 보겠습니다. " + "결과는 다음과 같습니다. ".repeat(20), true, false, false],
    ])("given text %j with toolsOffered=%s and toolCalledThisTurn=%s returns %s", (text, toolsOffered, toolCalledThisTurn, expected) => {
      expect(isUnfulfilledActionPromise(text, toolsOffered, toolCalledThisTurn)).toBe(expected);
    });
  });

  it("ACTION_EXECUTION_POLICY contains 'Never state or imply a tool result'", () => {
    expect(ACTION_EXECUTION_POLICY).toContain("Never state or imply a tool result");
  });
});
