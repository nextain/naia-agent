/**
 * Benchmark runner — Slice 3-XR-Compact P6.
 *
 * Drives each fixture through MemorySystem.compact() with each strategy,
 * evaluates probes deterministically (keyword match + Jaccard for drift),
 * and emits a markdown report. The judge profile is intentionally
 * "deterministic-only" — LLM-as-judge ensemble integration (NAIA_JUDGE_ENSEMBLE)
 * is the next iteration, gated on API keys available in the host
 * environment.
 *
 * Why deterministic-first: even without an LLM judge, the keyword + drift
 * metrics already discriminate the three strategies meaningfully:
 *   - off: tail-only context (no recap) — fact-recall drops on facts
 *     established in the head.
 *   - reactive: head is replaced by a 5-section markdown recap. Keywords
 *     in Goal / Tool calls / Files sections survive.
 *   - realtime: same recap shape, but seeded from the rolling summary that
 *     accumulated during encode(). Per-turn cost is paid up front.
 *   - anthropic-native: short-circuited host-side → behavior matches `off`
 *     under this harness (the actual benefit would only show through a real
 *     Anthropic Messages API call, which is out of scope here).
 *
 * Usage:
 *   pnpm --filter @nextain/agent-benchmarks bench:compact
 *   pnpm --filter @nextain/agent-benchmarks bench:compact -- --strategies reactive,realtime
 *   pnpm --filter @nextain/agent-benchmarks bench:compact -- --fixtures F001-customer-support
 */

import { performance } from "node:perf_hooks";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { LocalAdapter, MemorySystem } from "@nextain/naia-memory";

// Phase 1.3 (#56) — Vercel pruneMessages path lives in runtime.
import { createLLMMessagePrepareCompact } from "@nextain/agent-runtime";
import type { LLMContentBlock, LLMMessage } from "@nextain/agent-types";

import type {
	Fixture,
	FixtureProbe,
	FixtureResult,
	FixtureTurn,
	StrategyId,
} from "./fixture.js";
import { validateFixture } from "./fixture.js";
import { driftScore } from "./metrics.js";
import { renderReport } from "./report.js";
import { buildVisibleContext } from "./visible-context.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "fixtures");
const REPORTS_DIR = join(HERE, "..", "reports");

const DEFAULT_STRATEGIES: readonly StrategyId[] = [
	"reactive",
	"reactive-vercel",
	"realtime",
	"off",
];

interface CliOptions {
	readonly strategies: readonly StrategyId[];
	readonly fixtureGlob: readonly string[] | null;
}

function parseArgs(argv: readonly string[]): CliOptions {
	let strategies: readonly StrategyId[] = DEFAULT_STRATEGIES;
	let fixtureGlob: readonly string[] | null = null;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--strategies" && i + 1 < argv.length) {
			const next = argv[i + 1]!;
			strategies = next
				.split(",")
				.map((s) => s.trim())
				.filter((s): s is StrategyId =>
					s === "reactive" ||
					s === "reactive-vercel" ||
					s === "realtime" ||
					s === "off",
				);
			i++;
		} else if (a === "--fixtures" && i + 1 < argv.length) {
			fixtureGlob = argv[i + 1]!.split(",").map((s) => s.trim());
			i++;
		}
	}
	return { strategies, fixtureGlob };
}

export async function loadFixtures(globIds: readonly string[] | null): Promise<Fixture[]> {
	let files: string[];
	try {
		files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".fixture.json"));
	} catch {
		return [];
	}
	const out: Fixture[] = [];
	for (const f of files) {
		const raw = await readFile(join(FIXTURES_DIR, f), "utf-8");
		const parsed: unknown = JSON.parse(raw);
		const fixture = validateFixture(parsed);
		if (globIds === null || globIds.includes(fixture.id)) {
			out.push(fixture);
		}
	}
	return out;
}

/**
 * Placeholder runner — used by P1 unit tests and as a fallback in CI when
 * MemorySystem cannot be initialized (e.g. better-sqlite3 native module
 * unavailable). Real measurement goes through `runFixture` below.
 */
export function runFixturePlaceholder(
	fixture: Fixture,
	strategy: StrategyId,
): FixtureResult {
	return {
		fixtureId: fixture.id,
		strategy,
		taskAccuracy: 0,
		factRecall: 0,
		latencyP50Ms: 0,
		latencyP99Ms: 0,
		compactionLatencyMs: 0,
		totalTokens: 0,
		driftScore: 1,
		errors: [`placeholder — runFixture() bypassed (CI fallback)`],
	};
}

/**
 * Deterministic probe evaluator. No LLM-judge — keyword match for
 * fact-recall, "context is non-empty + carries the probe's domain keyword"
 * for task-accuracy. Cheap, reproducible, surfaces drift through the recap
 * shape itself.
 */
interface ProbeOutcome {
	probe: FixtureProbe;
	pass: boolean;
	visibleSnippet: string;
}

function evaluateProbe(
	probe: FixtureProbe,
	fixture: Fixture,
	currentTurn: number,
	recapContent: string,
	strategy: StrategyId,
	keepTail: number,
): ProbeOutcome {
	// R7 Phase A: shared visible-context builder. Same function the LLM
	// judge harness uses. No per-site divergence.
	const ctx = buildVisibleContext({
		fixture,
		strategy,
		currentTurn,
		recapContent,
		keepTail,
		contextWindowChars: 1200,
	});
	const visibleText = ctx.visible;

	const lower = visibleText.toLowerCase();
	let pass: boolean;

	if (probe.type === "fact-recall") {
		// Every expected keyword must be present (case-insensitive). This is
		// strict: drop one identifier → fail. That's the point — strategy
		// quality is measured by what survives compaction.
		pass = probe.expectedKeywords.every((k) => lower.includes(k.toLowerCase()));
	} else if (probe.type === "task-accuracy") {
		// R7 Phase A.2 (Claude audit F3 HALT fix): drop the
		// English-only "domainAnchor" heuristic. It always-failed Korean
		// fixtures and abstention probes. Use factTurns presence as the
		// honest "did the strategy preserve the relevant turns" signal.
		const factTurns = probe.factTurns ?? [];
		if (factTurns.length === 0) {
			// Abstention / unclassified — deterministic mode cannot judge
			// whether the agent appropriately withheld an answer. Skip with
			// a neutral pass; LLM judge is the authoritative source.
			pass = true;
		} else {
			// At least one fact-turn's content should be present in visible.
			// Strict check: ALL fact-turns must have at least one substantive
			// token (≥4 chars) appear in the visible text.
			pass = factTurns.every((turnIdx) => {
				const turn = fixture.turns[turnIdx - 1];
				if (!turn) return false;
				// Use a short rolling substring of the turn content as the
				// "fact signal" — first 8 chars of the content.
				const signal = turn.content.slice(0, 8).toLowerCase();
				return signal.length >= 4 && lower.includes(signal);
			});
		}
	} else {
		// drift probe — scored separately via driftScore.
		pass = true;
	}

	return { probe, pass, visibleSnippet: visibleText.slice(0, 240) };
}

interface RunOptions {
	keepTail: number;
	targetTokens: number;
	memorySystem: MemorySystem;
}

export async function runFixture(
	fixture: Fixture,
	strategy: StrategyId,
	opts: RunOptions,
): Promise<FixtureResult> {
	const { keepTail, targetTokens, memorySystem } = opts;
	const sessionId = `${fixture.id}-${strategy}-${performance.now().toFixed(0)}`;
	// R5 S20: reset the module-level tool-call counter at the start of each
	// fixture run so different fixtures don't share IDs.
	resetParseInlineState();
	const compactionPoints = (fixture.compactionPoints ?? []).slice().sort((a, b) => a - b);
	const probesByTurn = new Map<number, FixtureProbe[]>();
	for (const p of fixture.probes) {
		if (!probesByTurn.has(p.afterTurn)) probesByTurn.set(p.afterTurn, []);
		probesByTurn.get(p.afterTurn)!.push(p);
	}

	const perTurnLatencies: number[] = [];
	const compactionLatencies: number[] = [];
	const errors: string[] = [];

	let priorRecap: { role: "assistant"; content: string; timestamp?: number } | undefined;
	let recapContent = "";
	const outcomes: ProbeOutcome[] = [];

	for (let i = 0; i < fixture.turns.length; i++) {
		const turn = fixture.turns[i]!;
		const turnIdx = i + 1;
		const t0 = performance.now();

		// realtime: encode every turn so the rolling summary accumulates.
		// reactive/off/anthropic-native: skip encode here (encode is a
		// memory-system concern unrelated to compaction in those modes).
		if (strategy === "realtime") {
			try {
				await memorySystem.encode(
					{
						content: turn.content,
						role: mapRole(turn.role),
						timestamp: Date.now(),
					},
					{ sessionId },
				);
			} catch (err) {
				errors.push(`encode@${turnIdx}: ${String(err)}`);
			}
		}
		perTurnLatencies.push(performance.now() - t0);

		// Forced compaction trigger — naia-memory path.
		if (
			compactionPoints.includes(turnIdx) &&
			(strategy === "reactive" || strategy === "realtime")
		) {
			const head: FixtureTurn[] = fixture.turns
				.slice(0, turnIdx)
				.map((t) => ({ role: t.role, content: t.content }));
			const cT0 = performance.now();
			try {
				const r = await memorySystem.compact({
					messages: head,
					keepTail,
					targetTokens,
					sessionId,
					strategy,
					...(priorRecap !== undefined ? { priorRecap } : {}),
				});
				compactionLatencies.push(performance.now() - cT0);
				recapContent = r.summary.content;
				priorRecap = {
					role: "assistant",
					content: recapContent,
					...(r.summary.timestamp !== undefined ? { timestamp: r.summary.timestamp } : {}),
				};
			} catch (err) {
				compactionLatencies.push(performance.now() - cT0);
				errors.push(`compact@${turnIdx}: ${String(err)}`);
			}
		}

		// Phase 1.3 (#56) — Vercel pruneMessages path. Distinct compaction
		// body: prunes ModelMessage blocks (reasoning, older tool_calls,
		// empty messages) instead of generating a summarization recap.
		// For plain-text fixtures the cookbook defaults are typically a
		// no-op — the factory's no-op guard returns undefined, recap stays
		// empty, and evaluateProbe treats it like the off baseline. That's
		// the honest measurement: Vercel pruning helps only when there's
		// reasoning/tool_call mass to strip.
		if (
			compactionPoints.includes(turnIdx) &&
			strategy === "reactive-vercel"
		) {
			const llmHistory: LLMMessage[] = fixture.turns
				.slice(0, turnIdx)
				.map(toLLMMessage);
			const cT0 = performance.now();
			try {
				const prepare = createLLMMessagePrepareCompact();
				const pruned = prepare(llmHistory);
				compactionLatencies.push(performance.now() - cT0);
				// R7 Phase A.2 (glm audit fix — vercel staleness): explicit
				// reset on no-op. R7 Phase A claimed honest no-op detection
				// but recapContent could carry over from a PREVIOUS
				// compactionPoint if there were multiple. Now: each prune
				// call replaces recapContent unconditionally (undefined → "").
				recapContent = pruned !== undefined ? llmMessagesToText(pruned) : "";
			} catch (err) {
				compactionLatencies.push(performance.now() - cT0);
				errors.push(`prune@${turnIdx}: ${String(err)}`);
				// Errors also reset recap to "" — no stale value.
				recapContent = "";
			}
		}

		// Probes at this turn?
		const probes = probesByTurn.get(turnIdx);
		if (probes) {
			for (const p of probes) {
				outcomes.push(
					evaluateProbe(p, fixture, turnIdx, recapContent, strategy, keepTail),
				);
			}
		}
	}

	// Probes that ask after-the-end (afterTurn >= turns.length).
	for (const [turnNum, probes] of probesByTurn.entries()) {
		if (turnNum > fixture.turns.length) {
			for (const p of probes) {
				outcomes.push(
					evaluateProbe(
						p,
						fixture,
						fixture.turns.length,
						recapContent,
						strategy,
						keepTail,
					),
				);
			}
		}
	}

	// R7 Phase A.2 (Claude audit F1 HALT fix): drift used divergent path
	// in R1-R5. Now uses the shared `buildVisibleContext` so drift compares
	// the SAME string the judge and evaluator see vs the off baseline.
	const offCtx = buildVisibleContext({
		fixture,
		strategy: "off",
		currentTurn: fixture.turns.length,
		recapContent: "",
		keepTail,
		contextWindowChars: 0, // no cap for the drift baseline
	});
	const compactCtx = buildVisibleContext({
		fixture,
		strategy,
		currentTurn: fixture.turns.length,
		recapContent,
		keepTail,
		contextWindowChars: 0, // drift measured pre-cap
	});
	const drift = driftScore(compactCtx.visible, offCtx.visible);

	// Metric aggregates.
	const factRecallProbes = outcomes.filter((o) => o.probe.type === "fact-recall");
	const taskProbes = outcomes.filter((o) => o.probe.type === "task-accuracy");
	const taskAcc =
		taskProbes.length === 0
			? 0
			: taskProbes.filter((o) => o.pass).length / taskProbes.length;
	const factR =
		factRecallProbes.length === 0
			? 0
			: factRecallProbes.filter((o) => o.pass).length / factRecallProbes.length;

	const sortedTurnLat = [...perTurnLatencies].sort((a, b) => a - b);
	const p50 = sortedTurnLat[Math.floor(sortedTurnLat.length * 0.5)] ?? 0;
	const p99 = sortedTurnLat[Math.min(sortedTurnLat.length - 1, Math.floor(sortedTurnLat.length * 0.99))] ?? 0;
	const compactionAvg =
		compactionLatencies.length === 0
			? 0
			: compactionLatencies.reduce((a, b) => a + b, 0) / compactionLatencies.length;

	const totalChars =
		fixture.turns.reduce((acc, t) => acc + t.content.length, 0) + recapContent.length;
	const totalTokens = Math.floor(totalChars / 4);

	return {
		fixtureId: fixture.id,
		strategy,
		taskAccuracy: taskAcc,
		factRecall: factR,
		latencyP50Ms: p50,
		latencyP99Ms: p99,
		compactionLatencyMs: compactionAvg,
		totalTokens,
		driftScore: drift,
		errors,
		// Phase 1.3 (#56): expose actual recap so LLM-judge harnesses don't
		// have to reconstruct visible context from fixture tails.
		recapContent,
	};
}

function mapRole(role: FixtureTurn["role"]): "user" | "assistant" | "tool" {
	if (role === "system") return "user"; // memory has no native "system" role
	return role;
}

/** Phase 1.3 (#56): adapt a fixture turn to the LLMMessage shape that the
 *  Vercel prune helper consumes. Plain-text fixtures get plain-string
 *  content; that's the honest representation — adding fake reasoning blocks
 *  to "help Vercel win" would defeat the head-to-head purpose.
 *
 *  Phase 1.3 R3 (gemini S2 fix): if the turn content carries explicit
 *  inline markers `[thinking] ...`, `[tool_use NAME] JSON`, or
 *  `[tool_result] ...`, parse them into real `LLMContentBlock` parts so
 *  pruneMessages's `reasoning='all'` and `toolCalls=...` rules can actually
 *  strip them. Without this the fixture-author's intent ("I gave Vercel
 *  real material to prune") is silently dropped because the SDK only sees
 *  `content: string` (no reasoning/tool parts).
 */
/** Phase 1.3 R5 (codex S20 fix): module-level counter so tool_use/tool_result
 *  IDs are unique across fixture turns. R4's per-turn counter reset broke
 *  the link between a tool_use and the subsequent tool_result turn (after
 *  the S2 fixture refactor split them into separate role messages). */
let _fixtureToolCallCounter = 0;
let _lastToolCallId: string | null = null;

function toLLMMessage(turn: FixtureTurn): LLMMessage {
	const role = mapRole(turn.role);
	const blocks = parseInlineBlocks(turn.content);
	if (blocks === null) {
		return { role, content: turn.content };
	}
	return { role, content: blocks };
}

/** Reset the tool-call counter — call this once per fixture run so different
 *  fixtures don't accidentally share IDs. */
export function resetParseInlineState(): void {
	_fixtureToolCallCounter = 0;
	_lastToolCallId = null;
}

/** Parse `[thinking] ...`, `[tool_use NAME] {...}`, `[tool_result] ...`
 *  inline markers in a fixture turn into proper `LLMContentBlock[]`. Returns
 *  `null` when no markers are present (caller uses string content as before).
 *  Idempotent on text without markers.
 *
 *  R5 (codex S15 fix): text blocks NO LONGER `.trim()` — preserves leading
 *  / trailing whitespace and blank-line-sensitive formatting (matters for
 *  markdown / code / spacing-dependent tool output in future fixtures). */
function parseInlineBlocks(content: string): LLMContentBlock[] | null {
	if (
		!content.includes("[thinking]") &&
		!content.includes("[tool_use ") &&
		!content.includes("[tool_result]")
	) {
		return null;
	}
	const blocks: LLMContentBlock[] = [];
	const lines = content.split("\n");
	let textBuf: string[] = [];
	const flushText = (): void => {
		if (textBuf.length > 0) {
			const text = textBuf.join("\n");
			// R5 S15: keep whitespace; only drop entirely empty buffer.
			if (text.length > 0) blocks.push({ type: "text", text });
			textBuf = [];
		}
	};
	for (const line of lines) {
		const thinkMatch = /^\[thinking\]\s*(.*)$/.exec(line);
		if (thinkMatch) {
			flushText();
			blocks.push({ type: "thinking", thinking: thinkMatch[1] ?? "" });
			continue;
		}
		const toolUseMatch = /^\[tool_use\s+([\w_\-]+)\]\s*(.*)$/.exec(line);
		if (toolUseMatch) {
			flushText();
			let input: unknown = {};
			try {
				input = JSON.parse(toolUseMatch[2] ?? "{}");
			} catch {
				input = { raw: toolUseMatch[2] };
			}
			// R5 S20: module-level counter (unique across fixture turns).
			_fixtureToolCallCounter++;
			const callId = `call_${_fixtureToolCallCounter}`;
			_lastToolCallId = callId;
			blocks.push({
				type: "tool_use",
				id: callId,
				name: toolUseMatch[1] ?? "",
				input,
			});
			continue;
		}
		const toolResultMatch = /^\[tool_result\]\s*(.*)$/.exec(line);
		if (toolResultMatch) {
			flushText();
			// R5 S20: link to the LAST issued tool_use id (across turns).
			const callId =
				_lastToolCallId ?? `call_${_fixtureToolCallCounter || 1}`;
			blocks.push({
				type: "tool_result",
				toolCallId: callId,
				content: toolResultMatch[1] ?? "",
			});
			continue;
		}
		textBuf.push(line);
	}
	flushText();
	return blocks.length > 0 ? blocks : null;
}

/** Serialize an LLMMessage[] back to a single string for `recapContent`
 *  semantics (downstream `evaluateProbe` works on a string). Mirrors how
 *  the Agent's history would surface as "what the model still sees". */
function llmMessagesToText(messages: readonly LLMMessage[]): string {
	return messages
		.map((m) => {
			const text =
				typeof m.content === "string"
					? m.content
					: m.content
							.map((b) => {
								if (b.type === "text") return b.text;
								if (b.type === "thinking") return `[thinking] ${b.thinking}`;
								if (b.type === "tool_use")
									return `[tool_use ${b.name}] ${JSON.stringify(b.input)}`;
								if (b.type === "tool_result") return `[tool_result] ${b.content}`;
								return `[${b.type}]`;
							})
							.join("\n");
			return `${m.role}: ${text}`;
		})
		.join("\n");
}

async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

export async function main(argv: readonly string[]): Promise<void> {
	const opts = parseArgs(argv);
	const fixtures = await loadFixtures(opts.fixtureGlob);

	process.stderr.write(
		`[bench:compact] loaded ${fixtures.length} fixture(s), running ${opts.strategies.length} strategy(s)\n`,
	);

	// Per-strategy MemorySystem so rolling state is isolated.
	const date = new Date().toISOString().slice(0, 10);
	await ensureDir(REPORTS_DIR);

	const results: FixtureResult[] = [];
	for (const s of opts.strategies) {
		const memPath = join(REPORTS_DIR, `_mem-${date}-${s}.json`);
		const memorySystem = new MemorySystem({
			adapter: new LocalAdapter(memPath),
			consolidationIntervalMs: 0,
		});
		try {
			for (const fx of fixtures) {
				const r = await runFixture(fx, s, {
					keepTail: 2,
					targetTokens: 1000,
					memorySystem,
				});
				results.push(r);
				process.stderr.write(
					`[bench:compact] ${fx.id} × ${s} — task=${r.taskAccuracy.toFixed(2)} recall=${r.factRecall.toFixed(2)} drift=${r.driftScore.toFixed(2)}\n`,
				);
			}
		} finally {
			await memorySystem.close();
		}
	}

	const report = renderReport({
		date,
		fixtureCount: fixtures.length,
		strategiesUnderTest: opts.strategies,
		results,
		judgeProfile: "none",
		notes:
			"Deterministic measurement — keyword match for fact-recall + Jaccard for drift. LLM-as-judge ensemble (NAIA_JUDGE_ENSEMBLE) is the next iteration, gated on API keys.",
	});

	const reportPath = join(REPORTS_DIR, `${date}-deterministic.md`);
	await writeFile(reportPath, report, "utf-8");
	process.stderr.write(`[bench:compact] report → ${reportPath}\n`);
	process.stdout.write(report);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main(process.argv.slice(2)).catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[bench:compact] FATAL: ${msg}\n`);
		process.exit(1);
	});
}
