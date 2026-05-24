import { describe, it, expect } from "vitest";
import { SessionManager } from "../session-manager.js";
import { ConfigManager } from "../config-manager.js";
import { createDiagnosticsSkill } from "../skills/diagnostics.js";
import { createSessionsSkill } from "../skills/sessions.js";
import { createConfigSkill } from "../skills/config.js";

describe("SessionManager", () => {
  it("creates a session in 'created' state", () => {
    const mgr = new SessionManager();
    const s = mgr.create("test session");
    expect(s.state).toBe("created");
    expect(s.title).toBe("test session");
    expect(s.turnCount).toBe(0);
    expect(s.id).toMatch(/^sess-/);
  });

  it("activates a session and tracks activeId", () => {
    const mgr = new SessionManager();
    const s = mgr.create();
    const activated = mgr.activate(s.id);
    expect(activated.state).toBe("active");
    expect(mgr.activeId()).toBe(s.id);
    expect(mgr.active()?.id).toBe(s.id);
  });

  it("rejects invalid transition created→paused", () => {
    const mgr = new SessionManager();
    const s = mgr.create();
    expect(() => mgr.pause(s.id)).toThrow(/Invalid transition/);
  });

  it("pauses and resumes an active session", () => {
    const mgr = new SessionManager();
    const s = mgr.create();
    mgr.activate(s.id);
    const paused = mgr.pause(s.id);
    expect(paused.state).toBe("paused");
    expect(mgr.activeId()).toBeUndefined();
  });

  it("closes a session and clears activeId", () => {
    const mgr = new SessionManager();
    const s = mgr.create();
    mgr.activate(s.id);
    const closed = mgr.close(s.id);
    expect(closed.state).toBe("closed");
    expect(mgr.activeId()).toBeUndefined();
  });

  it("deletes a session", () => {
    const mgr = new SessionManager();
    const s = mgr.create();
    expect(mgr.delete(s.id)).toBe(true);
    expect(mgr.get(s.id)).toBeUndefined();
  });

  it("updates stats on a session", () => {
    const mgr = new SessionManager();
    const s = mgr.create();
    mgr.updateStats(s.id, { turns: 1, inputTokens: 100, outputTokens: 50, lastUserText: "hi" });
    const updated = mgr.get(s.id);
    expect(updated?.turnCount).toBe(1);
    expect(updated?.totalInputTokens).toBe(100);
    expect(updated?.totalOutputTokens).toBe(50);
    expect(updated?.lastUserText).toBe("hi");
  });

  it("resumes a paused session via activate()", () => {
    const mgr = new SessionManager();
    const s = mgr.create();
    mgr.activate(s.id);
    mgr.pause(s.id);
    expect(mgr.activeId()).toBeUndefined();
    const resumed = mgr.activate(s.id);
    expect(resumed.state).toBe("active");
    expect(mgr.activeId()).toBe(s.id);
  });

  it("handles zero-delta stat updates", () => {
    const mgr = new SessionManager();
    const s = mgr.create();
    mgr.updateStats(s.id, { lastUserText: "hello" });
    mgr.updateStats(s.id, { lastUserText: "" });
    expect(mgr.get(s.id)?.lastUserText).toBe("");
  });

  it("lists all sessions", () => {
    const mgr = new SessionManager();
    mgr.create("a");
    mgr.create("b");
    const all = mgr.list();
    expect(all).toHaveLength(2);
  });

  it("evicts oldest inactive when maxSessions exceeded", () => {
    const mgr = new SessionManager({ maxSessions: 2 });
    const s1 = mgr.create("first");
    mgr.activate(s1.id);
    mgr.create("second");
    mgr.create("third");
    expect(mgr.list()).toHaveLength(2);
    expect(mgr.get(s1.id)).toBeDefined();
  });

  it("throws on double-close (terminal state)", () => {
    const mgr = new SessionManager();
    const s = mgr.create();
    mgr.activate(s.id);
    mgr.close(s.id);
    expect(() => mgr.close(s.id)).toThrow(/Invalid transition/);
  });
});

describe("ConfigManager", () => {
  it("returns default config", () => {
    const mgr = new ConfigManager();
    const cfg = mgr.get() as Record<string, unknown>;
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-sonnet-4-6");
    expect(cfg.contextBudget).toBe(80_000);
  });

  it("merges partial updates", () => {
    const mgr = new ConfigManager();
    const updated = mgr.set({ model: "gpt-4o", provider: "openai" }) as Record<string, unknown>;
    expect(updated.model).toBe("gpt-4o");
    expect(updated.provider).toBe("openai");
    expect(updated.contextBudget).toBe(80_000);
  });

  it("fires onChange when values change", () => {
    const changes: unknown[] = [];
    const mgr = new ConfigManager({ onChange: (c) => changes.push(c) });
    mgr.set({ model: "test" });
    expect(changes).toHaveLength(1);
  });

  it("does NOT fire onChange when values unchanged", () => {
    const changes: unknown[] = [];
    const mgr = new ConfigManager({ onChange: (c) => changes.push(c) });
    mgr.set({ model: "claude-sonnet-4-6" });
    expect(changes).toHaveLength(0);
  });

  it("resets to defaults", () => {
    const mgr = new ConfigManager();
    mgr.set({ model: "other" });
    const reset = mgr.reset() as Record<string, unknown>;
    expect(reset.model).toBe("claude-sonnet-4-6");
  });

  it("accepts initial overrides", () => {
    const mgr = new ConfigManager({ initial: { provider: "ollama", model: "gemma3" } });
    const cfg = mgr.get() as Record<string, unknown>;
    expect(cfg.provider).toBe("ollama");
    expect(cfg.model).toBe("gemma3");
  });
});

describe("diagnostics skill", () => {
  it("returns agent section with session data", () => {
    const sm = new SessionManager();
    const s = sm.create("diag-test");
    sm.activate(s.id);
    sm.updateStats(s.id, { turns: 3, inputTokens: 500, outputTokens: 200 });
    const skill = createDiagnosticsSkill({ sessionManager: sm, startedAt: Date.now() - 60_000 });
    const result = skill.handler({ section: "agent" }) as string;
    const parsed = JSON.parse(result);
    expect(parsed.activeSession.id).toBe(s.id);
    expect(parsed.activeSession.turnCount).toBe(3);
    expect(parsed.uptime).toBeGreaterThanOrEqual(60);
  });

  it("returns system section", () => {
    const skill = createDiagnosticsSkill();
    const result = skill.handler({ section: "system" }) as string;
    const parsed = JSON.parse(result);
    expect(parsed.platform).toBeDefined();
    expect(parsed.memory.heapUsedMB).toBeGreaterThan(0);
    expect(parsed.cpuCount).toBeGreaterThan(0);
  });

  it("returns config section when configManager wired", () => {
    const cm = new ConfigManager({ initial: { provider: "ollama" } });
    const skill = createDiagnosticsSkill({ configManager: cm });
    const result = skill.handler({ section: "config" }) as string;
    const parsed = JSON.parse(result);
    expect(parsed.provider).toBe("ollama");
  });

  it("returns all sections by default", () => {
    const skill = createDiagnosticsSkill();
    const result = skill.handler({}) as string;
    const parsed = JSON.parse(result);
    expect(parsed.agent).toBeDefined();
    expect(parsed.system).toBeDefined();
  });
});

describe("sessions skill", () => {
  it("creates a new session", () => {
    const sm = new SessionManager();
    const skill = createSessionsSkill({ sessionManager: sm });
    const result = JSON.parse(skill.handler({ action: "create", title: "hello" }) as string);
    expect(result.ok).toBe(true);
    expect(result.session.title).toBe("hello");
  });

  it("lists sessions", () => {
    const sm = new SessionManager();
    sm.create("a");
    sm.create("b");
    const skill = createSessionsSkill({ sessionManager: sm });
    const result = JSON.parse(skill.handler({ action: "list" }) as string);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
  });

  it("switches to a session", () => {
    const sm = new SessionManager();
    const s = sm.create();
    const skill = createSessionsSkill({ sessionManager: sm });
    const result = JSON.parse(skill.handler({ action: "switch", sessionId: s.id }) as string);
    expect(result.ok).toBe(true);
    expect(result.session.state).toBe("active");
  });

  it("closes a session", () => {
    const sm = new SessionManager();
    const s = sm.create();
    sm.activate(s.id);
    const skill = createSessionsSkill({ sessionManager: sm });
    const result = JSON.parse(skill.handler({ action: "close", sessionId: s.id }) as string);
    expect(result.ok).toBe(true);
    expect(result.session.state).toBe("closed");
  });

  it("deletes a session", () => {
    const sm = new SessionManager();
    const s = sm.create();
    const skill = createSessionsSkill({ sessionManager: sm });
    const result = JSON.parse(skill.handler({ action: "delete", sessionId: s.id }) as string);
    expect(result.ok).toBe(true);
  });

  it("returns current active session", () => {
    const sm = new SessionManager();
    const skill = createSessionsSkill({ sessionManager: sm });
    const empty = JSON.parse(skill.handler({ action: "current" }) as string);
    expect(empty.session).toBeNull();
    const s = sm.create();
    sm.activate(s.id);
    const active = JSON.parse(skill.handler({ action: "current" }) as string);
    expect(active.session.id).toBe(s.id);
  });

  it("returns error for missing sessionId on switch", () => {
    const sm = new SessionManager();
    const skill = createSessionsSkill({ sessionManager: sm });
    const result = JSON.parse(skill.handler({ action: "switch" }) as string);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("sessionId");
  });
});

describe("config skill", () => {
  it("gets current config", () => {
    const cm = new ConfigManager({ initial: { provider: "ollama", model: "gemma3" } });
    const skill = createConfigSkill({ configManager: cm });
    const result = JSON.parse(skill.handler({ action: "get" }) as string);
    expect(result.ok).toBe(true);
    expect(result.config.provider).toBe("ollama");
    expect(result.config.model).toBe("gemma3");
  });

  it("sets partial config", () => {
    const cm = new ConfigManager();
    const skill = createConfigSkill({ configManager: cm });
    const result = JSON.parse(skill.handler({ action: "set", model: "gpt-4o" }) as string);
    expect(result.ok).toBe(true);
    expect(result.config.model).toBe("gpt-4o");
    expect(result.config.provider).toBe("anthropic");
  });

  it("resets config to defaults", () => {
    const cm = new ConfigManager();
    cm.set({ model: "other" });
    const skill = createConfigSkill({ configManager: cm });
    const result = JSON.parse(skill.handler({ action: "reset" }) as string);
    expect(result.ok).toBe(true);
    expect(result.config.model).toBe("claude-sonnet-4-6");
  });
});
