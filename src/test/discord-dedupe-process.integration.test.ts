import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type * as DedupeModule from "../main/adapters/discord-dedupe-store.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const helper = join(root, "src", "test", "fixtures", "discord-dedupe-process.mjs");
let production: typeof DedupeModule;

interface RunningChild {
  readonly child: ChildProcess;
  readonly readyPath: string;
  readonly result: Promise<unknown>;
}

function runChild(
  directory: string,
  path: string,
  barrierPath: string,
  name: string,
  action: "reserve" | "old_reply" | "resume_reply",
  messageId: string,
): RunningChild {
  const readyPath = join(directory, `${name}.ready`);
  const child = spawn(process.execPath, [helper, path, action, readyPath, barrierPath, "binding_1", messageId, "100"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = new Promise<unknown>((resolveResult, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`dedupe child ${name} completion timeout`));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`dedupe child ${name} exited ${code}: ${stderr}`));
      else {
        try { resolveResult(JSON.parse(stdout.trim())); } catch (error) { reject(error); }
      }
    });
  });
  return { child, readyPath, result };
}

async function waitForFiles(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (paths.some((path) => {
    try { readFileSync(path); return false; } catch { return true; }
  })) {
    if (Date.now() > deadline) throw new Error("dedupe child readiness timeout");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
  }
}

describe("Discord dedupe real-process transaction boundaries", () => {
  beforeAll(async () => {
    const built = spawnSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], {
      cwd: root, encoding: "utf8", timeout: 120_000,
    });
    if (built.status !== 0) throw new Error(`dist build failed: ${built.stderr || built.stdout}`);
    production = (await import(pathToFileURL(join(root, "dist", "main", "adapters", "discord-dedupe-store.js")).href)) as typeof DedupeModule;
  }, 130_000);

  const directories: string[] = [];
  const children: ChildProcess[] = [];
  afterEach(async () => {
    const active = children.splice(0);
    await Promise.all(active.map((child) => new Promise<void>((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolveExit(); return; }
      const onExit = () => resolveExit();
      child.once("exit", onExit);
      if (child.exitCode !== null || child.signalCode !== null) {
        child.off("exit", onExit);
        resolveExit();
        return;
      }
      child.kill("SIGKILL");
    })));
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("admits exactly one same-key winner across synchronized processes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "naia-dedupe-proc-"));
    directories.push(directory);
    const path = join(directory, "dedupe.json");
    const barrier = join(directory, "go");
    const first = runChild(directory, path, barrier, "first", "reserve", "same");
    children.push(first.child);
    await waitForFiles([first.readyPath]);
    const second = runChild(directory, path, barrier, "second", "reserve", "same");
    children.push(second.child);
    await waitForFiles([second.readyPath]);
    writeFileSync(barrier, "go");
    const results = await Promise.all([first.result, second.result]);
    expect(results).toEqual(expect.arrayContaining([{ decision: "process" }, { decision: "duplicate" }]));
  });

  it("preserves unrelated reservations across a synchronized interleave", async () => {
    const directory = mkdtempSync(join(tmpdir(), "naia-dedupe-proc-"));
    directories.push(directory);
    const path = join(directory, "dedupe.json");
    const firstBarrier = join(directory, "go-first");
    const secondBarrier = join(directory, "go-second");
    const first = runChild(directory, path, firstBarrier, "first", "reserve", "one");
    children.push(first.child);
    await waitForFiles([first.readyPath]);
    const second = runChild(directory, path, secondBarrier, "second", "reserve", "two");
    children.push(second.child);
    await waitForFiles([second.readyPath]);
    writeFileSync(firstBarrier, "go");
    expect(await first.result).toEqual({ decision: "process" });
    writeFileSync(secondBarrier, "go");
    expect(await second.result).toEqual({ decision: "process" });
    const ids = JSON.parse(readFileSync(path, "utf8")).entries.map((entry: { messageId: string }) => entry.messageId);
    expect(ids.sort()).toEqual(["one", "two"]);
  });

  it("rotates reply ownership and fences the old process after handoff", async () => {
    const directory = mkdtempSync(join(tmpdir(), "naia-dedupe-proc-"));
    directories.push(directory);
    const path = join(directory, "dedupe.json");
    const oldBarrier = join(directory, "go-old");
    const nextBarrier = join(directory, "go-next");
    const oldProcess = runChild(directory, path, oldBarrier, "old", "old_reply", "reply");
    children.push(oldProcess.child);
    await waitForFiles([oldProcess.readyPath]);
    const nextProcess = runChild(directory, path, nextBarrier, "next", "resume_reply", "reply");
    children.push(nextProcess.child);
    await waitForFiles([nextProcess.readyPath]);
    writeFileSync(oldBarrier, "go");
    expect(await oldProcess.result).toEqual({ partial: false, claim: false });
    writeFileSync(nextBarrier, "go");
    expect(await nextProcess.result).toEqual({
      reservation: { decision: "resume_reply", chunks: ["one", "two"], nextChunk: 1 },
      claim: true,
    });
  });

  it("repairs only a dead serialized owner and refuses a live lock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "naia-dedupe-proc-"));
    directories.push(directory);
    const path = join(directory, "dedupe.json");
    const lockPath = `${path}.lock`;
    const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    children.push(live);
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: live.pid, token: "live_owner" }));
    expect(production.repairFileDiscordDedupeLock(path)).toBe(false);
    expect(() => production.makeFileDiscordDedupe({ path })).toThrow("DISCORD_DEDUPE_BUSY");

    const liveExited = new Promise<void>((resolveExit) => live.once("exit", () => resolveExit()));
    live.kill("SIGKILL");
    await liveExited;
    expect(production.repairFileDiscordDedupeLock(path)).toBe(true);
    expect(() => production.makeFileDiscordDedupe({ path })).not.toThrow();
  });
});
