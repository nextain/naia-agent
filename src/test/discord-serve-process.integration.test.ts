import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
const children = new Set<ChildProcess>();

function testDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "naia-serve-process-"));
  dirs.push(path);
  return path;
}

function writeGatewayPreload(directory: string): string {
  const path = join(directory, "fake-discord-gateway.mjs");
  writeFileSync(path, `
class FakeSocket {
  readyState = 1;
  listeners = new Map();
  constructor() {
    queueMicrotask(() => {
      this.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 120000 } }) });
      this.emit("message", { data: JSON.stringify({ op: 0, t: "READY", d: { user: { id: "999" } } }) });
    });
  }
  send() {}
  close(code = 1000) { this.readyState = 3; this.emit("close", { code }); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
globalThis.WebSocket = FakeSocket;
globalThis.fetch = async (input) => {
  if (String(input).endsWith("/gateway/bot")) {
    return new Response(JSON.stringify({ url: "wss://fake-discord.invalid" }), { status: 200 });
  }
  throw new Error("unexpected network request in fake Discord process test");
};
`);
  return path;
}

function makeProcessEnv(directory: string, overrides: Record<string, string | undefined> = {}) {
  const statusPath = join(directory, "status.json");
  const authorityPath = join(directory, "authority.json");
  writeFileSync(authorityPath, JSON.stringify({ version: 1, generation: "generation_process_test" }));
  const preloadPath = pathToFileURL(writeGatewayPreload(directory)).href;
  const result: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: directory,
    TMPDIR: tmpdir(),
    NODE_OPTIONS: `--import=${preloadPath}`,
    NAIA_DISCORD_TOKEN_PIPE: "stdin",
    NAIA_DISCORD_BINDINGS_JSON: JSON.stringify({
      version: 1,
      bindings: [{
        bindingId: "binding_process_test",
        guildId: "100",
        channelId: "200",
        allowedUserIds: ["300"],
        processingProfileRef: "profile_process_test",
        participation: "mentions",
      }],
      processingProfiles: { profile_process_test: "local_only" },
    }),
    NAIA_DISCORD_GENERATION: "generation_process_test",
    NAIA_DISCORD_STATUS_PATH: statusPath,
    NAIA_DISCORD_AUTHORITY_PATH: authorityPath,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return { env: result, statusPath };
}

interface RunningServe {
  readonly child: ChildProcess;
  readonly statusPath: string;
  readonly output: () => string;
}

function startServe(directory: string, overrides: Record<string, string | undefined> = {}): RunningServe {
  const config = makeProcessEnv(directory, overrides);
  const entry = new URL("../../bin/naia-agent.mjs", import.meta.url);
  const child = spawn(process.execPath, [fileURLToPath(entry), "serve"], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: config.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  const output: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  child.stdin?.end("fake-test-token");
  return {
    child,
    statusPath: config.env.NAIA_DISCORD_STATUS_PATH ?? config.statusPath,
    output: () => output.join(""),
  };
}

async function waitForStatus(
  path: string,
  state: string,
  timeoutMs = 20_000,
  output: () => string = () => "",
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (value.state === state) return value;
    } catch { /* startup has not published a state yet */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`serve process did not publish ${state}: ${output().replaceAll("fake-test-token", "[redacted]").slice(-2_000)}`);
}

function waitForExit(child: ChildProcess, timeoutMs = 20_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("serve process exit timeout")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, signal });
    });
  });
}

afterEach(async () => {
  const active = [...children];
  for (const child of active) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all(active.map((child) => waitForExit(child).catch(() => undefined)));
  children.clear();
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("naia-agent serve process lifecycle", () => {
  it("reads the token pipe, publishes ready, rejects a duplicate generation, and exits cleanly on SIGTERM", async () => {
    const directory = testDirectory();
    const first = startServe(directory);
    const ready = await waitForStatus(first.statusPath, "ready", 20_000, first.output);
    expect(ready).toMatchObject({ version: 1, generation: "generation_process_test", state: "ready" });
    expect(first.output()).not.toContain("fake-test-token");

    const second = startServe(directory);
    const secondExit = await waitForExit(second.child);
    expect(secondExit.code).toBe(1);
    expect(second.output()).toContain("authority_conflict");
    expect(JSON.parse(readFileSync(first.statusPath, "utf8"))).toMatchObject({ state: "ready" });

    first.child.kill("SIGTERM");
    await expect(waitForExit(first.child)).resolves.toEqual({ code: 0, signal: null });
    await expect(waitForStatus(first.statusPath, "stopped")).resolves.toMatchObject({ state: "stopped" });
    expect(first.output()).not.toContain("fake-test-token");
  }, 60_000);

  it("drops readiness and exits when a replacement process takes the stale lease", async () => {
    const directory = testDirectory();
    const first = startServe(directory);
    await waitForStatus(first.statusPath, "ready", 20_000, first.output);

    const leasePath = join(directory, "authority.json.generation_process_test.lock");
    const lease = JSON.parse(readFileSync(leasePath, "utf8")) as Record<string, unknown>;
    writeFileSync(leasePath, JSON.stringify({ ...lease, updatedAt: 0 }));
    if (typeof lease.token === "string") {
      const heartbeatPath = `${leasePath}.${lease.token}.heartbeat`;
      try {
        const heartbeat = JSON.parse(readFileSync(heartbeatPath, "utf8")) as Record<string, unknown>;
        writeFileSync(heartbeatPath, JSON.stringify({ ...heartbeat, updatedAt: 0 }));
      } catch { /* r5 lease files have no separate heartbeat record */ }
    }
    const second = startServe(directory, {
      NAIA_DISCORD_STATUS_PATH: join(directory, "status-second.json"),
    });
    const secondReady = await waitForStatus(second.statusPath, "ready", 20_000, second.output);
    const firstExit = await waitForExit(first.child, 5_000);

    expect(firstExit.code).toBe(1);
    expect(JSON.parse(readFileSync(first.statusPath, "utf8"))).toMatchObject({
      state: "failed", code: "authority_lost",
    });
    expect(secondReady.state).toBe("ready");
    second.child.kill("SIGTERM");
    await expect(waitForExit(second.child)).resolves.toEqual({ code: 0, signal: null });
  }, 60_000);

  it("exits nonzero when bindings are missing or the authority selects another generation", async () => {
    const missing = startServe(testDirectory(), { NAIA_DISCORD_BINDINGS_JSON: undefined });
    await expect(waitForExit(missing.child)).resolves.toMatchObject({ code: 1 });
    expect(missing.output()).toContain("bindings_invalid");

    const authorityDirectory = testDirectory();
    const conflict = startServe(authorityDirectory, { NAIA_DISCORD_GENERATION: "other_generation" });
    await expect(waitForExit(conflict.child)).resolves.toMatchObject({ code: 1 });
    expect(conflict.output()).toContain("authority_conflict");
    expect(conflict.output()).not.toContain("fake-test-token");
  }, 60_000);
});
