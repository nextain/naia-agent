// 8G LLM-initiated text-marker recall — Agent loop (#41 v2, core 625b436).
// Verifies: <recall>q</recall> → memory.recall(q) → re-generate; depth guard
// caps recall hops; leftover marker stripped; non-marker turn unaffected.
// Reuses createHost({memory, mockScript}) — same harness as create-host.test.ts.

import { describe, it, expect } from "vitest";
import { Agent } from "@nextain/agent-core";
import type { MemoryProvider, MemoryHit } from "@nextain/agent-types";
import { createHost } from "../host/create-host.js";

/** Recording MemoryProvider — counts recall() calls + captures queries. */
class RecordingMemory implements MemoryProvider {
  calls: string[] = [];
  async encode(): Promise<void> {}
  async recall(query: string): Promise<MemoryHit[]> {
    this.calls.push(query);
    return [{ id: "m1", content: "사용자 이름은 Alpha", score: 1, createdAt: Date.now() }];
  }
  async consolidate() {
    return { factsCreated: 0, factsUpdated: 0, episodesProcessed: 0, durationMs: 0 };
  }
  async close(): Promise<void> {}
}

async function runAgent(memory: RecordingMemory, turns: { blocks: string }[]) {
  const host = createHost({
    logLevel: "warn",
    memory,
    mockScript: { turns: turns.map((t) => ({ blocks: t.blocks, stopReason: "end_turn" as const })) },
  });
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
  it("emits <recall> → memory.recall(parsed query) → re-generates, marker stripped", async () => {
    const mem = new RecordingMemory();
    const { assistantText, ended } = await runAgent(mem, [
      { blocks: "<recall>내 이름</recall>" },
      { blocks: "당신의 이름은 Alpha 입니다." },
    ]);
    // 1 start-of-turn recall + 1 marker-driven recall.
    expect(mem.calls).toContain("내 이름");
    expect(mem.calls.length).toBe(2);
    expect(assistantText).toBe("당신의 이름은 Alpha 입니다.");
    expect(assistantText).not.toContain("<recall>");
    expect(ended).toBe(1);
  });

  it("depth guard: caps marker-driven recalls at 2; leftover marker stripped", async () => {
    const mem = new RecordingMemory();
    const { assistantText } = await runAgent(mem, [
      { blocks: "<recall>q1</recall>" },
      { blocks: "<recall>q2</recall>" },
      { blocks: "<recall>q3</recall>" }, // 3rd marker — budget exhausted
      { blocks: "fallback answer" }, // not reached (budget hit on turn 3)
    ]);
    // 1 start + exactly 2 marker recalls (q1, q2); q3 not actioned.
    expect(mem.calls).toEqual(["내 이름이 뭐였지?", "q1", "q2"]);
    // turn-3 raw marker must NOT leak to user.
    expect(assistantText).not.toContain("<recall>");
  });

  it("regression: no marker → no extra recall, text unchanged", async () => {
    const mem = new RecordingMemory();
    const { assistantText } = await runAgent(mem, [{ blocks: "평범한 답변입니다." }]);
    expect(mem.calls.length).toBe(1); // start-of-turn recall only
    expect(assistantText).toBe("평범한 답변입니다.");
  });
});
