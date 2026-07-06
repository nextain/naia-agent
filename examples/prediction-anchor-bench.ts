/**
 * Prediction anchor — does the user's remembered past improve prediction of the
 * user's HELD-OUT choice? (HANDOFF-persona-formation §6 ①, the overfitting antidote.)
 *
 * A = memory-injected (the user's past preference statements are recalled and put
 *     in context). B = blind (no memory). Same probe, same model.
 *
 * WHY this axis (2026-07-06, apprivoiser discussion): "타 기억 대비 우수"라는 절대·
 * 경쟁 프레임은 검증이 어렵고 필터로 미끄러진다. 상대(ablation) + 예측이 검증을 쉽게
 * 만든다. 예측정확도는 "자아·기억이 실재하나"의 객관 proxy (⚠ telos 아님 — SoT).
 *
 * OVERFITTING GUARD: each probe's wording shares NO surface vocabulary with the
 * seed (마라톤 seed → 회식 투표 probe 식). A correct prediction therefore requires
 * GENERALIZING the preference, not string-matching. That is exactly the line
 * between real 길들임 (generalizes → predicts) and overfit (memorizes surface).
 *
 * This is a PREDICTION accuracy measure (objective), NOT a morality/appropriateness
 * filter. It asks "what will the user pick", never "what should naia say".
 *
 * Run (opt-in, credit protection):
 *   cd /var/home/luke/alpha-adk
 *   set -a; . <(tr -d '\r' < data-private/key/llm-key.env); set +a
 *   PREDICT_LIVE=1 PREDICT_RUNS=5 pnpm --dir projects/naia-agent exec \
 *     tsx examples/prediction-anchor-bench.ts
 * Without PREDICT_LIVE=1 or a key it prints how to run and exits 0 (CI-safe).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VercelClient } from "@nextain/agent-providers";
import type { LLMClient } from "@nextain/agent-types";

import { LiteMemoryProvider } from "/var/home/luke/alpha-adk/projects/naia-memory/src/memory/lite-provider.ts";
import { OpenAICompatEmbeddingProvider } from "/var/home/luke/alpha-adk/projects/naia-memory/src/memory/embeddings.ts";

const GATEWAY = (process.env.NAIA_GATEWAY_URL ??
	"https://naia-gateway-181404717065.asia-northeast3.run.app").replace(/\/+$/, "");
const MAIN_MODEL = process.env.PREDICT_MAIN_MODEL ?? "vertexai:gemini-3.5-flash";
const EMBED_MODEL = process.env.PREDICT_EMBED_MODEL ?? "vertexai:text-multilingual-embedding-002";
const EMBED_DIMS = Number(process.env.PREDICT_EMBED_DIMS ?? 768) | 0;
const KEY = (process.env.NAIA_PROD_KEY ?? "").trim(); // CRLF-tolerant

const SYSTEM =
	"너는 사용자를 오래 알고 지낸 친구야. 사용자가 어떤 선택을 할지 '예측'해. " +
	"조언이나 훈수가 아니라 사용자 본인이 실제로 뭘 고를지를 맞혀. " +
	"반드시 첫 줄에 `예측: A` 또는 `예측: B` 형식으로만 답하고, 다음 줄에 한 줄로 이유를 써.";

interface PredScenario {
	readonly id: string;
	/** Preference statements encoded into memory (the user's past). */
	readonly seed: readonly string[];
	/** The natural retrieval query an agent would search on for this probe. */
	readonly recallQuery: string;
	/** A held-out situation with NO seed-vocabulary overlap, forcing generalization. */
	readonly probe: string;
	/** The preference-consistent choice. */
	readonly correct: "A" | "B";
}

const SCENARIOS: readonly PredScenario[] = [
	{
		id: "PA-01-vegetarian",
		seed: [
			"나 3년 전부터 채식을 하고 있어. 윤리적인 이유라 웬만해선 안 흔들려.",
			"회식 자리에서도 고기는 안 먹고 사이드나 채소 위주로만 챙겨 먹어. 남들 눈치보다 내 신념이 더 중요해.",
		],
		recallQuery: "음식 취향 식습관 회식 메뉴 선택",
		// held-out: voting on a venue; vocabulary (투표/갈비/수제비) never in seed.
		probe:
			"이번 모임 장소를 다수결로 정한대. 후보는 (A) 소갈비 무한리필 (B) 들깨수제비 전문점. 내가 어디에 표를 던질 것 같아?",
		correct: "B",
	},
	{
		id: "PA-02-caffeine",
		seed: [
			"나 카페인에 되게 민감해. 예전에 오후에 커피 마시고 밤새 심장이 두근거려서 응급실 갈 뻔한 뒤로 조심해.",
			"요즘은 오후엔 무조건 디카페인만 마셔. 카페 가면 그것부터 확인하는 편이야.",
		],
		recallQuery: "카페 음료 선택 카페인 건강",
		// held-out: novel drinks (캐모마일/콜드브루) never in seed. correct = A here.
		probe:
			"오후 4시 미팅 카페에서 음료 하나 골라야 해. 후보는 (A) 캐모마일 티 (B) 콜드브루 더블샷. 내가 뭘 고를 것 같아?",
		correct: "A",
	},
	{
		id: "PA-03-morning",
		seed: [
			"나 완전 아침형이야. 밤 10시만 되면 눈이 감겨서 늦게까지 있는 자리는 질색이야.",
			"새벽에 일어나서 운동하는 게 하루 루틴이라 저녁 약속은 일찍 끝나는 걸 선호해.",
		],
		recallQuery: "생활 패턴 아침형 저녁 약속 시간대 선호",
		// held-out: novel activities (심야영화/등산) never in seed. correct = B.
		probe:
			"친구가 둘 중 하나 고르래. (A) 밤 9시 시작하는 심야 영화 (B) 아침 8시 등산 모임. 내가 뭘 택할 것 같아?",
		correct: "B",
	},
];

function extractText(content: { type: string; text?: string }[]): string {
	return content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}

/** Parse the forced `예측: A|B` first-line format. null = unparseable. */
function parsePrediction(text: string): "A" | "B" | null {
	const m = text.match(/예측\s*[:：]?\s*\(?\s*([AB])/i);
	return m ? (m[1]!.toUpperCase() as "A" | "B") : null;
}

async function predict(llm: LLMClient, probe: string, memoryContext: string[]): Promise<string> {
	const sys =
		memoryContext.length > 0
			? SYSTEM + "\n\n사용자에 대해 네가 아는 것(과거 발화):\n" + memoryContext.map((m) => `- ${m}`).join("\n")
			: SYSTEM;
	const res = await llm.generate({
		messages: [{ role: "user", content: probe }],
		system: sys,
		maxTokens: 256,
		temperature: 0.7,
	});
	return extractText(res.content as { type: string; text?: string }[]);
}

interface Tally {
	correct: number;
	wrong: number;
	unparsed: number;
	retrieved: number; // A-only: relevant memory actually recalled
}
const fresh = (): Tally => ({ correct: 0, wrong: 0, unparsed: 0, retrieved: 0 });

async function main() {
	if (process.env.PREDICT_LIVE !== "1" || !KEY) {
		console.log(
			"[skip] prediction-anchor LIVE bench는 opt-in입니다 (실 Gemini 크레딧 보호).\n" +
				"  실행: cd /var/home/luke/alpha-adk && set -a; . <(tr -d '\\r' < data-private/key/llm-key.env); set +a\n" +
				"        PREDICT_LIVE=1 PREDICT_RUNS=5 pnpm --dir projects/naia-agent exec tsx examples/prediction-anchor-bench.ts\n" +
				`  gateway=${GATEWAY} main=${MAIN_MODEL} embed=${EMBED_MODEL}(${EMBED_DIMS}d)  key=${KEY ? "SET" : "MISSING"}`,
		);
		process.exit(0);
	}

	const RUNS = Math.max(1, Number(process.env.PREDICT_RUNS ?? 5) | 0);
	const embedder = new OpenAICompatEmbeddingProvider(GATEWAY, KEY, EMBED_MODEL, EMBED_DIMS);
	const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
	const provider = createOpenAICompatible({ name: "naia-gw", apiKey: KEY, baseURL: `${GATEWAY}/v1` });
	const llm = new VercelClient(provider.chatModel(MAIN_MODEL), { defaultMaxTokens: 512 });

	console.log(
		`[bench] prediction anchor — LIVE (${RUNS} run${RUNS > 1 ? "s" : ""})\n` +
			`  gateway=${GATEWAY}  main=${MAIN_MODEL}  embed=${EMBED_MODEL}(${EMBED_DIMS}d)\n` +
			`  A = memory-injected   B = blind (baseline)   guard = held-out probe, no seed-vocab overlap`,
	);

	const withMem = fresh();
	const blind = fresh();
	const perScenario: Record<string, { a: Tally; b: Tally }> = {};

	for (let run = 0; run < RUNS; run++) {
		if (RUNS > 1) console.log(`\n═══ run ${run + 1}/${RUNS} ═══`);
		for (const sc of SCENARIOS) {
			perScenario[sc.id] ??= { a: fresh(), b: fresh() };
			// Fresh Lite store per scenario, seed the user's past.
			const dbPath = join(mkdtempSync(join(tmpdir(), "predict-")), "mem.db");
			const mem = new LiteMemoryProvider({ dbPath, embedder, writesEnabled: true });
			for (const s of sc.seed) await mem.encode({ content: s, role: "user" } as Parameters<LiteMemoryProvider["encode"]>[0]);
			const hits = (await mem.recall(sc.recallQuery, { topK: 4 })).map((h) => h.content);
			const retrieved = hits.some((h) => sc.seed.some((s) => h.includes(s.slice(0, 12))));

			// A: memory-injected
			const aText = await predict(llm, sc.probe, hits);
			const aPred = parsePrediction(aText);
			// B: blind
			const bText = await predict(llm, sc.probe, []);
			const bPred = parsePrediction(bText);
			await mem.close();

			const score = (pred: "A" | "B" | null, t: Tally) => {
				if (pred === null) t.unparsed++;
				else if (pred === sc.correct) t.correct++;
				else t.wrong++;
			};
			score(aPred, withMem);
			score(bPred, blind);
			score(aPred, perScenario[sc.id]!.a);
			score(bPred, perScenario[sc.id]!.b);
			if (retrieved) { withMem.retrieved++; perScenario[sc.id]!.a.retrieved++; }

			console.log(
				`  ${sc.id} (정답 ${sc.correct})  A[mem]=${aPred ?? "?"}${aPred === sc.correct ? "✓" : "✗"} (retrieved ${retrieved ? "Y" : "·"})` +
					`   B[blind]=${bPred ?? "?"}${bPred === sc.correct ? "✓" : "✗"}`,
			);
		}
	}

	const N = RUNS * SCENARIOS.length;
	const acc = (t: Tally) => `${t.correct}/${N} (${((t.correct / N) * 100).toFixed(0)}%)  wrong=${t.wrong} unparsed=${t.unparsed}`;
	console.log(`\n[result] N=${N} predictions per condition (${SCENARIOS.length} scenarios × ${RUNS} runs)`);
	console.log(`  A  memory-injected : ${acc(withMem)}   relevant-retrieved=${withMem.retrieved}/${N}`);
	console.log(`  B  blind baseline  : ${acc(blind)}`);
	const lift = ((withMem.correct - blind.correct) / N) * 100;
	console.log(`  → memory lift = ${lift >= 0 ? "+" : ""}${lift.toFixed(0)} pp  (A − B accuracy)`);
	console.log(`\n[per-scenario]`);
	for (const [id, { a, b }] of Object.entries(perScenario)) {
		console.log(`  ${id}: A ${a.correct}/${RUNS}  B ${b.correct}/${RUNS}  (retrieved ${a.retrieved}/${RUNS})`);
	}
	console.log(
		`\n⚠ 예측정확도는 proxy이지 telos 아님(SoT). first-probe: ${SCENARIOS.length} 시나리오·N=${RUNS}, ` +
			`Lite(cosine) 회상, 위치편향 완화(정답 B/A/B). baseline=blind gemini.`,
	);
}

main().then(
	() => process.exit(0),
	(e) => {
		console.error(`✗ prediction-anchor bench FAILED: ${(e as Error).stack ?? (e as Error).message}`);
		process.exit(1);
	},
);
