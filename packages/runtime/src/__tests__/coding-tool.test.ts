// Unit tests for createCodingSkill (Slice 3, #22).
// G15: fixture-only — no real LLM calls. Dynamic imports mocked via vi.mock.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCodingSkill } from "../skills/coding-tool.js";

// ---------------------------------------------------------------------------
// Shape tests — no mock needed
// ---------------------------------------------------------------------------
describe("createCodingSkill — shape", () => {
  it("returns an InMemoryToolDef with name 'code'", () => {
    const skill = createCodingSkill();
    expect(skill.name).toBe("code");
  });

  it("has tier T2 by default", () => {
    const skill = createCodingSkill();
    expect(skill.tier).toBe("T2");
  });

  it("respects tier override", () => {
    const skill = createCodingSkill({ tier: "T3" });
    expect(skill.tier).toBe("T3");
  });

  it("is destructive and not concurrency-safe", () => {
    const skill = createCodingSkill();
    expect(skill.isDestructive).toBe(true);
    expect(skill.isConcurrencySafe).toBe(false);
  });

  it("inputSchema requires 'task' string", () => {
    const skill = createCodingSkill();
    const schema = skill.inputSchema as {
      required: string[];
      properties: Record<string, { type: string }>;
    };
    expect(schema.required).toContain("task");
    expect(schema.properties["task"].type).toBe("string");
  });

  it("inputSchema has optional 'workdir' string", () => {
    const skill = createCodingSkill();
    const schema = skill.inputSchema as {
      properties: Record<string, { type: string }>;
    };
    expect(schema.properties["workdir"].type).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Handler tests — mock dynamic imports
// ---------------------------------------------------------------------------
describe("createCodingSkill — handler", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns ERROR on empty task", async () => {
    const skill = createCodingSkill();
    const result = await skill.handler({ task: "   " });
    expect(result).toMatch(/ERROR.*non-empty/i);
  });

  it("returns ERROR on missing task", async () => {
    const skill = createCodingSkill();
    const result = await skill.handler({});
    expect(result).toMatch(/ERROR.*non-empty/i);
  });

  it("calls VercelClient.generate and returns text", async () => {
    const mockGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Done: added hello world." }],
    });
    const MockVercelClient = vi.fn().mockImplementation(() => ({
      generate: mockGenerate,
    }));
    const mockModel = {};
    const mockProvider = vi.fn().mockReturnValue(mockModel);
    const mockCreateClaudeCode = vi.fn().mockReturnValue(mockProvider);

    vi.doMock("ai-sdk-provider-claude-code", () => ({
      createClaudeCode: mockCreateClaudeCode,
    }));
    vi.doMock("@nextain/agent-providers", () => ({
      VercelClient: MockVercelClient,
    }));

    const { createCodingSkill: createFresh } = await import(
      "../skills/coding-tool.js"
    );
    const skill = createFresh();
    const result = await skill.handler({ task: "Add hello world to main.ts" });

    expect(result).toBe("Done: added hello world.");
    expect(mockGenerate).toHaveBeenCalledOnce();
    const call = mockGenerate.mock.calls[0][0] as {
      messages: { role: string; content: { text: string }[] }[];
    };
    expect(call.messages[0].role).toBe("user");
    expect(call.messages[0].content[0].text).toContain(
      "Add hello world to main.ts"
    );
  });

  it("truncates output exceeding maxOutputBytes", async () => {
    const longText = "x".repeat(100);
    const mockGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: longText }],
    });
    const MockVercelClient = vi.fn().mockImplementation(() => ({
      generate: mockGenerate,
    }));
    const mockProvider = vi.fn().mockReturnValue({});
    vi.doMock("ai-sdk-provider-claude-code", () => ({
      createClaudeCode: vi.fn().mockReturnValue(mockProvider),
    }));
    vi.doMock("@nextain/agent-providers", () => ({
      VercelClient: MockVercelClient,
    }));

    const { createCodingSkill: createFresh } = await import(
      "../skills/coding-tool.js"
    );
    const skill = createFresh({ maxOutputBytes: 20 });
    const result = (await skill.handler({ task: "do something" })) as string;

    expect(result.length).toBeGreaterThan(20);
    expect(result).toContain("[truncated to 20 bytes]");
    expect(result.startsWith("x".repeat(20))).toBe(true);
  });

  it("returns '[no output]' when generate returns empty text", async () => {
    const mockGenerate = vi.fn().mockResolvedValue({ content: [] });
    const MockVercelClient = vi.fn().mockImplementation(() => ({
      generate: mockGenerate,
    }));
    const mockProvider = vi.fn().mockReturnValue({});
    vi.doMock("ai-sdk-provider-claude-code", () => ({
      createClaudeCode: vi.fn().mockReturnValue(mockProvider),
    }));
    vi.doMock("@nextain/agent-providers", () => ({
      VercelClient: MockVercelClient,
    }));

    const { createCodingSkill: createFresh } = await import(
      "../skills/coding-tool.js"
    );
    const skill = createFresh();
    const result = await skill.handler({ task: "do something" });
    expect(result).toBe("[no output]");
  });

  it("returns ERROR message when provider import throws", async () => {
    vi.doMock("ai-sdk-provider-claude-code", () => {
      throw new Error("Module not found");
    });

    const { createCodingSkill: createFresh } = await import(
      "../skills/coding-tool.js"
    );
    const skill = createFresh();
    const result = (await skill.handler({ task: "do something" })) as string;
    expect(result).toMatch(/ERROR.*coding-tool failed/i);
  });
});
