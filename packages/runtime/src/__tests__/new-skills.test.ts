import { describe, it, expect, afterEach } from "vitest";
import { createTimeSkill } from "../skills/time.js";
import { createWeatherSkill } from "../skills/weather.js";
import { createMemoSkill } from "../skills/memo.js";
import { createSystemStatusSkill } from "../skills/system-status.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("createTimeSkill", () => {
  it("returns InMemoryToolDef with correct shape", () => {
    const skill = createTimeSkill();
    expect(skill.name).toBe("time");
    expect(skill.description).toContain("date and time");
    expect(skill.inputSchema).toBeDefined();
    expect(skill.tier).toBe("T0");
    expect(typeof skill.handler).toBe("function");
  });

  it("returns locale-formatted time by default", () => {
    const skill = createTimeSkill();
    const result = skill.handler({});
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns unix timestamp", () => {
    const skill = createTimeSkill();
    const result = skill.handler({ format: "unix" });
    expect(result).toMatch(/^\d+$/);
    const ts = Number(result);
    expect(ts).toBeGreaterThan(1_700_000_000);
  });

  it("returns ISO 8601 format", () => {
    const skill = createTimeSkill();
    const result = skill.handler({ format: "iso" });
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("returns ISO with timezone offset", () => {
    const skill = createTimeSkill();
    const result = skill.handler({ format: "iso", timezone: "Asia/Seoul" });
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("respects custom tier", () => {
    const skill = createTimeSkill({ tier: "T1" });
    expect(skill.tier).toBe("T1");
  });
});

describe("createWeatherSkill", () => {
  it("returns InMemoryToolDef with correct shape", () => {
    const skill = createWeatherSkill();
    expect(skill.name).toBe("weather");
    expect(skill.description).toContain("weather");
    expect(skill.inputSchema).toBeDefined();
    expect(skill.tier).toBe("T0");
    expect(typeof skill.handler).toBe("function");
  });

  it("returns ERROR for missing location", async () => {
    const skill = createWeatherSkill();
    const result = await skill.handler({});
    expect(result).toMatch(/^ERROR:/);
  });

  it("returns ERROR for empty location", async () => {
    const skill = createWeatherSkill();
    const result = await skill.handler({ location: "  " });
    expect(result).toMatch(/^ERROR:/);
  });
});

describe("createMemoSkill", () => {
  const testDir = path.join(os.tmpdir(), `naia-memo-test-${Date.now()}`);

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("returns InMemoryToolDef with correct shape", () => {
    const skill = createMemoSkill({ memoDir: testDir });
    expect(skill.name).toBe("memo");
    expect(skill.description).toContain("memo");
    expect(skill.inputSchema).toBeDefined();
    expect(skill.tier).toBe("T1");
    expect(typeof skill.handler).toBe("function");
  });

  it("saves and reads a memo", () => {
    const skill = createMemoSkill({ memoDir: testDir });
    const saveResult = skill.handler({
      action: "save",
      key: "test-key",
      content: "hello world",
    });
    expect(saveResult).toBe("Memo saved: test-key");

    const readResult = skill.handler({ action: "read", key: "test-key" });
    expect(readResult).toBe("hello world");
  });

  it("lists memos", () => {
    const skill = createMemoSkill({ memoDir: testDir });
    skill.handler({ action: "save", key: "alpha", content: "a" });
    skill.handler({ action: "save", key: "beta", content: "b" });

    const result = skill.handler({ action: "list" });
    const keys = JSON.parse(result as string);
    expect(keys).toContain("alpha");
    expect(keys).toContain("beta");
  });

  it("deletes a memo", () => {
    const skill = createMemoSkill({ memoDir: testDir });
    skill.handler({ action: "save", key: "temp", content: "x" });
    const delResult = skill.handler({ action: "delete", key: "temp" });
    expect(delResult).toBe("Memo deleted: temp");

    const readResult = skill.handler({ action: "read", key: "temp" });
    expect(readResult).toMatch(/^ERROR:/);
  });

  it("returns ERROR for read on nonexistent key", () => {
    const skill = createMemoSkill({ memoDir: testDir });
    const result = skill.handler({ action: "read", key: "nope" });
    expect(result).toMatch(/^ERROR:/);
  });

  it("returns ERROR for save without key", () => {
    const skill = createMemoSkill({ memoDir: testDir });
    const result = skill.handler({ action: "save", content: "x" });
    expect(result).toMatch(/^ERROR:/);
  });

  it("returns ERROR for unknown action", () => {
    const skill = createMemoSkill({ memoDir: testDir });
    const result = skill.handler({ action: "bogus" });
    expect(result).toMatch(/^ERROR:/);
  });

  it("returns empty list for nonexistent directory", () => {
    const emptyDir = path.join(os.tmpdir(), `naia-memo-empty-${Date.now()}`);
    const skill = createMemoSkill({ memoDir: emptyDir });
    const result = skill.handler({ action: "list" });
    expect(result).toBe("[]");
  });

  it("sanitizes key with special characters", () => {
    const skill = createMemoSkill({ memoDir: testDir });
    skill.handler({ action: "save", key: "a/b:c", content: "sanitized" });
    const result = skill.handler({ action: "read", key: "a/b:c" });
    expect(result).toBe("sanitized");
  });
});

describe("createSystemStatusSkill", () => {
  it("returns InMemoryToolDef with correct shape", () => {
    const skill = createSystemStatusSkill();
    expect(skill.name).toBe("system_status");
    expect(skill.description).toContain("system");
    expect(skill.inputSchema).toBeDefined();
    expect(skill.tier).toBe("T0");
    expect(typeof skill.handler).toBe("function");
  });

  it("returns all system info by default", () => {
    const skill = createSystemStatusSkill();
    const result = JSON.parse(skill.handler({}) as string);
    expect(result.os).toBeDefined();
    expect(result.memory).toBeDefined();
    expect(result.cpus).toBeDefined();
    expect(result.uptime).toBeGreaterThanOrEqual(0);
  });

  it("returns memory section only", () => {
    const skill = createSystemStatusSkill();
    const result = JSON.parse(
      skill.handler({ section: "memory" }) as string,
    );
    expect(result.totalMB).toBeGreaterThan(0);
    expect(result.freeMB).toBeGreaterThanOrEqual(0);
    expect(result.usedMB).toBeGreaterThanOrEqual(0);
  });

  it("returns cpu section only", () => {
    const skill = createSystemStatusSkill();
    const result = JSON.parse(skill.handler({ section: "cpu" }) as string);
    expect(result.count).toBeGreaterThan(0);
    expect(typeof result.model).toBe("string");
  });

  it("returns os section only", () => {
    const skill = createSystemStatusSkill();
    const result = JSON.parse(skill.handler({ section: "os" }) as string);
    expect(typeof result.platform).toBe("string");
    expect(typeof result.arch).toBe("string");
  });

  it("respects custom tier", () => {
    const skill = createSystemStatusSkill({ tier: "T2" });
    expect(skill.tier).toBe("T2");
  });
});
