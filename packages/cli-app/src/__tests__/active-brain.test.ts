import { describe, expect, it } from "vitest";
import type { SpikeEvent } from "@nextain/agent-types";
import { ActiveBrain } from "../active-brain.js";

function makeEvent(overrides: Partial<SpikeEvent> = {}): SpikeEvent {
  return {
    factId: "f1",
    content: "사용자가 이직을 고민 중이라고 했다",
    reason: "high-importance-relevant",
    confidence: 0.8,
    relatedFactIds: ["f0"],
    emittedAt: Date.now(),
    ...overrides,
  };
}

describe("ActiveBrain — Slice 6A rule-based source monitor", () => {
  it("skips cross-project spike (scope partition)", async () => {
    const brain = new ActiveBrain({
      activeContext: {
        topics: ["이직"],
        recentFactIds: [],
        scope: { project: "naia-os" },
      },
      log: () => {},
    });
    const action = await brain.handle(
      makeEvent({ scope: { project: "naia-agent" } }),
    );
    expect(action).toBeDefined();
    expect((action as { decision: string }).decision).toBe("skip");
    expect((action as { reason: string }).reason).toContain("cross-project");
  });

  it("skips when confidence below threshold", async () => {
    const brain = new ActiveBrain({
      activeContext: {
        topics: ["이직"],
        recentFactIds: [],
        scope: { project: "p" },
      },
      log: () => {},
      minConfidence: 0.7,
    });
    const action = await brain.handle(makeEvent({ confidence: 0.5 }));
    expect((action as { decision: string }).decision).toBe("skip");
    expect((action as { reason: string }).reason).toContain("confidence");
  });

  it("skips opt-out topic match", async () => {
    const brain = new ActiveBrain({
      activeContext: {
        topics: ["이직"],
        recentFactIds: [],
        scope: { project: "p" },
        optOutTopics: ["연봉"],
      },
      log: () => {},
    });
    const action = await brain.handle(
      makeEvent({ content: "연봉 협상이 어렵다" }),
    );
    expect((action as { decision: string }).decision).toBe("skip");
    expect((action as { reason: string }).reason).toContain("opt-out");
  });

  it("injects when topic matches in content", async () => {
    const logs: string[] = [];
    const brain = new ActiveBrain({
      activeContext: {
        topics: ["이직"],
        recentFactIds: [],
        scope: { project: "p" },
      },
      log: (m) => logs.push(m),
    });
    const action = await brain.handle(makeEvent());
    expect((action as { decision: string }).decision).toBe("inject-next-turn");
    expect((action as { reason: string }).reason).toContain("match=topic");
    expect(logs.some((l) => l.includes("[active-brain]"))).toBe(true);
  });

  it("injects when recentFactIds intersects relatedFactIds", async () => {
    const brain = new ActiveBrain({
      activeContext: {
        topics: ["연봉"],
        recentFactIds: ["f0"],
        scope: { project: "p" },
      },
      log: () => {},
    });
    const action = await brain.handle(makeEvent());
    expect((action as { decision: string }).decision).toBe("inject-next-turn");
    expect((action as { reason: string }).reason).toContain("recent");
  });

  it("skips when neither topic nor recent matches", async () => {
    const brain = new ActiveBrain({
      activeContext: {
        topics: ["연봉"],
        recentFactIds: ["fX"],
        scope: { project: "p" },
      },
      log: () => {},
    });
    const action = await brain.handle(makeEvent());
    expect((action as { decision: string }).decision).toBe("skip");
    expect((action as { reason: string }).reason).toContain("no topic");
  });

  it("setActiveContext switches the active context", async () => {
    const brain = new ActiveBrain({
      activeContext: {
        topics: ["연봉"],
        recentFactIds: [],
        scope: { project: "p" },
      },
      log: () => {},
    });
    expect((await brain.handle(makeEvent()))?.decision).toBe("skip");
    brain.setActiveContext({
      topics: ["이직"],
      recentFactIds: [],
      scope: { project: "p" },
    });
    expect((await brain.handle(makeEvent()))?.decision).toBe(
      "inject-next-turn",
    );
  });

  it("matches topic case-insensitively", async () => {
    const brain = new ActiveBrain({
      activeContext: {
        topics: ["JOB"],
        recentFactIds: [],
        scope: { project: "p" },
      },
      log: () => {},
    });
    const action = await brain.handle(
      makeEvent({ content: "Looking for a new job" }),
    );
    expect((action as { decision: string }).decision).toBe("inject-next-turn");
  });
});
