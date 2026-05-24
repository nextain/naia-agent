import { describe, it, expect } from "vitest";
import {
  SystemPromptBuilder,
} from "@nextain/agent-core";
import type { PromptFragment } from "@nextain/agent-core";

describe("SystemPromptBuilder", () => {
  it("returns empty string with no fragments", () => {
    const builder = new SystemPromptBuilder();
    expect(builder.build()).toBe("");
    expect(builder.fragments).toHaveLength(0);
  });

  it("returns single fragment content", () => {
    const builder = new SystemPromptBuilder();
    builder.add({ source: "core", priority: 100, section: "safety", content: "be safe" });
    expect(builder.build()).toBe("be safe");
  });

  it("joins multiple fragments with double newline", () => {
    const builder = new SystemPromptBuilder();
    builder.add({ source: "core", priority: 100, section: "identity", content: "A" });
    builder.add({ source: "core", priority: 200, section: "safety", content: "B" });
    expect(builder.build()).toBe("A\n\nB");
  });

  it("sorts by priority ascending", () => {
    const builder = new SystemPromptBuilder();
    builder.add({ source: "core", priority: 300, section: "memory", content: "C" });
    builder.add({ source: "core", priority: 100, section: "identity", content: "A" });
    builder.add({ source: "core", priority: 200, section: "safety", content: "B" });
    expect(builder.build()).toBe("A\n\nB\n\nC");
  });

  it("breaks ties by section name", () => {
    const builder = new SystemPromptBuilder();
    builder.add({ source: "core", priority: 100, section: "safety", content: "B" });
    builder.add({ source: "core", priority: 100, section: "identity", content: "A" });
    expect(builder.build()).toBe("A\n\nB");
  });

  it("preserves insertion order for same priority+section", () => {
    const builder = new SystemPromptBuilder();
    builder.add({ source: "core", priority: 100, section: "identity", content: "first" });
    builder.add({ source: "host", priority: 100, section: "identity", content: "second" });
    expect(builder.build()).toBe("first\n\nsecond");
  });

  it("tracks all added fragments", () => {
    const builder = new SystemPromptBuilder();
    builder.add({ source: "core", priority: 100, section: "identity", content: "A" });
    builder.add({ source: "host", priority: 200, section: "domain", content: "B" });
    expect(builder.fragments).toHaveLength(2);
    expect(builder.fragments[0].source).toBe("core");
    expect(builder.fragments[1].source).toBe("host");
  });

  it("simulates real agent composition: persona + contract + handoff + memory", () => {
    const builder = new SystemPromptBuilder();
    builder.add({ source: "host", priority: 100, section: "identity", content: "You are Naia." });
    builder.add({ source: "core", priority: 200, section: "safety", content: "## [Trust]\nBe honest." });
    builder.add({ source: "core", priority: 300, section: "handoff", content: "Prior session recap:\nWe talked about X." });
    builder.add({ source: "core", priority: 400, section: "memory", content: "Relevant context from memory:\n- User likes coffee" });

    const result = builder.build();
    const idxPersona = result.indexOf("You are Naia.");
    const idxTrust = result.indexOf("## [Trust]");
    const idxHandoff = result.indexOf("Prior session recap:");
    const idxMemory = result.indexOf("Relevant context from memory:");

    expect(idxPersona).toBeLessThan(idxTrust);
    expect(idxTrust).toBeLessThan(idxHandoff);
    expect(idxHandoff).toBeLessThan(idxMemory);
  });
});
