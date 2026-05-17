// R6/SB-1 (#32, matrix §D50) — S03 integration: manifest → HostContext →
// Agent.sendStream fixture-replay. Deterministic, no network, no API key
// (G15 CI fixture-only). Proves the loader contract: parsed manifest fields
// (persona.systemPrompt + memory.binding) assemble the existing HostContext
// and drive a real Agent turn. The openai-compatible→VercelClient provider
// mapping is host-side (bin) and is covered by S01 + existing vercel-client
// tests; here the LLM is the qwen fixture player for determinism.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Agent } from "@nextain/agent-core";
import { createHost } from "../host/create-host.js";
import { parseServiceManifest, resolveMemoryBinding } from "../host/service-manifest.js";
import { StreamPlayer, type StreamPlayerFixture } from "../testing/stream-player.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const qwenFixture = JSON.parse(
  readFileSync(resolve(__dirname, "../__fixtures__/qwen-1turn.json"), "utf8"),
) as StreamPlayerFixture;

// §5-style manifest, memory.binding=in-memory so the replay stays
// deterministic and never loads the heavy naia-memory engine.
const MANIFEST = JSON.stringify({
  schemaVersion: "0.1.0",
  name: "coding-assistant",
  description: "qwen3.6-27b SB-1 replay",
  persona: { systemPrompt: "You are a precise coding assistant. Korean/English." },
  llm: {
    backend: "openai-compatible",
    model: "Qwen/Qwen3.6-27B-FP8",
    baseURL: "http://localhost:8000/v1",
  },
  memory: { binding: "in-memory" },
});

describe("service-manifest replay (R6/SB-1 — S03 / G15)", () => {
  it("manifest → HostContext → Agent produces deterministic assistantText", async () => {
    const parsed = parseServiceManifest(MANIFEST);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const manifest = parsed.manifest;

    const memory = await resolveMemoryBinding(manifest.memory.binding);
    const host = createHost({
      logLevel: "warn",
      llm: new StreamPlayer(qwenFixture),
      memory,
    });
    const agent = new Agent({
      host,
      systemPrompt: manifest.persona.systemPrompt,
      tierForTool: () => "T0",
    });

    let assistantText = "";
    for await (const ev of agent.sendStream("write a function")) {
      if (ev.type === "turn.ended") assistantText = ev.assistantText;
    }
    // qwen-1turn.json emits "manifest loader ready." across 3 deltas.
    expect(assistantText).toBe("manifest loader ready.");
    agent.close();
  });

  it("repeated runs yield identical output (regression guarantee)", async () => {
    const run = async () => {
      const parsed = parseServiceManifest(MANIFEST);
      if (!parsed.ok) throw new Error("manifest parse failed");
      const memory = await resolveMemoryBinding(parsed.manifest.memory.binding);
      const host = createHost({
        logLevel: "warn",
        llm: new StreamPlayer(qwenFixture),
        memory,
      });
      const agent = new Agent({
        host,
        systemPrompt: parsed.manifest.persona.systemPrompt,
        tierForTool: () => "T0",
      });
      let text = "";
      for await (const ev of agent.sendStream("write a function")) {
        if (ev.type === "turn.ended") text = ev.assistantText;
      }
      agent.close();
      return text;
    };
    expect(await run()).toBe(await run());
  });
});
