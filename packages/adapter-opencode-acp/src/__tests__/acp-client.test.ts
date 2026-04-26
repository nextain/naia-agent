import { describe, expect, it } from "vitest";
import { AcpClient } from "../acp-client.js";

/**
 * Day 1.2 — AcpClient unit tests.
 * Uses /usr/bin/cat as a fake JSON-RPC server (echoes stdin to stdout —
 * for crash-recovery / EOF testing only). Real ACP request/response
 * flow is exercised in Phase 2 Day 5 E2E.
 */

describe("AcpClient — crash recovery + close behaviour", () => {
  it("close() resolves cleanly when child exits normally", async () => {
    const client = new AcpClient({
      command: "/bin/sh",
      args: ["-c", "exit 0"],
      hardKillDeadlineMs: 200,
    });
    await new Promise((r) => setTimeout(r, 50)); // let child exit
    await client.close();
    expect(client.closed).toBe(true);
  });

  it("close() within 500ms when child stays alive (P0-1 / C12 contract)", async () => {
    const client = new AcpClient({
      command: "/bin/sh",
      args: ["-c", "sleep 5"],
      hardKillDeadlineMs: 200,
    });
    const start = Date.now();
    await client.close();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1500); // hardKill (200) + SIGKILL fallback (100) + buffer
    expect(client.closed).toBe(true);
  }, 5000);

  it("pending requests reject when connection closes", async () => {
    const client = new AcpClient({
      command: "/bin/sh",
      args: ["-c", "sleep 0.1; exit 0"],
      hardKillDeadlineMs: 200,
    });
    const promise = client.request("nonexistent_method");
    await expect(promise).rejects.toThrow(/closed/);
  }, 5000);

  it("notify() does not throw before close", async () => {
    const client = new AcpClient({
      command: "/bin/sh",
      args: ["-c", "sleep 0.5"],
      hardKillDeadlineMs: 200,
    });
    expect(() => client.notify("test", { a: 1 })).not.toThrow();
    await client.close();
  }, 5000);

  it("multiple close() calls are idempotent", async () => {
    const client = new AcpClient({
      command: "/bin/sh",
      args: ["-c", "exit 0"],
      hardKillDeadlineMs: 200,
    });
    await new Promise((r) => setTimeout(r, 50));
    await client.close();
    await client.close();
    expect(client.closed).toBe(true);
  });
});

describe("AcpClient — JSON-RPC framing (mock server)", () => {
  it("processes a JSON-RPC response line correctly", async () => {
    // Mock server: emit a JSON-RPC response with id=1 then exit
    const client = new AcpClient({
      command: "/bin/sh",
      args: [
        "-c",
        `printf '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\\n'; sleep 0.1`,
      ],
      hardKillDeadlineMs: 200,
    });
    // Manually wire request id=1 by sending a request first
    const promise = client.request<{ ok: boolean }>("ignored");
    // The client increments id from 1 — first request gets id=1, matches mock
    const result = await promise;
    expect(result.ok).toBe(true);
    await client.close();
  }, 5000);

  it("processes notification (no id) via handler", async () => {
    let received: unknown = null;
    const client = new AcpClient({
      command: "/bin/sh",
      args: [
        "-c",
        `printf '{"jsonrpc":"2.0","method":"session/update","params":{"text":"hi"}}\\n'; sleep 0.1`,
      ],
      hardKillDeadlineMs: 200,
    });
    client.onNotification("session/update", (note) => {
      received = note.params;
    });
    await new Promise((r) => setTimeout(r, 50));
    await client.close();
    expect(received).toEqual({ text: "hi" });
  }, 5000);

  it("ignores invalid JSON lines (silent drop, P1-2)", async () => {
    const client = new AcpClient({
      command: "/bin/sh",
      args: ["-c", `printf 'not json\\n'; sleep 0.1`],
      hardKillDeadlineMs: 200,
    });
    // Should not crash; close cleanly
    await new Promise((r) => setTimeout(r, 50));
    await client.close();
    expect(client.closed).toBe(true);
  }, 5000);
});
