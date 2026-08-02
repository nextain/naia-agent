import { describe, expect, it } from "vitest";
import { makeReloadableMemory, type ReloadableMemoryDelegate } from "../main/adapters/reloadable-memory.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function memory(name: string, events: string[], recallGate?: Promise<void>): ReloadableMemoryDelegate {
  return {
    async recall() {
      events.push(`${name}:recall:start`);
      if (recallGate) await recallGate;
      events.push(`${name}:recall:end`);
      return { facts: [name], episodes: [] };
    },
    async save() { events.push(`${name}:save`); },
    async compact() { return { recap: name, droppedCount: 1 }; },
    async attachHandoff() { events.push(`${name}:handoff`); },
    async flush() { events.push(`${name}:flush`); },
    async close() { events.push(`${name}:close`); },
  };
}

describe("reloadable memory", () => {
  it("waits for in-flight calls, flushes the old backend, then swaps and closes it", async () => {
    const events: string[] = [];
    const gate = deferred<void>();
    const port = makeReloadableMemory(memory("old", events, gate.promise));
    const recall = port.recall("query");
    await Promise.resolve();

    const reload = port.reconfigure(async () => {
      events.push("build:new");
      return memory("new", events);
    });
    await Promise.resolve();
    expect(events).toEqual(["old:recall:start"]);

    gate.resolve();
    await recall;
    await expect(reload).resolves.toMatchObject({ replaced: true });
    expect(events).toEqual([
      "old:recall:start",
      "old:recall:end",
      "old:flush",
      "build:new",
      "old:close",
    ]);
    await expect(port.recall("next")).resolves.toMatchObject({ facts: ["new"] });
    await port.close();
  });

  it("retains the active backend when constructing the replacement fails", async () => {
    const events: string[] = [];
    const port = makeReloadableMemory(memory("old", events));
    await expect(port.reconfigure(async () => {
      throw new Error("invalid memory role");
    })).rejects.toThrow("invalid memory role");

    expect(port.hasActive()).toBe(true);
    await expect(port.recall("still there")).resolves.toMatchObject({ facts: ["old"] });
    expect(events).not.toContain("old:close");
    await port.close();
  });
});
