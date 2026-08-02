import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeNaiaMemory } from "../main/adapters/naia-memory.js";
import { makeStdioEgress, makeStdioIngress } from "../main/adapters/stdio.js";
import { wireAgentUC1 } from "../main/composition/index.js";
import type { ChatMessage, ProviderChunk, ProviderConfig } from "../main/domain/chat.js";
import type { ProviderChatOpts, ProviderPort } from "../main/ports/uc1.js";

describe("echo-system memory persistence", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("stores the user episode but not the diagnostic system-prompt echo", async () => {
    root = await mkdtemp(join(tmpdir(), "naia-echo-memory-"));
    const storePath = join(root, "store.json");
    const memory = makeNaiaMemory({ storePath, project: "echo-test", sessionId: "s1" });
    const provider: ProviderPort = {
      async *chat(_config: ProviderConfig, _messages: readonly ChatMessage[], opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
        yield { kind: "text", text: `SYSTEM_ECHO:${opts.systemPrompt ?? "diagnostic prompt"}` };
        yield { kind: "finish" };
      },
    };
    const output: string[] = [];
    let receive: ((line: string) => void) | undefined;
    const io = {
      writeLine: (line: string) => output.push(line),
      onLine: (handler: (line: string) => void) => { receive = handler; return () => { receive = undefined; }; },
    };
    wireAgentUC1({ ingress: makeStdioIngress(io), egress: makeStdioEgress(io), provider, memory }).start?.();
    receive?.(JSON.stringify({
      type: "chat_request",
      requestId: "echo-1",
      provider: { provider: "echo-system", model: "diagnostic" },
      messages: [{ role: "user", content: "CONNECTION_OK" }],
    }));
    for (let i = 0; i < 100 && !output.some((line) => JSON.parse(line).type === "finish"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await memory.close();

    const store = JSON.parse(await readFile(storePath, "utf8")) as {
      episodes: Array<{ role?: string; content: string }>;
    };
    expect(store.episodes).toContainEqual(expect.objectContaining({ role: "user", content: "CONNECTION_OK" }));
    expect(store.episodes.some((episode) => episode.content.includes("SYSTEM_ECHO"))).toBe(false);
    expect(store.episodes.some((episode) => episode.role === "assistant")).toBe(false);
  });
});
