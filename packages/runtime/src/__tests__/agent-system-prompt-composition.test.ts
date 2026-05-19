// General host-side system-prompt composition control (AgentOptions
// .appendDefaultSystemPrompt). Default-on preserves every existing host's
// behavior; a host may opt out (own contract / token budget / a small
// model the long contract degrades). Model/tier/profile-agnostic — the
// Agent has no notion of tiers. (#41 v2 prompt-composition fix.)

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

// Unique sentinel from DEFAULT_SYSTEM_PROMPT (default-system-prompt.ts).
const CONTRACT_SENTINEL = "## [Trust]";
const PERSONA = "너는 naia. 테스트 페르소나.";

class NoMemory implements MemoryProvider {
  async encode(): Promise<void> {}
  async recall(): Promise<MemoryHit[]> {
    return [];
  }
  async consolidate() {
    return { factsCreated: 0, factsUpdated: 0, episodesProcessed: 0, durationMs: 0 };
  }
  async close(): Promise<void> {}
}

const MEM_FACT = "사용자 이름은 Alpha";
class OneHitMemory extends NoMemory {
  override async recall(): Promise<MemoryHit[]> {
    return [{ id: "m1", content: MEM_FACT, score: 1, createdAt: Date.now() }];
  }
}

class InspectingMockLLM implements LLMClient {
  systems: string[] = [];
  async generate(): Promise<never> {
    throw new Error("unused");
  }
  async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    this.systems.push(
      typeof request.system === "string" ? request.system : JSON.stringify(request.system ?? ""),
    );
    yield { type: "start", id: "m", model: "m" };
    yield { type: "content_block_start", index: 0, block: { type: "text", text: "ok" } };
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } };
    yield { type: "content_block_stop", index: 0 };
    yield { type: "end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

async function systemSentFor(
  appendDefaultSystemPrompt?: boolean,
  memory: MemoryProvider = new NoMemory(),
): Promise<string> {
  const llm = new InspectingMockLLM();
  const host = createHost({ logLevel: "warn", memory, llm });
  const agent = new Agent({
    host,
    systemPrompt: PERSONA,
    tierForTool: () => "T0",
    ...(appendDefaultSystemPrompt === undefined ? {} : { appendDefaultSystemPrompt }),
  });
  for await (const _ of agent.sendStream("안녕")) void _;
  agent.close();
  return llm.systems[0] ?? "";
}

describe("Agent system-prompt composition (general, default-preserving)", () => {
  it("default (unset) → contract appended AFTER persona (ordering preserved)", async () => {
    const sys = await systemSentFor(undefined);
    expect(sys).toContain(PERSONA);
    expect(sys).toContain(CONTRACT_SENTINEL);
    // Persona must precede the contract (composition order unchanged).
    expect(sys.indexOf(PERSONA)).toBeLessThan(sys.indexOf(CONTRACT_SENTINEL));
  });

  it("appendDefaultSystemPrompt:true → byte-identical to unset default", async () => {
    const unset = await systemSentFor(undefined);
    const explicitTrue = await systemSentFor(true);
    expect(explicitTrue).toBe(unset); // not merely toContain — exact parity
  });

  it("appendDefaultSystemPrompt:false → contract omitted; persona still sent", async () => {
    const sys = await systemSentFor(false);
    expect(sys).toContain(PERSONA);
    expect(sys).not.toContain(CONTRACT_SENTINEL);
  });

  it("opt-out + memory hits → persona + memory block, NO contract, no stray blank", async () => {
    const sys = await systemSentFor(false, new OneHitMemory());
    expect(sys).toContain(PERSONA);
    expect(sys).toContain(`Relevant context from memory:\n- ${MEM_FACT}`);
    expect(sys).not.toContain(CONTRACT_SENTINEL);
    // Composition = persona + memory block joined by exactly "\n\n",
    // no empty segment left where the contract used to be.
    expect(sys).toBe(`${PERSONA}\n\nRelevant context from memory:\n- ${MEM_FACT}`);
  });
});
