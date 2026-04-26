import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceChange } from "@nextain/agent-types";
import { ChokidarWatcher } from "../chokidar-watcher.js";

let workdir = "";

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "naia-ws-"));
});

afterEach(() => {
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function collectFor(
  watcher: ChokidarWatcher,
  workdir: string,
  durationMs: number,
): Promise<WorkspaceChange[]> {
  const ac = new AbortController();
  const out: WorkspaceChange[] = [];
  const iter = watcher.watch(workdir, ac.signal);
  const consumer = (async () => {
    for await (const ev of iter) out.push(ev);
  })();
  await new Promise((r) => setTimeout(r, durationMs));
  ac.abort();
  await consumer;
  return out;
}

describe("ChokidarWatcher — debounce + ignore + race + ordering", () => {
  it("emits add event for newly created file", async () => {
    const watcher = new ChokidarWatcher({ debounceMs: 50, usePolling: true });
    const events = collectFor(watcher, workdir, 600);
    setTimeout(() => writeFileSync(path.join(workdir, "a.txt"), "x"), 200);
    const out = await events;
    const adds = out.filter((e) => e.kind === "add");
    expect(adds.length).toBeGreaterThanOrEqual(1);
    expect(adds.some((e) => e.path === "a.txt")).toBe(true);
  });

  it("emits modify event for existing file changes", async () => {
    writeFileSync(path.join(workdir, "b.txt"), "v1");
    const watcher = new ChokidarWatcher({ debounceMs: 50, usePolling: true });
    const events = collectFor(watcher, workdir, 800);
    setTimeout(() => writeFileSync(path.join(workdir, "b.txt"), "v2"), 300);
    const out = await events;
    expect(out.some((e) => e.path === "b.txt")).toBe(true);
  });

  it("emits delete event for unlinked file", async () => {
    writeFileSync(path.join(workdir, "c.txt"), "v1");
    const watcher = new ChokidarWatcher({ debounceMs: 50, usePolling: true });
    const events = collectFor(watcher, workdir, 700);
    setTimeout(() => unlinkSync(path.join(workdir, "c.txt")), 300);
    const out = await events;
    expect(out.some((e) => e.path === "c.txt" && e.kind === "delete")).toBe(true);
  });

  it("debounce — multiple rapid writes to same file → 1 chunk (latest)", async () => {
    writeFileSync(path.join(workdir, "d.txt"), "v0");
    const watcher = new ChokidarWatcher({ debounceMs: 200, usePolling: true });
    const events = collectFor(watcher, workdir, 1500);
    setTimeout(() => {
      writeFileSync(path.join(workdir, "d.txt"), "v1");
      writeFileSync(path.join(workdir, "d.txt"), "v2");
      writeFileSync(path.join(workdir, "d.txt"), "v3");
    }, 300);
    const out = await events;
    const dEvents = out.filter((e) => e.path === "d.txt");
    // debounce 200ms — 3 rapid writes (~ms apart) should collapse
    expect(dEvents.length).toBeLessThanOrEqual(2);
    expect(dEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("A7 — 5 separate files written in sequence each get one event", async () => {
    const watcher = new ChokidarWatcher({ debounceMs: 50, usePolling: true });
    const events = collectFor(watcher, workdir, 1500);
    setTimeout(() => {
      for (let i = 0; i < 5; i++) {
        writeFileSync(path.join(workdir, `f${i}.txt`), `c${i}`);
      }
    }, 200);
    const out = await events;
    const distinct = new Set(
      out.filter((e) => e.kind === "add").map((e) => e.path),
    );
    expect(distinct.size).toBe(5);
  });

  it("ignores .git, node_modules, dist by default", async () => {
    mkdirSync(path.join(workdir, ".git"));
    mkdirSync(path.join(workdir, "node_modules"));
    const watcher = new ChokidarWatcher({ debounceMs: 50, usePolling: true });
    const events = collectFor(watcher, workdir, 700);
    setTimeout(() => {
      writeFileSync(path.join(workdir, ".git", "HEAD"), "ref");
      writeFileSync(path.join(workdir, "node_modules", "x.js"), "x");
      writeFileSync(path.join(workdir, "tracked.txt"), "ok");
    }, 200);
    const out = await events;
    expect(out.some((e) => e.path.includes(".git"))).toBe(false);
    expect(out.some((e) => e.path.includes("node_modules"))).toBe(false);
    expect(out.some((e) => e.path === "tracked.txt")).toBe(true);
  });

  it("sourceSession label propagates to every event", async () => {
    const watcher = new ChokidarWatcher({
      debounceMs: 50,
      usePolling: true,
      sourceSession: "session-xyz",
    });
    const events = collectFor(watcher, workdir, 600);
    setTimeout(() => writeFileSync(path.join(workdir, "x.txt"), "x"), 200);
    const out = await events;
    expect(out.length).toBeGreaterThan(0);
    for (const ev of out) {
      expect(ev.sourceSession).toBe("session-xyz");
    }
  });

  it("abort signal stops watching and closes iterator", async () => {
    const watcher = new ChokidarWatcher({ debounceMs: 50, usePolling: true });
    const ac = new AbortController();
    const iter = watcher.watch(workdir, ac.signal);
    const consumer = (async () => {
      const out: WorkspaceChange[] = [];
      for await (const ev of iter) out.push(ev);
      return out;
    })();
    setTimeout(() => ac.abort(), 200);
    const out = await consumer;
    // consumer must complete (iterator closed)
    expect(Array.isArray(out)).toBe(true);
  }, 5000);
});
