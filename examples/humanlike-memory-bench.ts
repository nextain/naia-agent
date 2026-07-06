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
import { HUMANLIKE_SCENARIOS, SALIENCE_SCENARIOS } from "../packages/benchmarks/src/humanlike/scenarios.ts";
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
// HL-5c: direct-seed mode encodes seed turns straight into memory (with their
// reaction emotion tag) instead of driving the agent — so differential salience
// is applied. HUMANLIKE_REACTION=off drops the tags (the A/B control).
const DIRECT_SEED = process.env.HUMANLIKE_DIRECT_SEED === "1";
const REACTION_ON = process.env.HUMANLIKE_REACTION !== "off";
const SCENARIO_SET = (process.env.HUMANLIKE_SCENARIO_SET ?? "humanlike").toLowerCase();
// HL-6: surface each recalled memory's emotional salience to the agent so it can
// judge contextual appropriateness (the agent-layer selectivity lever the N=5
// stabilization pointed to — memory-weight alone was insufficient).
const EXPOSE_SALIENCE = process.env.HUMANLIKE_EXPOSE_SALIENCE === "1";
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
	"관련 없으면 마커 없이 그냥 평범하게 답해." +
	// HL-6 salience is exposed as INFORMATION only — NOT a suppress directive.
	// (The earlier rider "부적절한 기억은 억제해라" was a filter = designer-imposed bias;
	// removed per SoT naia-behavior-emergent-not-filtered.md. naia decides for itself
	// whether/how to use a memory — material is given, the choice is its cognition.)
	(EXPOSE_SALIENCE
		? " 주입되는 각 기억 앞의 [감정가 N] (0~1, 0.5=중립·0=강한부정·1=강한긍정)은 그 기억의 " +
			"감정 결을 나타내는 참고 정보다."
		: "");

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
		let hits = await this.inner.recall(q, o);
		// HL-6: prefix each memory with its emotional-salience metadata so the agent
		// (which otherwise sees only the text) can judge contextual appropriateness.
		// The anchor stays inside the content, so deterministic containment is intact.
		if (EXPOSE_SALIENCE) {
			hits = hits.map((h) => {
				const emo = (h.metadata as { emotion?: number } | undefined)?.emotion;
				return emo === undefined ? h : { ...h, content: `[감정가 ${emo.toFixed(2)}] ${h.content}` };
			});
		}
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

/** The recall query the model actually put inside `<recall>…</recall>` (first
 *  well-formed marker), for diagnosing retrieval-miss (bad query vs bad memory). */
function extractMarkerQuery(raw: string): string {
	const m = raw.match(/<recall>\s*([\s\S]{2,256}?)\s*<\/recall>/i);
	return m ? m[1]!.trim() : "";
}

/** Drive one user turn through a fresh agent. */
async function runTurn(
	mainLlm: LLMClient,
	observed: ObservingMemory,
	userText: string,
): Promise<{ response: string; markerEmitted: boolean; markerQuery: string }> {
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
	return { response, markerEmitted: WELL_FORMED_MARKER.test(tee.raw), markerQuery: extractMarkerQuery(tee.raw) };
}

interface JudgedProbe {
	readonly probeId: string;
	readonly agg: SocialQualityAggregate;
}

type MutableRow = { -readonly [K in keyof ReportRow]: ReportRow[K] };

interface ProbeStat {
	readonly probeId: string;
	readonly family: string;
	readonly polarity: string;
	readonly bucket: string;
	readonly markerQuery: string;
	readonly targetRetrieved: boolean;
}

async function runScenario(
	scenario: HumanlikeScenario,
	mainLlm: LLMClient,
	observed: ObservingMemory,
): Promise<{ outcomes: PipelineOutcome[]; judged: JudgedProbe[]; recorded: RecordedProbe[]; rows: ReportRow[]; probeStats: ProbeStat[] }> {
	console.log(`\n▶ 시나리오 ${scenario.id} (${scenario.family})`);

	// Seed + distractor sessions: replay USER turns; the real agent generates
	// and auto-encodes (user+assistant) into the persistent store.
	for (const session of scenario.sessions) {
		console.log(`  · seed [${session.label}]`);
		for (const turn of session.turns) {
			if (turn.role !== "user") continue;
			if (DIRECT_SEED) {
				// Encode the seed turn directly, applying its reaction emotion tag
				// (unless HUMANLIKE_REACTION=off) — differential salience at seed time.
				const emo = REACTION_ON ? (turn as { emotion?: number }).emotion : undefined;
				await observed.encode({ content: turn.content, role: "user", ...(emo !== undefined ? { emotion: emo } : {}) } as Parameters<ObservingMemory["encode"]>[0]);
			} else {
				await runTurn(mainLlm, observed, turn.content);
			}
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
	const probeStats: ProbeStat[] = [];
	const rowByProbe = new Map<string, MutableRow>();
	const needsJudge: { probe: HumanlikeProbe; response: string; recalled: string[] }[] = [];
	for (const probe of scenario.probes) {
		const { response, markerEmitted, markerQuery } = await runTurn(mainLlm, observed, probe.triggerText);
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
		probeStats.push({ probeId: probe.id, family: probe.family, polarity: probe.polarity, bucket: outcome.bucket, markerQuery, targetRetrieved: trace.targetRetrieved });
		if (markerQuery) console.log(`      marker-q: "${markerQuery.slice(0, 80)}"`);
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

	return { outcomes, judged, recorded, rows, probeStats };
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
	const { note: providerNote } = buildBenchMemory(embedder); // note only; providers are built fresh per scenario below

	const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
	const provider = createOpenAICompatible({ name: "naia-gw", apiKey: KEY, baseURL: `${GATEWAY}/v1` });
	const mainLlm = new VercelClient(provider.chatModel(MAIN_MODEL), { defaultMaxTokens: 2048 });

	// 5-stab: N runs, FRESH memory per scenario (fixes cross-scenario leak +
	// gives a fair, noise-averaged comparison). HUMANLIKE_RUNS=N (default 1).
	const RUNS = Math.max(1, Number(process.env.HUMANLIKE_RUNS ?? 1) | 0);

	console.log(
		`[bench] human-like memory experience — LIVE (${RUNS} run${RUNS > 1 ? "s" : ""})\n` +
			`  gateway=${GATEWAY}  main=${MAIN_MODEL}  embed=${EMBED_MODEL}(${EMBED_DIMS}d)\n` +
			`  memory=${providerNote}\n` +
			`  set=${SCENARIO_SET}  seed=${DIRECT_SEED ? "direct" : "agent"}  reaction=${DIRECT_SEED ? (REACTION_ON ? "ON" : "off") : "n/a"}`,
	);

	const dist = new Map<string, { polarity: string; buckets: Record<string, number>; missQueries: string[]; retrieved: number }>();
	const outcomesRun0: PipelineOutcome[] = [];
	const judgedRun0: JudgedProbe[] = [];
	const recordedRun0: RecordedProbe[] = [];
	const rowsRun0: ReportRow[] = [];

	const scenarioSet = SCENARIO_SET === "salience" ? SALIENCE_SCENARIOS : HUMANLIKE_SCENARIOS;
	for (let run = 0; run < RUNS; run++) {
		if (RUNS > 1) console.log(`\n═══ run ${run + 1}/${RUNS} ═══`);
		for (const scenario of scenarioSet) {
			const { provider: mem } = buildBenchMemory(embedder); // FRESH per scenario
			const observed = new ObservingMemory(mem);
			const r = await runScenario(scenario, mainLlm, observed);
			await mem.close();
			for (const ps of r.probeStats) {
				const d = dist.get(ps.probeId) ?? { polarity: ps.polarity, buckets: {}, missQueries: [], retrieved: 0 };
				d.buckets[ps.bucket] = (d.buckets[ps.bucket] ?? 0) + 1;
				if (ps.targetRetrieved) d.retrieved++;
				if ((ps.bucket === "retrieval-miss" || ps.bucket === "no-recall-attempt") && ps.markerQuery) d.missQueries.push(ps.markerQuery);
				dist.set(ps.probeId, d);
			}
			if (run === 0) {
				outcomesRun0.push(...r.outcomes);
				judgedRun0.push(...r.judged);
				recordedRun0.push(...r.recorded);
				rowsRun0.push(...r.rows);
			}
		}
	}

	const s = summarize(outcomesRun0);
	console.log(`\n[run 1 summary] probes=${s.total}  det-pass=${s.deterministicPass}  det-fail=${s.deterministicFail}  needs-judge=${s.needsJudge}`);
	console.log(`  buckets: ${JSON.stringify(s.byBucket)}`);
	if (Object.keys(s.byFailureLayer).length) console.log(`  failure-layers: ${JSON.stringify(s.byFailureLayer)}`);
	if (judgedRun0.length > 0) {
		const jpass = judgedRun0.filter((j) => !j.agg.unreliable && j.agg.pass).length;
		const junrel = judgedRun0.filter((j) => j.agg.unreliable).length;
		console.log(`  judged (social-quality): ${jpass}/${judgedRun0.length} pass` + (junrel ? `, ${junrel} unreliable` : ""));
	}

	// Multi-run distribution — the fair lite-vs-naia signal + marker-query diagnosis.
	console.log(`\n[multi-run] ${RUNS} run(s) — per-probe bucket distribution (target retrieved N/${RUNS}):`);
	for (const [probeId, d] of dist) {
		const parts = Object.entries(d.buckets).sort((a, b) => b[1] - a[1]).map(([b, c]) => `${b}×${c}`).join(", ");
		console.log(`  ${probeId} [${d.polarity}]  retrieved ${d.retrieved}/${RUNS}  →  ${parts}`);
		if (d.missQueries.length) console.log(`      miss marker-q: ${d.missQueries.slice(0, 3).map((q) => `"${q.slice(0, 48)}"`).join(" | ")}`);
	}

	console.log("\n" + renderHumanlikeReport(rowsRun0));

	// Fixture recording (run 1) — HUMANLIKE_RECORD=<path> writes deterministic
	// observations for CI replay (no LLM). Judge scores omitted (unit-tested).
	const recordPath = process.env.HUMANLIKE_RECORD;
	if (recordPath) {
		const fixture: HumanlikeFixture = {
			version: HUMANLIKE_FIXTURE_VERSION,
			recordedAt: new Date().toISOString(),
			model: MAIN_MODEL,
			probes: recordedRun0,
		};
		writeFileSync(recordPath, JSON.stringify(fixture, null, "\t") + "\n");
		console.log(`\n[record] fixture written: ${recordPath} (${recordedRun0.length} probes)`);
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
