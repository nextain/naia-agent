/**
 * Human-like memory experience benchmark — LIVE multi-session runner.
 *
 * Measures the product-owner definition of human-like memory (2026-07-04):
 * selective, appropriate recall — NOT perfect recall. Drives the REAL agent
 * (main = vertexai:gemini-3.5-flash) over a hand-authored multi-session
 * scenario, persists memory across sessions in a real SQLite store (real
 * multilingual embeddings via the same gateway), and fills a deterministic
 * PipelineTrace per probe → `classifyPipeline` 5-bucket attribution.
 *
 * Layer attribution (flagship cross-review, Claude + GPT-5.5):
 *   - recall marker (deliberate DECISION) read from the tee'd raw text channel;
 *   - start-of-turn recall is ISOLATED (one-shot [] per turn) so a retrieved
 *     memory can only reach the model via a marker → "retrieval miss" vs
 *     "no recall attempt" stay cleanly separated;
 *   - each scenario pairs a POSITIVE probe (recall SHOULD surface) with a
 *     NEGATIVE control (surfacing would be socially wrong = "creepy DB").
 *
 * The social-quality judge layer (used-needs-judge bucket) is Slice 2 — this
 * runner reports the deterministic buckets and marks judge-deferred probes.
 *
 * Run (real Gemini, opt-in — credit protection):
 *   cd /var/home/luke/alpha-adk
 *   set -a; . data-private/key/llm-key.env; set +a       # loads NAIA_PROD_KEY (no echo)
 *   HUMANLIKE_LIVE=1 pnpm --dir projects/naia-agent exec \
 *     tsx examples/humanlike-memory-bench.ts
 * Without HUMANLIKE_LIVE=1 or a key it prints how to run and exits 0 (CI-safe).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "@nextain/agent-core";
import { VercelClient } from "@nextain/agent-providers";
import { ConsoleLogger, InMemoryMeter, NoopTracer } from "@nextain/agent-observability";
import { InMemoryToolExecutor } from "@nextain/agent-runtime";
import type {
	HostContext,
	LLMClient,
	LLMRequest,
	LLMStreamChunk,
	MemoryHit,
	MemoryProvider,
} from "@nextain/agent-types";

// Source-path imports (documented E2E-harness exception, mirrors
// examples/conversational-recall-bench.ts) — run under tsx without a dist build.
import { LiteMemoryProvider } from "/var/home/luke/alpha-adk/projects/naia-memory/src/memory/lite-provider.ts";
import { OpenAICompatEmbeddingProvider } from "/var/home/luke/alpha-adk/projects/naia-memory/src/memory/embeddings.ts";
// Salience-aware path (HL-5a): the real MemorySystem+LocalAdapter (importance×0.3
// + flashbulb-emotion boost + Ebbinghaus strength) vs Lite's pure cosine. These
// come from the BUILT package (dist) — provider.ts uses value-imports for
// type-only interfaces, which tsx's isolated transpile can't erase from source.
import { LocalAdapter, buildLLMFactExtractor, HeuristicContradictionFilter } from "@nextain/naia-memory";
import { NaiaMemoryProvider } from "/var/home/luke/alpha-adk/projects/naia-memory/dist/memory/provider.js";
import { koIncludes } from "/var/home/luke/alpha-adk/projects/naia-agent/packages/runtime/src/bench/recall-bench-judge.ts";
import { WELL_FORMED_MARKER } from "/var/home/luke/alpha-adk/projects/naia-agent/packages/runtime/src/bench/recall-bench-judge.ts";
import { classifyPipeline, summarize } from "../packages/benchmarks/src/humanlike/pipeline.ts";
import { buildTrace, isDegenerateResponse } from "../packages/benchmarks/src/humanlike/observe.ts";
import { judgeSocialQuality, type SocialQualityAggregate } from "../packages/benchmarks/src/humanlike/judge.ts";
import {
	renderHumanlikeReport,
	HUMANLIKE_FIXTURE_VERSION,
	type HumanlikeFixture,
	type RecordedProbe,
	type ReportRow,
} from "../packages/benchmarks/src/humanlike/fixture.ts";
import { HUMANLIKE_SCENARIOS } from "../packages/benchmarks/src/humanlike/scenarios.ts";
import type { HumanlikeProbe, HumanlikeScenario, PipelineOutcome } from "../packages/benchmarks/src/humanlike/types.ts";

const GATEWAY =
	(process.env.NAIA_GATEWAY_URL ??
		"https://naia-gateway-181404717065.asia-northeast3.run.app").replace(/\/+$/, "");
const MAIN_MODEL = process.env.HUMANLIKE_MAIN_MODEL ?? "vertexai:gemini-3.5-flash";
const EMBED_MODEL = process.env.HUMANLIKE_EMBED_MODEL ?? "vertexai:text-multilingual-embedding-002";
const EMBED_DIMS = Number(process.env.HUMANLIKE_EMBED_DIMS ?? 768) | 0;
// HL-5a: which memory the agent talks to. "lite" = pure cosine (no salience,
// original bench); "naia" = real MemorySystem+LocalAdapter (importance-weighted
// recall + flashbulb-emotion boost) with a gemini sub-LLM fact extractor.
const PROVIDER = (process.env.HUMANLIKE_PROVIDER ?? "lite").toLowerCase();
const SUB_MODEL = process.env.HUMANLIKE_SUB_MODEL ?? "vertexai:gemini-3.1-flash-lite";
// CRLF-tolerant: the age-vault key file ships with CRLF line endings.
const KEY = (process.env.NAIA_PROD_KEY ?? "").trim();

// #41 v2 recall contract: the marker MUST be a standalone turn. Gemini tends to
// emit `<recall>…</recall>` + a full answer in one generation; the agent then
// commits that answer to history and the post-recall regeneration degenerates
// (observed: a lone "😉"). Instructing a marker-ONLY turn makes the two-step
// recall→answer protocol function as designed — this is correct naia
// configuration, not test-specific coaching.
const SYSTEM =
	"너는 naia야. 사용자와 오래 알고 지낸 친구처럼, 장기기억을 가지고 대화해. " +
	"사용자의 과거 발화·취향·경험이 지금 대화와 관련될 수 있다고 판단되면, 그 턴에는 " +
	"다른 말은 절대 쓰지 말고 오직 `<recall>검색어</recall>` 한 줄만 출력해. 그러면 다음 턴에 " +
	"기억이 주입되고, 그때 그 내용을 자연스럽게 녹여 답해. 억지로 끼워 넣지는 마. " +
	"관련 없으면 마커 없이 그냥 평범하게 답해.";

/** Tees the RAW assistant text channel so we can detect a `<recall>` marker —
 *  exactly what the agent's marker parser acts on (parity with conv-recall bench). */
class TeeLLM implements LLMClient {
	raw = "";
	/** Per-stream() raw text — one entry per agent hop (marker turn, regen…). */
	rawTurns: string[] = [];
	constructor(private readonly inner: LLMClient) {}
	generate(req: LLMRequest) {
		return this.inner.generate(req);
	}
	async *stream(req: LLMRequest): AsyncIterable<LLMStreamChunk> {
		if (process.env.HUMANLIKE_DEBUG === "1") {
			// Per-hop request shape — surfaces the array-vs-string assistant
			// content that the gateway rejects on multi-hop regen (see CHANGELOG).
			const roles = (req.messages ?? []).map((m: { role: string; content: unknown }) => {
				const c = m.content;
				const shape = typeof c === "string" ? c.length : Array.isArray(c) ? `[${c.map((b: { type?: string }) => b.type).join(",")}]` : "?";
				return `${m.role}:${shape}`;
			});
			console.log(`      [req] sysLen=${(req.system ?? "").length} msgs=${JSON.stringify(roles)}`);
		}
		let buf = "";
		for await (const ch of this.inner.stream(req)) {
			if (ch.type === "content_block_start" && ch.block?.type === "text") buf += ch.block.text ?? "";
			else if (ch.type === "content_block_delta" && ch.delta?.type === "text_delta") buf += ch.delta.text ?? "";
			yield ch;
		}
		this.raw += buf;
		this.rawTurns.push(buf);
	}
}

/**
 * Isolates the deliberate marker path from the agent's always-on start-of-turn
 * recall AND records every marker-driven recall's returned memories. Per turn:
 * recall #1 (start-of-turn) → [] (isolated); recall #2+ (marker-driven) →
 * delegate + record. `beginTurn()` resets the per-turn latch.
 */
class ObservingMemory implements MemoryProvider {
	markerDrivenHits: MemoryHit[] = [];
	#firstRecallConsumed = false;
	constructor(private readonly inner: MemoryProvider) {}
	beginTurn(): void {
		this.#firstRecallConsumed = false;
		this.markerDrivenHits = [];
	}
	encode(i: Parameters<MemoryProvider["encode"]>[0], o?: Parameters<MemoryProvider["encode"]>[1]) {
		return this.inner.encode(i, o);
	}
	async recall(q: string, o?: Parameters<MemoryProvider["recall"]>[1]): Promise<MemoryHit[]> {
		if (!this.#firstRecallConsumed) {
			this.#firstRecallConsumed = true; // start-of-turn recall → isolated
			return [];
		}
		const hits = await this.inner.recall(q, o);
		this.markerDrivenHits.push(...hits);
		return hits;
	}
	consolidate() {
		return this.inner.consolidate();
	}
	close() {
		return this.inner.close();
	}
}

function countBy(xs: string[]): Record<string, number> {
	const o: Record<string, number> = {};
	for (const x of xs) o[x] = (o[x] ?? 0) + 1;
	return o;
}

function makeHost(llm: LLMClient, memory: MemoryProvider): HostContext {
	return {
		llm,
		memory,
		tools: new InMemoryToolExecutor([]),
		logger: new ConsoleLogger({ level: "error" }),
		tracer: new NoopTracer(),
		meter: new InMemoryMeter(),
	} as HostContext;
}

/** Drive one user turn through a fresh agent; returns {response, markerEmitted}. */
async function runTurn(
	mainLlm: LLMClient,
	observed: ObservingMemory,
	userText: string,
): Promise<{ response: string; markerEmitted: boolean }> {
	const tee = new TeeLLM(mainLlm);
	const agent = new Agent({
		host: makeHost(tee, observed),
		systemPrompt: SYSTEM,
		appendDefaultSystemPrompt: false,
	});
	observed.beginTurn();
	let response = "";
	const evTypes: string[] = [];
	for await (const ev of agent.sendStream(userText)) {
		evTypes.push(ev.type);
		if (ev.type === "turn.ended") response = ev.assistantText;
	}
	agent.close();
	if (process.env.HUMANLIKE_DEBUG === "1") {
		console.log(`      [debug] hops=${tee.rawTurns.length} events=${JSON.stringify(countBy(evTypes))}`);
		tee.rawTurns.forEach((r, i) =>
			console.log(`      [debug] hop${i} text=${r.length}: ${r.replace(/\s+/g, " ").slice(0, 160)}`),
		);
	}
	return { response, markerEmitted: WELL_FORMED_MARKER.test(tee.raw) };
}

interface JudgedProbe {
	readonly probeId: string;
	readonly agg: SocialQualityAggregate;
}

type MutableRow = { -readonly [K in keyof ReportRow]: ReportRow[K] };

async function runScenario(
	scenario: HumanlikeScenario,
	mainLlm: LLMClient,
	observed: ObservingMemory,
): Promise<{ outcomes: PipelineOutcome[]; judged: JudgedProbe[]; recorded: RecordedProbe[]; rows: ReportRow[] }> {
	console.log(`\n▶ 시나리오 ${scenario.id} (${scenario.family})`);

	// Seed + distractor sessions: replay USER turns; the real agent generates
	// and auto-encodes (user+assistant) into the persistent store.
	for (const session of scenario.sessions) {
		console.log(`  · seed [${session.label}]`);
		for (const turn of session.turns) {
			if (turn.role !== "user") continue;
			await runTurn(mainLlm, observed, turn.content);
		}
	}

	// Consolidate the seeded episodes (extract facts, settle importance/strength)
	// — the realistic post-conversation lifecycle that engages the salience
	// machinery. No-op for the lite provider.
	try {
		const c = await observed.consolidate();
		if (PROVIDER === "naia") console.log(`  · consolidate: +${c.factsCreated} facts / ${c.factsUpdated} upd / ${c.episodesProcessed} episodes`);
	} catch (e) {
		console.log(`  · consolidate error: ${(e as Error).message}`);
	}

	// Probes: each in a fresh agent (clean history) against the seeded store.
	const outcomes: PipelineOutcome[] = [];
	const recorded: RecordedProbe[] = [];
	const rows: MutableRow[] = [];
	const rowByProbe = new Map<string, MutableRow>();
	const needsJudge: { probe: HumanlikeProbe; response: string; recalled: string[] }[] = [];
	for (const probe of scenario.probes) {
		const { response, markerEmitted } = await runTurn(mainLlm, observed, probe.triggerText);
		const markerDrivenHits = observed.markerDrivenHits.map((h) => h.content);
		const trace = buildTrace({ probeId: probe.id, markerEmitted, markerDrivenHits, responseText: response }, probe, koIncludes);
		// Bench-soundness guard: a non-response (empty / agent-stop stub) is an
		// execution failure, NOT a clean outcome — do not let it false-pass the
		// classifier (esp. a negative probe → "abstained-correctly").
		const outcome: PipelineOutcome = isDegenerateResponse(response)
			? { probeId: probe.id, bucket: "execution-error" as PipelineOutcome["bucket"], deterministicPass: false, failureLayer: "agent-integration" }
			: classifyPipeline(trace, probe.polarity);
		outcomes.push(outcome);
		reportProbe(probe, trace, outcome, response);
		recorded.push({
			scenarioId: scenario.id,
			probeId: probe.id,
			family: probe.family,
			polarity: probe.polarity,
			observation: { markerEmitted, markerDrivenHits, responseText: response },
			trace: { recallAttempted: trace.recallAttempted, targetRetrieved: trace.targetRetrieved, targetUsed: trace.targetUsed, forbiddenSurfaced: trace.forbiddenSurfaced ?? false },
			bucket: outcome.bucket,
		});
		const row: MutableRow = { scenarioId: scenario.id, probeId: probe.id, family: probe.family, polarity: probe.polarity, bucket: outcome.bucket, deterministicPass: outcome.deterministicPass };
		rows.push(row);
		rowByProbe.set(probe.id, row);
		if (outcome.bucket === "used-needs-judge") {
			// Snapshot the ACTUAL retrieved memory now — the spy is reset each turn.
			needsJudge.push({ probe, response, recalled: markerDrivenHits });
		}
	}

	// Social-quality judge layer — flagship ensemble (codex + claude), scores the
	// `used-needs-judge` probes only. Opt-in (NAIA_JUDGE_ENSEMBLE=1) to protect
	// codex/claude CLI credits; without it these probes stay deferred.
	const judged: JudgedProbe[] = [];
	if (needsJudge.length > 0 && process.env.NAIA_JUDGE_ENSEMBLE === "1") {
		console.log(`  ─ 판정 (social-quality 앙상블: codex + claude) ─`);
		for (const { probe, response, recalled } of needsJudge) {
			const agg = await judgeSocialQuality({
				trigger: probe.triggerText,
				response,
				expectedMemory: probe.expectedMemorySet,
				...(recalled.length > 0 ? { recalledMemory: recalled } : {}),
				...(probe.acceptableStyle ? { acceptableStyle: probe.acceptableStyle } : {}),
				...(probe.forbiddenRecalls ? { forbiddenRecalls: probe.forbiddenRecalls } : {}),
			});
			judged.push({ probeId: probe.id, agg });
			reportJudge(probe.id, agg);
			const row = rowByProbe.get(probe.id);
			if (row && !agg.unreliable) {
				row.judgeOverall = agg.overall;
				row.judgePass = agg.pass;
			}
		}
	} else if (needsJudge.length > 0) {
		console.log(`  ─ ${needsJudge.length} probe deferred to judge (set NAIA_JUDGE_ENSEMBLE=1 to score) ─`);
	}

	return { outcomes, judged, recorded, rows };
}

function reportJudge(probeId: string, agg: SocialQualityAggregate): void {
	const a = agg.axes;
	const verdict = agg.unreliable ? "UNRELIABLE" : agg.pass ? "PASS" : "FAIL";
	console.log(
		`  ★ ${probeId} social-quality → ${verdict}  overall=${agg.overall.toFixed(2)}` +
			`  (적절 ${a.appropriateness} / 자연 ${a.naturalness} / 충실 ${a.faithfulness})` +
			`  judges=${agg.validCount}✓/${agg.infraErrorCount}✗`,
	);
	console.log(`      ${agg.reason.slice(0, 200)}`);
}

function reportProbe(
	probe: HumanlikeProbe,
	trace: ReturnType<typeof buildTrace>,
	outcome: PipelineOutcome,
	response: string,
): void {
	const verdict =
		outcome.deterministicPass === null
			? "NEEDS-JUDGE"
			: outcome.deterministicPass
				? "PASS"
				: "FAIL";
	console.log(
		`  ▷ ${probe.id} [${probe.polarity}] → ${outcome.bucket}  (${verdict})` +
			(outcome.failureLayer ? `  layer=${outcome.failureLayer}` : ""),
	);
	console.log(
		`      marker=${trace.recallAttempted ? "Y" : "·"} retrieved=${trace.targetRetrieved ? "Y" : "·"}` +
			` used=${trace.targetUsed ? "Y" : "·"} forbidden=${trace.forbiddenSurfaced ? "LEAK" : "·"}`,
	);
	console.log(`      응답: ${response.replace(/\s+/g, " ").slice(0, 140)}`);
}

/** Build the memory the agent talks to. HL-5a isolation toggle: the original
 *  bench used LiteMemoryProvider (pure cosine, zero salience) — the emotion
 *  axis had no weight machinery to draw on. "naia" swaps in the real
 *  MemorySystem+LocalAdapter (importance-weighted recall + flashbulb-emotion
 *  boost) with a gemini-3.1-flash-lite fact extractor (the sub-LLM the design
 *  wanted; Lite has no LLM hook). Same MemoryProvider interface → drop-in. */
function buildBenchMemory(embedder: OpenAICompatEmbeddingProvider): { provider: MemoryProvider; note: string } {
	if (PROVIDER === "naia") {
		const storePath = join(mkdtempSync(join(tmpdir(), "humanlike-naia-")), "mem.json");
		const adapter = new LocalAdapter({ storePath, embeddingProvider: embedder });
		const factExtractor = buildLLMFactExtractor({ apiKey: KEY, baseURL: `${GATEWAY}/v1/`, model: SUB_MODEL });
		const provider = new NaiaMemoryProvider({
			adapter,
			factExtractor,
			contradictionFilter: new HeuristicContradictionFilter(),
		}) as unknown as MemoryProvider;
		return { provider, note: `naia MemorySystem+LocalAdapter (sub=${SUB_MODEL}, salience-aware)  store=${storePath}` };
	}
	const dbPath = join(mkdtempSync(join(tmpdir(), "humanlike-")), "mem.db");
	const provider = new LiteMemoryProvider({ dbPath, embedder, writesEnabled: true });
	return { provider, note: `lite (pure cosine, no salience)  db=${dbPath}` };
}

async function main() {
	if (process.env.HUMANLIKE_LIVE !== "1" || !KEY) {
		console.log(
			"[skip] human-like LIVE bench는 opt-in입니다 (실 Gemini 크레딧 보호).\n" +
				"  실행: cd /var/home/luke/alpha-adk && set -a; . data-private/key/llm-key.env; set +a\n" +
				"        HUMANLIKE_LIVE=1 pnpm --dir projects/naia-agent exec tsx examples/humanlike-memory-bench.ts\n" +
				`  gateway=${GATEWAY} main=${MAIN_MODEL} embed=${EMBED_MODEL}(${EMBED_DIMS}d)` +
				`  key=${KEY ? "SET" : "MISSING"}`,
		);
		process.exit(0);
	}

	// OpenAICompatEmbeddingProvider appends `/v1/embeddings` itself when the base
	// does not end in `/openai` — pass the bare gateway (NOT `${GATEWAY}/v1`, which
	// would double to `/v1/v1/embeddings` → 404). The chat provider below is the
	// opposite: createOpenAICompatible needs the `/v1` base.
	const embedder = new OpenAICompatEmbeddingProvider(GATEWAY, KEY, EMBED_MODEL, EMBED_DIMS);
	const { provider: memory, note: providerNote } = buildBenchMemory(embedder);
	const observed = new ObservingMemory(memory);

	const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
	const provider = createOpenAICompatible({ name: "naia-gw", apiKey: KEY, baseURL: `${GATEWAY}/v1` });
	const mainLlm = new VercelClient(provider.chatModel(MAIN_MODEL), { defaultMaxTokens: 2048 });

	console.log(
		`[bench] human-like memory experience — LIVE\n` +
			`  gateway=${GATEWAY}  main=${MAIN_MODEL}  embed=${EMBED_MODEL}(${EMBED_DIMS}d)\n` +
			`  memory=${providerNote}`,
	);

	const all: PipelineOutcome[] = [];
	const judgedAll: JudgedProbe[] = [];
	const recordedAll: RecordedProbe[] = [];
	const rowsAll: ReportRow[] = [];
	for (const scenario of HUMANLIKE_SCENARIOS) {
		const r = await runScenario(scenario, mainLlm, observed);
		all.push(...r.outcomes);
		judgedAll.push(...r.judged);
		recordedAll.push(...r.recorded);
		rowsAll.push(...r.rows);
	}
	await memory.close();

	const s = summarize(all);
	console.log(`\n[summary] probes=${s.total}  det-pass=${s.deterministicPass}  det-fail=${s.deterministicFail}  needs-judge=${s.needsJudge}`);
	console.log(`  buckets: ${JSON.stringify(s.byBucket)}`);
	if (Object.keys(s.byFailureLayer).length) console.log(`  failure-layers: ${JSON.stringify(s.byFailureLayer)}`);
	if (judgedAll.length > 0) {
		const jpass = judgedAll.filter((j) => !j.agg.unreliable && j.agg.pass).length;
		const junrel = judgedAll.filter((j) => j.agg.unreliable).length;
		console.log(`  judged (social-quality): ${jpass}/${judgedAll.length} pass` + (junrel ? `, ${junrel} unreliable` : ""));
	}

	console.log("\n" + renderHumanlikeReport(rowsAll));

	// Fixture recording — HUMANLIKE_RECORD=<path> writes the deterministic
	// observations for CI replay (no LLM). Judge scores are non-deterministic and
	// omitted (judge aggregation is unit-tested separately).
	const recordPath = process.env.HUMANLIKE_RECORD;
	if (recordPath) {
		const fixture: HumanlikeFixture = {
			version: HUMANLIKE_FIXTURE_VERSION,
			recordedAt: new Date().toISOString(),
			model: MAIN_MODEL,
			probes: recordedAll,
		};
		writeFileSync(recordPath, JSON.stringify(fixture, null, "\t") + "\n");
		console.log(`\n[record] fixture written: ${recordPath} (${recordedAll.length} probes)`);
	}
	console.log(
		`\n✓ 라이브 러너 동작: PipelineTrace 생성 + 5-버킷 분류 완료 (판정 층 = Slice 2).`,
	);
}

main().then(
	() => process.exit(0),
	(e) => {
		console.error(`✗ human-like bench FAILED: ${(e as Error).stack ?? (e as Error).message}`);
		process.exit(1);
	},
);
