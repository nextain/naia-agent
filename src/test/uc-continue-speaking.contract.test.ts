// UC-015 / SPEC-012 — 사용자 명시 요청 기반 동일-stream 연속 발화 계약.
import { describe, expect, it } from "vitest";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import type { MemoryPort } from "../main/ports/memory.js";
import type { ConversationLogPort } from "../main/ports/conversation-log.js";
import type { ProviderPort, ProviderChatOpts, ToolExecutorPort } from "../main/ports/uc1.js";
import type { AgentEmit, ChatMessage, ChatRequest, ProviderChunk, ToolCall, ToolSpec } from "../main/domain/chat.js";

const USER_TEXT = "라디오처럼 뭐라도 계속 이야기해 줘. 난 씻고 올게.";
const CONTROL_TOOL = "continue_speaking";

interface ContinuationClock {
  now(): number;
  wait(ms: number, signal: AbortSignal): Promise<boolean>;
}

type ContinuationDeps = HandlerDeps & { readonly continuationClock?: ContinuationClock };

interface SeenCall {
  readonly messages: readonly ChatMessage[];
  readonly opts: ProviderChatOpts;
}

function chunks(...items: ProviderChunk[]): AsyncIterable<ProviderChunk> {
  return (async function* () { for (const item of items) yield item; })();
}

function activation(args: unknown = { userRequestQuote: USER_TEXT, durationMinutes: 1, pauseSeconds: 0 }): ProviderChunk[] {
  return [
    { kind: "toolUse", id: "cont-1", name: CONTROL_TOOL, args },
    { kind: "usage", inputTokens: 1, outputTokens: 1 },
    { kind: "finish" },
  ];
}

function mixedActivation(extra: readonly ProviderChunk[], args: unknown = { userRequestQuote: USER_TEXT, durationMinutes: 1, pauseSeconds: 0 }): ProviderChunk[] {
  return [
    { kind: "toolUse", id: "cont-1", name: CONTROL_TOOL, args },
    ...extra,
    { kind: "usage", inputTokens: 1, outputTokens: 1 },
    { kind: "finish" },
  ];
}

function spoken(text: string, n: number): ProviderChunk[] {
  return [
    { kind: "text", text },
    { kind: "usage", inputTokens: n, outputTokens: n + 1 },
    { kind: "finish" },
  ];
}

function scriptedProvider(script: (index: number, seen: SeenCall) => AsyncIterable<ProviderChunk>): {
  provider: ProviderPort;
  seen: SeenCall[];
  activeMax: () => number;
} {
  const seen: SeenCall[] = [];
  let active = 0;
  let max = 0;
  const provider: ProviderPort = {
    chat(_config, messages, opts) {
      const index = seen.length;
      const call = { messages, opts };
      seen.push(call);
      const source = script(index, call);
      return (async function* () {
        active++;
        max = Math.max(max, active);
        try { for await (const chunk of source) yield chunk; }
        finally { active--; }
      })();
    },
  };
  return { provider, seen, activeMax: () => max };
}

function harness(over: Partial<ContinuationDeps> & { provider: ProviderPort }) {
  const events: { requestId: string; event: AgentEmit }[] = [];
  const saves: { user: string; assistant: string }[] = [];
  const appends: { sessionId: string; userText: string; assistantText: string }[] = [];
  const debug: { message: string; ctx: unknown }[] = [];
  const memory: MemoryPort = {
    recall: async () => ({ facts: [], episodes: [] }),
    save: async (user, assistant) => { saves.push({ user, assistant }); },
  };
  const conversationLog: ConversationLogPort = {
    append: async (turn) => { appends.push(turn); },
  };
  const deps: ContinuationDeps = {
    conversation: { assemble: (r) => ({ messages: r.messages, ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}) }) },
    credentials: { update: () => {}, get: () => undefined },
    approval: makeInMemoryApproval(),
    egress: { emit: (requestId, event) => events.push({ requestId, event }) },
    diag: { log: () => {}, debug: (message, ctx) => debug.push({ message, ctx }) },
    memory,
    conversationLog,
    ...over,
  };
  return { handler: new ChatTurnHandler(deps), events, saves, appends, debug, deps };
}

function req(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    kind: "chat",
    requestId: "continuous-1",
    sessionId: "session-1",
    provider: { provider: "ollama", model: "local" },
    messages: [{ role: "user", content: USER_TEXT }],
    ...over,
  };
}

function kinds(events: { event: AgentEmit }[]): string[] { return events.map(({ event }) => event.kind); }
function picked<K extends AgentEmit["kind"]>(events: { event: AgentEmit }[], kind: K): Extract<AgentEmit, { kind: K }>[] {
  return events.map(({ event }) => event).filter((event): event is Extract<AgentEmit, { kind: K }> => event.kind === kind);
}

async function within<T>(promise: Promise<T>, ms = 100): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`>${ms}ms`)), ms); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function waitFor(cond: () => boolean, ms = 100): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started >= ms) throw new Error(`waitFor >${ms}ms`);
    await Promise.resolve();
  }
}

describe("UC-015 연속 발화 — 핵심 stream/context/기록 계약", () => {
  it("AC1/2/3/6: 한 requestId에서 3개 발화를 겹침 없이 순서대로 내고 usage→finish와 save는 각 1회", async () => {
    let now = 0;
    const clock: ContinuationClock = { now: () => now, wait: async () => true };
    const p = scriptedProvider((index) => {
      if (index === 0) return chunks(...activation());
      if (index === 1) return chunks(...spoken("첫 이야기.", 2));
      if (index === 2) return chunks(...spoken("둘째 이야기.", 3));
      now = 60_000;
      return chunks(...spoken("셋째 이야기.", 4));
    });
    const h = harness({ provider: p.provider, continuationClock: clock });

    await h.handler.onChatRequest(req());

    expect(p.seen).toHaveLength(4); // activation + 3 spoken rounds
    // handler가 각 runRound를 await한 뒤 다음 provider를 호출하므로 seen 순서가 발화 순서다.
    expect(h.events.every((item) => item.requestId === "continuous-1")).toBe(true);
    expect(picked(h.events, "text").map((e) => e.text)).toEqual(["첫 이야기.", "둘째 이야기.", "셋째 이야기."]);
    expect(kinds(h.events).slice(-2)).toEqual(["usage", "finish"]);
    expect(picked(h.events, "usage")).toHaveLength(1);
    expect(picked(h.events, "usage")[0]).toMatchObject({ inputTokens: 10, outputTokens: 13 });
    expect(picked(h.events, "finish")).toHaveLength(1);
    expect(picked(h.events, "error")).toHaveLength(0);
    expect(picked(h.events, "toolUse")).toHaveLength(0); // 내부 control은 wire 비노출
    expect(h.saves).toEqual([{ user: USER_TEXT, assistant: "첫 이야기.\n둘째 이야기.\n셋째 이야기." }]);
    expect(h.appends).toEqual([{ sessionId: "session-1", userText: USER_TEXT, assistantText: "첫 이야기.\n둘째 이야기.\n셋째 이야기." }]);

    const activationMessages = p.seen[1]!.messages;
    const hiddenAssistant = activationMessages.find((m) => m.role === "assistant" && m.toolCalls?.some((c) => c.name === CONTROL_TOOL));
    const hiddenResult = activationMessages.find((m) => m.role === "tool" && m.toolCallId === "cont-1");
    expect(hiddenAssistant?.toolCalls?.[0]?.id).toBe("cont-1");
    expect(hiddenResult?.content).toMatch(/activated/i);
    const followupMessages = p.seen[2]!.messages;
    expect(followupMessages.some((m) => m.role === "user" && m.content === USER_TEXT)).toBe(true);
    expect(followupMessages.some((m) => m.role === "assistant" && m.content === "첫 이야기.")).toBe(true);
    expect(followupMessages.some((m) => m.role === "user" && m.content.includes("앞선 이야기"))).toBe(true);
    const thirdMessages = p.seen[3]!.messages;
    expect(thirdMessages.some((m) => m.role === "assistant" && m.content === "둘째 이야기.")).toBe(true);
    expect(thirdMessages.some((m) => m.role === "assistant" && m.content === "첫 이야기.")).toBe(false); // 누적 context 폭증 방지
    expect(p.seen[0]!.opts.tools?.some((tool) => tool.name === CONTROL_TOOL)).toBe(true);
    expect(p.seen.slice(1).every((call) => !call.opts.tools?.some((tool) => tool.name === CONTROL_TOOL))).toBe(true);
  });

  it("AC5: 첫 최종 발화를 #1로 세고 60개 뒤 61번째 provider 호출을 예약하지 않는다", async () => {
    const p = scriptedProvider((index) => index === 0 ? chunks(...activation()) : chunks(...spoken(`발화-${index}`, 1)));
    const h = harness({ provider: p.provider, continuationClock: { now: () => 0, wait: async () => true } });
    await h.handler.onChatRequest(req());
    expect(p.seen).toHaveLength(61); // activation + exactly 60 spoken calls
    expect(picked(h.events, "text")).toHaveLength(60);
    expect(kinds(h.events).slice(-2)).toEqual(["usage", "finish"]);
  });

  it("AC5: 대기 전/직후 now >= activation deadline이면 새 provider 호출을 시작하지 않는다", async () => {
    for (const boundary of ["before", "after"] as const) {
      let now = 0;
      let waits = 0;
      const clock: ContinuationClock = {
        now: () => now,
        wait: async () => { waits++; now = 60_000; return true; },
      };
      const p = scriptedProvider((index) => {
        if (index === 0) return chunks(...activation({ userRequestQuote: USER_TEXT, durationMinutes: 1, pauseSeconds: 1 }));
        if (boundary === "before") now = 60_000;
        return chunks(...spoken("한 번.", 1));
      });
      const h = harness({ provider: p.provider, continuationClock: clock });
      await h.handler.onChatRequest(req({ requestId: `deadline-${boundary}` }));
      expect(p.seen).toHaveLength(2);
      expect(waits).toBe(boundary === "before" ? 0 : 1);
      expect(kinds(h.events).slice(-2)).toEqual(["usage", "finish"]);
    }
  });
});

describe("UC-015 연속 발화 — 명시 요청·정규화·일반 채팅 무회귀", () => {
  it("AC12: 누락/비수치/비유한/분수/범위 밖 인자를 no-throw 정규화한다", async () => {
    const cases = [
      { args: { userRequestQuote: USER_TEXT }, expected: { durationMinutes: 10, pauseSeconds: 3 } },
      { args: { userRequestQuote: USER_TEXT, durationMinutes: "x", pauseSeconds: Number.POSITIVE_INFINITY }, expected: { durationMinutes: 10, pauseSeconds: 3 } },
      { args: { userRequestQuote: USER_TEXT, durationMinutes: 1.5, pauseSeconds: 0.5 }, expected: { durationMinutes: 1.5, pauseSeconds: 0.5 } },
      { args: { userRequestQuote: USER_TEXT, durationMinutes: -2, pauseSeconds: 99 }, expected: { durationMinutes: 1, pauseSeconds: 30 } },
    ];
    for (const [index, item] of cases.entries()) {
      let now = 0;
      const p = scriptedProvider((call) => {
        if (call === 0) return chunks(...activation(item.args));
        now = Number.MAX_SAFE_INTEGER;
        return chunks(...spoken("끝.", 1));
      });
      const h = harness({ provider: p.provider, continuationClock: { now: () => now, wait: async () => true } });
      await expect(h.handler.onChatRequest(req({ requestId: `normalize-${index}` }))).resolves.toBeUndefined();
      const activationLog = h.debug.find((entry) => entry.message.includes("연속 발화 활성화"));
      expect(activationLog?.ctx).toMatchObject(item.expected);
    }
  });

  // AC13 판정 규칙(2026-07-16 개정): 원문 대조는 *인용 형식을 정규화한 뒤* 부분문자열 포함으로 한다.
  // 근거 = AC9 실측(.agents/reviews/issue-82-ollama-integration-2026-07-16.json): 시연 모델이 quote 를
  // 인용부호로 감싸 반환하는 경우가 잦아(내용은 글자 그대로 동일) raw includes 가 정상 인용을 거부했다(4/12).
  // 정규화는 "모델이 사용자 말을 그대로 재현해야 활성화"라는 가드 목적을 바꾸지 않는다 — 아래 거부 케이스가 증명.
  it("AC13: 비거나 원문에 없는 userRequestQuote는 숨은 result로 거부하고 자율 발화를 활성화하지 않는다", async () => {
    for (const quote of ["", "   ", "사용자가 말하지 않은 문장", `"사용자가 하지 않은 완전히 새로운 요청"`]) {
      const p = scriptedProvider((index) => index === 0
        ? chunks(...activation({ userRequestQuote: quote, pauseSeconds: 0 }))
        : chunks(...spoken("일반 답변.", 1)));
      const h = harness({ provider: p.provider });
      await h.handler.onChatRequest(req({ requestId: `reject-${quote.length}` }));
      expect(p.seen, `quote=${JSON.stringify(quote)}`).toHaveLength(2);
      expect(p.seen[1]!.messages.find((m) => m.role === "tool")?.content, `quote=${JSON.stringify(quote)}`).toMatch(/rejected/i);
      expect(picked(h.events, "text").map((e) => e.text)).toEqual(["일반 답변."]);
      expect(kinds(h.events).slice(-2)).toEqual(["usage", "finish"]);
      expect(picked(h.events, "toolUse")).toHaveLength(0);
    }
  });

  it("AC13: 인용부호로 감싸거나 공백이 덧붙은 quote는 정상 인용으로 수락한다(형식 차이 ≠ 거부 사유)", async () => {
    // 시연 모델 실측 실패 형태 + 흔한 인용 변종. 내용은 전부 원문 그대로이므로 활성화되어야 한다.
    for (const quote of [`"${USER_TEXT}"`, `“${USER_TEXT}”`, `'${USER_TEXT}'`, `「${USER_TEXT}」`, ` ${USER_TEXT} `, `"계속 이야기해 줘"`]) {
      let now = 0;
      const clock: ContinuationClock = { now: () => now, wait: async () => { now = 60_000; return true; } };
      const p = scriptedProvider((index) => index === 0
        ? chunks(...activation({ userRequestQuote: quote, durationMinutes: 1, pauseSeconds: 0 }))
        : chunks(...spoken("이어지는 이야기.", 1)));
      const h = harness({ provider: p.provider, continuationClock: clock });
      await h.handler.onChatRequest(req({ requestId: `accept-${quote.length}` }));
      expect(p.seen[1]!.messages.find((m) => m.role === "tool")?.content, `quote=${JSON.stringify(quote)}`).toMatch(/activated/i);
      expect(picked(h.events, "text").map((e) => e.text), `quote=${JSON.stringify(quote)}`).toEqual(["이어지는 이야기."]);
      expect(kinds(h.events).slice(-2)).toEqual(["usage", "finish"]);
      expect(picked(h.events, "error")).toHaveLength(0);
      expect(picked(h.events, "toolUse")).toHaveLength(0); // 내부 control 은 여전히 wire 비노출
    }
  });

  it("AC7/11: provider가 control을 호출하지 않으면 일반 채팅은 provider/usage/finish/save 각 1회", async () => {
    const p = scriptedProvider(() => chunks(...spoken("일반 응답.", 2)));
    const h = harness({ provider: p.provider });
    await h.handler.onChatRequest(req({ messages: [{ role: "user", content: "오늘 날씨 어때?" }] }));
    expect(p.seen).toHaveLength(1);
    expect(kinds(h.events)).toEqual(["text", "usage", "finish"]);
    expect(h.saves).toHaveLength(1);
    expect(p.seen[0]!.opts.tools?.some((tool) => tool.name === CONTROL_TOOL)).toBe(true);
  });

  it("AC11: enableTools=false면 control을 포함한 모든 tool schema를 숨긴다", async () => {
    const exec: ToolExecutorPort = { specs: () => [{ name: "echo", description: "", parameters: {} }], execute: async () => ({ output: "ok" }) };
    const p = scriptedProvider(() => chunks(...spoken("도구 없음.", 1)));
    const h = harness({ provider: p.provider, toolExecutor: exec });
    await h.handler.onChatRequest(req({ enableTools: false }));
    expect(p.seen[0]!.opts.tools).toBeUndefined();
    expect(kinds(h.events)).toEqual(["text", "usage", "finish"]);
  });
});

describe("UC-015 연속 발화 — 끼어들기 취소", () => {
  it("AC4/10: 발화 사이 delay를 100ms 안에 취소하고 usage→cancelled, save 0, timer/listener 정리", async () => {
    let waitStarted = false;
    let waitDisposed = false;
    const clock: ContinuationClock = {
      now: () => 0,
      wait: (_ms, signal) => new Promise((resolve) => {
        waitStarted = true;
        const onAbort = () => { signal.removeEventListener("abort", onAbort); waitDisposed = true; resolve(false); };
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    };
    const p = scriptedProvider((index) => index === 0 ? chunks(...activation({ userRequestQuote: USER_TEXT, durationMinutes: 1, pauseSeconds: 3 })) : chunks(...spoken("첫 발화.", 1)));
    const h = harness({ provider: p.provider, continuationClock: clock });
    const turn = h.handler.onChatRequest(req({ requestId: "cancel-delay" }));
    await waitFor(() => waitStarted);
    h.handler.onCancel({ kind: "cancel", requestId: "cancel-delay" });
    await within(turn);
    expect(waitDisposed).toBe(true);
    expect(kinds(h.events).slice(-2)).toEqual(["usage", "error"]);
    expect(picked(h.events, "error")[0]?.message).toBe("cancelled");
    expect(h.saves).toHaveLength(0);
    expect(h.appends).toHaveLength(0);
    expect(h.handler.turnState("cancel-delay")).toBeUndefined();
  });

  it("AC4/10: provider next() 영구대기를 100ms 안에 취소하고 iterator.return 호출·late event/save 0", async () => {
    let hangingStarted = false;
    let returnCalls = 0;
    let calls = 0;
    const provider: ProviderPort = {
      chat() {
        const index = calls++;
        if (index === 0) return chunks(...activation());
        if (index === 1) return chunks(...spoken("첫 발화.", 1));
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => { hangingStarted = true; return new Promise<IteratorResult<ProviderChunk>>(() => {}); },
              return: async () => { returnCalls++; return { done: true, value: undefined }; },
            };
          },
        };
      },
    };
    const h = harness({ provider, continuationClock: { now: () => 0, wait: async () => true } });
    const turn = h.handler.onChatRequest(req({ requestId: "cancel-provider" }));
    await waitFor(() => hangingStarted);
    h.handler.onCancel({ kind: "cancel", requestId: "cancel-provider" });
    await within(turn);
    expect(returnCalls).toBe(1);
    expect(kinds(h.events).slice(-2)).toEqual(["usage", "error"]);
    expect(picked(h.events, "error")[0]?.message).toBe("cancelled");
    expect(h.saves).toHaveLength(0);
    expect(h.appends).toHaveLength(0);
    expect(h.handler.turnState("cancel-provider")).toBeUndefined();
    await Promise.resolve();
    expect(kinds(h.events).slice(-1)).toEqual(["error"]);
  });
});

describe("UC-015 연속 발화 — 기존 외부 도구 루프 직교", () => {
  const echoSpec: ToolSpec = { name: "echo", description: "echo", parameters: {} };

  it("AC8/11: control+외부 도구 뒤 다중 도구 루프를 완주하고 control만 wire에서 숨긴다", async () => {
    let now = 0;
    const executed: string[] = [];
    const exec: ToolExecutorPort = {
      specs: () => [echoSpec],
      execute: async (call) => { executed.push(call.id); return { output: String((call.args as { text?: string }).text ?? "") }; },
    };
    const p = scriptedProvider((index) => {
      if (index === 0) return chunks(...mixedActivation([{ kind: "toolUse", id: "e1", name: "echo", args: { text: "one" } }]));
      if (index === 1) return chunks({ kind: "toolUse", id: "e2", name: "echo", args: { text: "two" } }, { kind: "finish" });
      if (index === 2) return chunks(...spoken("도구 뒤 첫 발화.", 1));
      now = 60_000;
      return chunks(...spoken("후속 발화.", 1));
    });
    const h = harness({ provider: p.provider, toolExecutor: exec, continuationClock: { now: () => now, wait: async () => true } });
    await h.handler.onChatRequest(req());
    expect(executed).toEqual(["e1", "e2"]);
    expect(picked(h.events, "toolUse").map((e) => e.toolCallId)).toEqual(["e1", "e2"]);
    expect(picked(h.events, "toolResult").map((e) => e.toolCallId)).toEqual(["e1", "e2"]);
    expect(picked(h.events, "text").map((e) => e.text)).toEqual(["도구 뒤 첫 발화.", "후속 발화."]);
    expect(p.seen.slice(1).every((call) => !call.opts.tools?.some((tool) => tool.name === CONTROL_TOOL))).toBe(true);
  });

  it("AC8: mixed gated tool 승인 거부도 정확히 한 toolUse/toolResult 쌍 뒤 계속 발화한다", async () => {
    let now = 0;
    const exec: ToolExecutorPort = {
      specs: () => [{ name: "danger", description: "danger", parameters: {}, tier: "ask" }],
      execute: async () => { throw new Error("must not execute"); },
    };
    const p = scriptedProvider((index) => {
      if (index === 0) return chunks(...mixedActivation([{ kind: "toolUse", id: "d1", name: "danger", args: {} }]));
      now = 60_000;
      return chunks(...spoken("거부 뒤 발화.", 1));
    });
    const h = harness({ provider: p.provider, toolExecutor: exec, continuationClock: { now: () => now, wait: async () => true } });
    const turn = h.handler.onChatRequest(req({ requestId: "mixed-reject" }));
    await waitFor(() => picked(h.events, "approvalRequest").length === 1);
    h.handler.onApprovalResponse({ kind: "approvalResponse", requestId: "mixed-reject", toolCallId: "d1", decision: "reject" });
    await turn;
    expect(picked(h.events, "toolUse").map((e) => e.toolCallId)).toEqual(["d1"]);
    expect(picked(h.events, "toolResult")).toHaveLength(1);
    expect(picked(h.events, "toolResult")[0]).toMatchObject({ toolCallId: "d1", success: false });
    expect(kinds(h.events).slice(-2)).toEqual(["usage", "finish"]);
  });

  it("AC8: mixed tool timeout도 orphan 없이 error result를 thread하고 계속 발화한다", async () => {
    let now = 0;
    const exec: ToolExecutorPort = {
      specs: () => [{ name: "slow", description: "slow", parameters: {} }],
      execute: async (_call: ToolCall) => new Promise(() => {}),
    };
    const p = scriptedProvider((index) => {
      if (index === 0) return chunks(...mixedActivation([{ kind: "toolUse", id: "s1", name: "slow", args: {} }]));
      now = 60_000;
      return chunks(...spoken("타임아웃 뒤 발화.", 1));
    });
    const h = harness({ provider: p.provider, toolExecutor: exec, toolTimeoutMs: 5, continuationClock: { now: () => now, wait: async () => true } });
    await h.handler.onChatRequest(req({ requestId: "mixed-timeout" }));
    expect(picked(h.events, "toolUse").map((e) => e.toolCallId)).toEqual(["s1"]);
    expect(picked(h.events, "toolResult")).toHaveLength(1);
    expect(picked(h.events, "toolResult")[0]).toMatchObject({ toolCallId: "s1", success: false });
    expect(picked(h.events, "toolResult")[0]?.output).toMatch(/timeout/);
    expect(kinds(h.events).slice(-2)).toEqual(["usage", "finish"]);
  });
});
