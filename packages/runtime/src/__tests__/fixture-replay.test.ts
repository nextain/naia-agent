// Slice 1b sub-5 — fixture-replay regression (#13).
// Verifies StreamPlayer + Agent produce deterministic assistantText.
// Closes G02 (Agent × real-LLM 통합 검증 0건) via fixture path.
// G15 (CI fixture-only mode) — this test runs without ANTHROPIC_API_KEY.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Agent } from "@nextain/agent-core";
import { createHost } from "../host/create-host.js";
import { StreamPlayer, type StreamPlayerFixture } from "../testing/stream-player.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, "../__fixtures__/anthropic-1turn.json");

describe("fixture-replay (Slice 1b — G02 / G15)", () => {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as StreamPlayerFixture;

  it("StreamPlayer.stream() emits all fixture chunks in order", async () => {
    const player = new StreamPlayer(fixture);
    const chunks = [];
    for await (const c of player.stream({ messages: [], model: "x" })) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(fixture.chunks.length);
    expect(chunks[0]?.type).toBe("start");
    expect(chunks[chunks.length - 1]?.type).toBe("end");
    expect(player.callCount).toBe(1);
  });

  it("Agent + StreamPlayer produces deterministic assistantText", async () => {
    const player = new StreamPlayer(fixture);
    const host = createHost({ logLevel: "warn", llm: player });
    const agent = new Agent({
      host,
      systemPrompt: "test",
      tierForTool: () => "T0",
    });

    let assistantText = "";
    for await (const ev of agent.sendStream("anything")) {
      if (ev.type === "turn.ended") assistantText = ev.assistantText;
    }

    // Fixture chunks emit "Hi from fixture." across 3 deltas.
    expect(assistantText).toBe("Hi from fixture.");
    agent.close();
  });

  it("repeated runs yield identical output (regression guarantee)", async () => {
    const run = async () => {
      const player = new StreamPlayer(fixture);
      const host = createHost({ logLevel: "warn", llm: player });
      const agent = new Agent({ host, tierForTool: () => "T0" });
      let text = "";
      for await (const ev of agent.sendStream("anything")) {
        if (ev.type === "turn.ended") text = ev.assistantText;
      }
      agent.close();
      return text;
    };

    const a = await run();
    const b = await run();
    expect(a).toBe(b);
  });

  it("generate() throws when fixture has no response", async () => {
    const player = new StreamPlayer(fixture);
    await expect(player.generate({ messages: [], model: "x" })).rejects.toThrow(
      /no `response`/,
    );
  });
});
