// 8G LLM-initiated text-marker recall — Agent loop (#41 v2, core 625b436).
// Step-2 cross-review B1 fix: prove recall result is *injected into the
// re-generation*, not merely that recall was *called*. InspectingMockLLM
// captures request.system per stream() call; the post-recall turn MUST
// contain the recalled fact (kills "delete hits.push(h)" theater mutation).

import { describe, it, expect } from "vitest";
import { Agent } from "@nextain/agent-core";
import type {
  MemoryProvider,
  MemoryHit,
  LLMClient,
  LLMRequest,
  LLMStreamChunk,
} from "@nextain/agent-types";
import { createHost } from "../host/create-host.js";

const RECALLED = "사용자 이름은 Alpha";

class RecordingMemory implements MemoryProvider {
  calls: string[] = [];
  async encode(): Promise<void> {}
  async recall(query: string): Promise<MemoryHit[]> {
    this.calls.push(query);
    // Discriminate so the marker-injection path is isolatable: the
    // always-on start-of-turn recall (verbatim userText) returns nothing;
    // only the marker-parsed query yields the fact. This makes systems[0]
    // (pre-marker) vs systems[1] (post-marker) a meaningful B1 assertion.
    if (query === "내 이름이 뭐였지?") return [];
    return [{ id: "m1", content: RECALLED, score: 1, createdAt: Date.now() }];
  }
  async consolidate() {
    return { factsCreated: 0, factsUpdated: 0, episodesProcessed: 0, durationMs: 0 };
  }
  async close(): Promise<void> {}
}

/** Scripted LLM that ALSO records request.system + request.messages per call. */
class InspectingMockLLM implements LLMClient {
  systems: string[] = [];
  messagesPerCall: LLMRequest["messages"][] = [];
  #i = 0;
  constructor(private readonly turns: string[]) {}
  async generate(): Promise<never> {
    throw new Error("unused");
  }
  async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    const sys = typeof request.system === "string" ? request.system : JSON.stringify(request.system ?? "");
    this.systems.push(sys);
    this.messagesPerCall.push(request.messages.map((m) => ({ ...m })));
    const text = this.turns[Math.min(this.#i, this.turns.length - 1)] ?? "";
    this.#i++;
    yield { type: "start", id: `insp-${this.#i}`, model: "insp" };
    yield { type: "content_block_start", index: 0, block: { type: "text", text } };
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } };
    yield { type: "content_block_stop", index: 0 };
    yield { type: "end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

async function run(mem: RecordingMemory, llm: InspectingMockLLM) {
  const host = createHost({ logLevel: "warn", memory: mem, llm });
  const agent = new Agent({ host, tierForTool: () => "T0" });
  let assistantText = "";
  let ended = 0;
  for await (const ev of agent.sendStream("내 이름이 뭐였지?")) {
    if (ev.type === "turn.ended") {
      assistantText = ev.assistantText;
      ended += 1;
    }
  }
  agent.close();
  return { assistantText, ended };
}

describe("Agent 8G text-marker recall (#41 v2)", () => {
  it("marker → recall(parsed q) → recalled fact INJECTED into re-gen prompt → strip", async () => {
    const mem = new RecordingMemory();
    const llm = new InspectingMockLLM([
      "<recall>내 이름</recall>",
      "당신의 이름은 Alpha 입니다.",
    ]);
    const { assistantText, ended } = await run(mem, llm);
    expect(mem.calls).toEqual(["내 이름이 뭐였지?", "내 이름"]); // start + marker
    // B1: the 2nd stream() (post-recall regen) system MUST carry the fact.
    expect(llm.systems.length).toBe(2);
    expect(llm.systems[0]).not.toContain(RECALLED);
    expect(llm.systems[1]).toContain(RECALLED);
    expect(assistantText).toBe("당신의 이름은 Alpha 입니다.");
    expect(assistantText).not.toContain("<recall>");
    expect(ended).toBe(1);
  });

  it("depth guard caps marker-recalls at 2; leftover marker stripped", async () => {
    const mem = new RecordingMemory();
    const llm = new InspectingMockLLM([
      "<recall>q1</recall>",
      "<recall>q2</recall>",
      "<recall>q3</recall>",
      "fallback",
    ]);
    const { assistantText } = await run(mem, llm);
    expect(mem.calls).toEqual(["내 이름이 뭐였지?", "q1", "q2"]); // q3 not actioned
    expect(assistantText).not.toContain("<recall>");
  });

  it("marker → a continuation user-turn is appended so the model answers (not left on its own marker turn)", async () => {
    // Some providers (gemini via openai-compat naia gateway) return an EMPTY
    // completion when asked to regenerate after their own trailing `<recall>`
    // marker turn. The loop appends a neutral continuation turn so the regen
    // request ends with a USER turn → the model answers. Kills a "delete the
    // continuation push" mutation without coupling to the exact wording.
    const mem = new RecordingMemory();
    const llm = new InspectingMockLLM(["<recall>내 이름</recall>", "당신의 이름은 Alpha 입니다."]);
    await run(mem, llm);
    expect(llm.messagesPerCall.length).toBe(2);
    // Pre-recall request: just the original user turn.
    expect(llm.messagesPerCall[0]!.map((m) => m.role)).toEqual(["user"]);
    // Post-recall regen: user(original) + assistant(marker) + user(continuation).
    const regen = llm.messagesPerCall[1]!;
    expect(regen.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const cont = regen[2]!;
    expect(typeof cont.content === "string" ? cont.content : "").not.toBe("내 이름이 뭐였지?");
    expect((cont.content as string).length).toBeGreaterThan(0);
  });

  it("regression: no marker → no extra recall, text unchanged", async () => {
    const mem = new RecordingMemory();
    const llm = new InspectingMockLLM(["평범한 답변입니다."]);
    const { assistantText } = await run(mem, llm);
    expect(mem.calls.length).toBe(1); // start-of-turn recall only
    expect(assistantText).toBe("평범한 답변입니다.");
  });
});
