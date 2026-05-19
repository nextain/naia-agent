/**
 * Conversational recall benchmark — REAL container model (GPU0) + REAL
 * Agent loop + REAL LiteMemoryProvider, run over N trials, scored by the
 * deterministic tiered judge (packages/runtime/src/bench/recall-bench-judge).
 *
 * This is the naia-agent-owned CONVERSATIONAL benchmark (naia-memory does
 * retrieval-only bench; the agent-loop / marker / NL round-trip is ours).
 *
 * User directive (2026-05-20): a tiny model (e2b) is not expected to emit a
 * usable marker reliably. SMALL tier = check the structure CAN occur at all
 * (capability gate; accuracy/leak reported, not gated). Strictness rises
 * with model size — MID (e4b) additionally gates round-trip + leak.
 *
 * Anti-false-positive (fixes 2026-05-19 Step-3): marker-structure is read
 * from the model's raw TEXT-channel output (a tee'd LLM wrapper) — exactly
 * what the agent's text-only marker parser at agent.ts:250 can act on, so
 * the bench and production agree (do NOT extend the tee to the thinking
 * channel or it diverges from what the agent can parse). It is NOT
 * confounded by the agent's always-on start-of-turn recall (IsolatingMemory
 * one-shot latch). leak uses the LOOSE detector so a malformed
 * `<recal<...</recal>` counts as a leak, and roundTrip requires a leak-free
 * answer (a garbled keyword echo is not a successful round-trip).
 *
 * Prereq: container ollama on :11434 (GPU0), model pulled.
 * Run:  pnpm exec tsx examples/conversational-recall-bench.ts
 * Env:  BENCH_TRIALS (default 5)  OLLAMA_MODEL (default gemma3n:e2b)
 * Exit: 0 tier gate met / 1 otherwise.
 */

import { Agent } from "@nextain/agent-core";
import { VercelClient } from "@nextain/agent-providers";
import {
  ConsoleLogger,
  InMemoryMeter,
  NoopTracer,
} from "@nextain/agent-observability";
import { InMemoryToolExecutor } from "@nextain/agent-runtime";
import type {
  HostContext,
  LLMClient,
  LLMRequest,
  LLMStreamChunk,
  MemoryProvider,
  MemoryHit,
} from "@nextain/agent-types";
// E2E-harness source-path imports (documented exception): bypass a stale
// pnpm-materialized dist copy in node_modules. Production wiring uses the
// @nextain/agent-types contracts (unit-proven, Step-2 + recall-bench-judge).
import { LiteMemoryProvider } from "/var/home/luke/alpha-adk/projects/naia-memory/src/memory/lite-provider.ts";
import {
  WELL_FORMED_MARKER,
  LOOSE_MARKER_LEAK,
  koIncludes,
  tierForModel,
  evaluateTier,
  type TrialResult,
} from "/var/home/luke/alpha-adk/projects/naia-agent/packages/runtime/src/bench/recall-bench-judge.ts";

const OLLAMA = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1";
const MODEL = process.env.OLLAMA_MODEL ?? "gemma3n:e2b";
const TRIALS = Math.max(1, Number(process.env.BENCH_TRIALS ?? 5) | 0);
const FACT = "사용자가 가장 좋아하는 음료는 따뜻한 보리차다.";
const KEYWORD = "보리차";
const QUESTION = "내가 제일 좋아하는 음료가 뭐였지?";

/** Deterministic local embedder (anchor #8: no external cloud LLM). */
const DIMS = 32;
const embedder = {
  name: "hash-embed",
  dims: DIMS,
  async embed(text: string): Promise<number[]> {
    const v = new Array(DIMS).fill(0);
    for (const ch of text.toLowerCase()) v[ch.charCodeAt(0) % DIMS] += 1;
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  },
  async embedBatch(t: string[]): Promise<number[][]> {
    return Promise.all(t.map((x) => this.embed(x)));
  },
};

/** Wraps an LLMClient and tees the RAW assistant text of each stream() call. */
class TeeLLM implements LLMClient {
  rawTurns: string[] = [];
  constructor(private readonly inner: LLMClient) {}
  generate(req: LLMRequest) {
    return this.inner.generate(req);
  }
  async *stream(req: LLMRequest): AsyncIterable<LLMStreamChunk> {
    let buf = "";
    for await (const ch of this.inner.stream(req)) {
      if (ch.type === "content_block_start" && ch.block?.type === "text") {
        buf += ch.block.text ?? "";
      } else if (
        ch.type === "content_block_delta" &&
        ch.delta?.type === "text_delta"
      ) {
        buf += ch.delta.text ?? "";
      }
      yield ch;
    }
    this.rawTurns.push(buf);
  }
}

/**
 * Isolates the #41 v2 marker path from the agent's always-on start-of-turn
 * recall: the FIRST recall of a turn is always the agent's start-of-turn
 * recall (agent.ts:191), so a one-shot latch returns [] for it and
 * delegates every subsequent (marker-driven) recall to the real provider.
 * The model thus gets the fact ONLY if it actually emits a marker. This
 * depends on the agent's call ordering, NOT on a query string the model
 * controls (a tiny model echoing the question into the marker must not be
 * able to null its own round-trip — cross-review fix #1). Same isolation
 * intent the Step-2 cross-review approved (RecordingMemory), applied to
 * the REAL model — removes a confound, does not fake the result.
 */
class IsolatingMemory implements MemoryProvider {
  #startOfTurnConsumed = false; // reset implicitly: fresh instance per trial
  constructor(private readonly inner: LiteMemoryProvider) {}
  encode(input: Parameters<LiteMemoryProvider["encode"]>[0], opts?: Parameters<LiteMemoryProvider["encode"]>[1]) {
    return this.inner.encode(input, opts);
  }
  async recall(query: string, opts?: Parameters<LiteMemoryProvider["recall"]>[1]): Promise<MemoryHit[]> {
    if (!this.#startOfTurnConsumed) {
      this.#startOfTurnConsumed = true; // recall #1 = start-of-turn → []
      return [];
    }
    return this.inner.recall(query, opts); // marker-driven recall → real
  }
  consolidate() {
    return this.inner.consolidate();
  }
  close() {
    return this.inner.close();
  }
}

const SYSTEM =
  "너는 naia. 장기기억이 있다. 사용자의 과거·개인 정보(취향 등)를 물으면, " +
  "추측하지 말고 정확히 `<recall>검색어</recall>` 한 줄만 출력하라. 기억이 " +
  "주입되면 그 내용으로 자연스럽게 답하라. 일반 상식은 바로 답하라.";

async function trial(llmInner: LLMClient): Promise<TrialResult> {
  const tee = new TeeLLM(llmInner);
  const memory = new LiteMemoryProvider({
    dbPath: ":memory:",
    embedder,
    writesEnabled: true,
  });
  await memory.encode({ content: FACT, role: "user" });
  const isolated = new IsolatingMemory(memory);
  const host: HostContext = {
    llm: tee,
    memory: isolated,
    tools: new InMemoryToolExecutor([]),
    logger: new ConsoleLogger({ level: "error" }),
    tracer: new NoopTracer(),
    meter: new InMemoryMeter(),
  } as HostContext;
  const agent = new Agent({ host, systemPrompt: SYSTEM, tierForTool: () => "T0" });
  let answer = "";
  for await (const ev of agent.sendStream(QUESTION)) {
    if (ev.type === "turn.ended") answer = ev.assistantText;
  }
  agent.close();
  await memory.close();

  const rawAll = tee.rawTurns.join("\n");
  const leaked = LOOSE_MARKER_LEAK.test(answer);
  return {
    markerWellFormed: WELL_FORMED_MARKER.test(rawAll),
    // A leaked (garbled-tag) answer cannot be a clean round-trip even if it
    // echoes the keyword — closes the accuracy false-positive at gated tiers.
    roundTrip: !leaked && koIncludes(answer, KEYWORD),
    leaked,
  };
}

async function main() {
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const provider = createOpenAICompatible({
    name: "ollama",
    apiKey: "EMPTY",
    baseURL: OLLAMA,
  });
  const llmInner = new VercelClient(provider.chatModel(MODEL));
  const gate = tierForModel(MODEL);

  console.log(
    `\n[bench] model=${MODEL} tier=${gate.id} trials=${TRIALS}` +
      `  (structureGate=${gate.structureGate}` +
      ` accuracyMin=${gate.accuracyMin ?? "report"}` +
      ` leakMax=${gate.leakMax ?? "report"})\n`,
  );

  const results: TrialResult[] = [];
  for (let i = 0; i < TRIALS; i++) {
    const r = await trial(llmInner);
    results.push(r);
    console.log(
      `  trial ${i + 1}: marker=${r.markerWellFormed ? "Y" : "·"}` +
        ` roundtrip=${r.roundTrip ? "Y" : "·"}` +
        ` leak=${r.leaked ? "LEAK" : "·"}`,
    );
  }

  const v = evaluateTier(results, gate);
  console.log(`\n[verdict] ${gate.id} tier — ${v.pass ? "PASS" : "FAIL"}`);
  for (const reason of v.reasons) console.log(`  - ${reason}`);
  console.log(
    `  structure ${v.structureCount}/${v.trials} · ` +
      `accuracy ${(v.accuracyRate * 100).toFixed(0)}% · ` +
      `leak ${(v.leakRate * 100).toFixed(0)}%\n`,
  );
  if (!v.pass) throw new Error(`tier '${gate.id}' gate not met`);
  console.log(`✓ conversational recall bench: ${gate.id} tier gate met\n`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`✗ bench FAILED: ${(e as Error).message}`);
    process.exit(1);
  },
);
