/**
 * Prediction anchor v3 — HARD scenarios that break the v2 ceiling.
 *
 * v2 hit memory=100% because seeds STATED the preference and the situation was a
 * clear application — an easy task. v3 raises difficulty on four levers so a
 * <100% band opens and we can see gradients (needed to measure persona-formation
 * degree later):
 *   - IMPLICIT: the preference is never stated; it must be inferred from an
 *     anecdote/behavior ("삼겹살집에서 상추만 구워 먹었어" → vegetarian).
 *   - NOISE: the signal memory is buried among unrelated distractor memories.
 *   - RECENCY: the preference CHANGED; the latest state supersedes the old one
 *     (both get retrieved — the model must weigh recency).
 *   - NUANCE/CONTEXT: a naive one-line application picks WRONG; the real
 *     preference is context-dependent or has an overriding recent constraint.
 *
 * Diagnostic split: for the memory condition we record whether the SIGNAL memory
 * was actually retrieved, so a miss is attributed to retrieval vs use.
 *
 * Same objective, position-bias-controlled design as v2 (randomized option order,
 * `예측: A|B` forced format). Prediction accuracy, NOT a morality filter.
 *
 * Run:
 *   cd /var/home/luke/alpha-adk
 *   set -a; . <(tr -d '\r' < data-private/key/llm-key.env); set +a
 *   PREDICT_LIVE=1 PREDICT_RUNS=5 pnpm --dir projects/naia-agent exec \
 *     tsx examples/prediction-anchor-v3.ts
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
const KEY = (process.env.NAIA_PROD_KEY ?? "").trim();
// Retrieval-stress knob: append N generic filler memories to EVERY scenario to
// bury the signal deeper (the base run showed 8 distractors don't challenge Lite
// cosine — signal retrieved 5/5). PREDICT_NOISE=30 starves recall; if the signal
// falls out of top-k, memory prediction should drop → attributable to retrieval.
const EXTRA_NOISE = Math.max(0, Number(process.env.PREDICT_NOISE ?? 0) | 0);

const SYSTEM =
	"너는 사용자를 오래 알고 지낸 친구야. 사용자가 어떤 선택을 할지 '예측'해. " +
	"조언이나 훈수가 아니라 사용자 본인이 실제로 뭘 고를지를 맞혀. " +
	"반드시 첫 줄에 `예측: A` 또는 `예측: B` 형식으로만 답하고, 다음 줄에 한 줄로 이유를 써.";

interface HardScenario {
	readonly id: string;
	readonly lever: "implicit" | "noise" | "recency" | "nuance";
	/** seed[0] = the SIGNAL memory (implicit or latest). rest = supporting. */
	readonly seed: readonly string[];
	/** Unrelated memories encoded alongside to bury the signal. */
	readonly distractors: readonly string[];
	readonly recallQuery: string;
	readonly situation: string;
	readonly correctOption: string;
	readonly wrongOption: string;
}

const NOISE_POOL = [
	"요즘 넷플릭스에서 다큐 하나 정주행 중이야.",
	"지난주에 지하철에 우산을 놓고 내렸어.",
	"새 이어폰 하나 샀는데 음질이 괜찮더라.",
	"오늘 점심은 그냥 김밥으로 때웠어.",
	"주말에 방 정리 좀 했더니 개운해.",
	"회사 근처에 카페가 새로 하나 생겼더라.",
	"어제 비 와서 우산 챙겨 나갔어.",
	"핸드폰 액정에 필름 새로 붙였어.",
];

/** Generate `n` varied generic filler memories (unrelated to any preference) to
 *  stress retrieval. Varied text → distinct embeddings that crowd the top-k. */
function fillerNoise(n: number): string[] {
	const topics = ["버스", "택배", "날씨", "커피", "책", "영화", "청소", "산책", "설거지", "충전기", "양말", "메일", "회의", "간식", "화분", "우편", "리모컨", "슬리퍼", "달력", "물병"];
	const out: string[] = [];
	for (let i = 0; i < n; i++) {
		const t = topics[i % topics.length]!;
		out.push(`오늘 ${t} 관련해서 사소한 일이 하나 있었는데 별건 아니었어 (${i + 1}).`);
	}
	return out;
}

const SCENARIOS: readonly HardScenario[] = [
	{
		id: "H-01-implicit-veg",
		lever: "implicit",
		// preference (vegetarian) is never stated — inferred from behavior.
		seed: [
			"지난 회식 때 다들 삼겹살 시키는데 나는 계속 상추랑 버섯만 구워 먹었어. 사장님이 고기 더 드시라는데 괜찮다고 했지.",
			"사실 요즘 마트 가도 정육 코너는 그냥 지나쳐.",
		],
		distractors: [],
		recallQuery: "회식 음식 먹는 방식 장보기",
		situation: "모임 장소를 다수결로 정한대.",
		correctOption: "채소 비빔밥 전문점",
		wrongOption: "숯불 정육 식당",
	},
	{
		id: "H-02-recency-change",
		lever: "recency",
		// old state (야행성) is superseded by the latest (일찍 잠).
		seed: [
			"작년에 애기 태어나고부터 생활이 완전 바뀌었어. 요즘은 밤 9시만 되면 나도 모르게 곯아떨어져.",
			"예전엔 내가 완전 야행성이었지. 새벽 3시까지 게임하고 그랬어.",
		],
		distractors: [],
		recallQuery: "요즘 수면 생활 리듬 저녁",
		situation: "번개 모임 시간을 정하는데.",
		correctOption: "저녁 7시 이른 모임",
		wrongOption: "밤 11시 심야 모임",
	},
	{
		id: "H-03-nuance-quality",
		lever: "nuance",
		// frugal BUT quality-for-daily-use → naive "frugal→cheap" picks wrong.
		seed: [
			"나 웬만하면 아끼는데, 매일 쓰는 물건은 좀 좋은 걸 사는 편이야. 싼 거 샀다가 금방 망가져서 다시 사는 게 더 손해더라고.",
		],
		distractors: [],
		recallQuery: "소비 성향 구매 물건 고르는 기준",
		situation: "매일 8시간씩 앉을 사무용 의자를 사는데.",
		correctOption: "튼튼한 브랜드 의자 (좀 비쌈)",
		wrongOption: "제일 싼 보급형 의자",
	},
	{
		id: "H-04-implicit-introvert",
		lever: "implicit",
		seed: [
			"지난 주말 동창회 갔다가 한 시간 만에 조용히 빠져나왔어. 사람 많은 데 있으니까 진이 다 빠지더라고.",
			"그냥 집에 오니까 그렇게 편할 수가 없더라.",
		],
		distractors: [],
		recallQuery: "모임 사교 사람 많은 자리 에너지",
		situation: "이번 주말 약속을 둘 중 하나로 정한대.",
		correctOption: "카페에서 둘이 조용히 수다",
		wrongOption: "루프탑 단체 파티",
	},
	{
		id: "H-05-nuance-override",
		lever: "nuance",
		// standing love of spicy, but an overriding recent constraint (diet).
		seed: [
			"나 매운 거라면 환장하는 사람인데, 이번 달은 다이어트 중이라 야식이랑 기름진 건 아예 딱 끊었어.",
		],
		distractors: [],
		recallQuery: "야식 음식 다이어트 요즘",
		situation: "밤 11시에 출출한데 뭐 할지.",
		correctOption: "그냥 물 마시고 참기",
		wrongOption: "매운 마라탕 배달",
	},
	{
		id: "H-06-implicit-cold",
		lever: "implicit",
		seed: [
			"저번 겨울에 제주도 갔다가 바람 때문에 얼어 죽는 줄 알았잖아. 그 뒤로 다시는 추운 데로 여행 안 가기로 했어.",
			"난 그냥 여름 휴가만 손꼽아 기다리는 사람이야.",
		],
		distractors: [],
		recallQuery: "여행 계절 추위 더위",
		situation: "회사 워크숍 장소를 투표한대.",
		correctOption: "여름 남해 해변 리조트",
		wrongOption: "겨울 대관령 설산 스키장",
	},
	{
		id: "H-07-noise-buried",
		lever: "noise",
		// single signal (향 질색) buried in a pile of distractors.
		seed: [
			"나 향 강한 거 진짜 질색이야. 향수도 무조건 무향만 쓰고, 방향제도 향 세면 머리 아파.",
		],
		distractors: NOISE_POOL,
		recallQuery: "냄새 향 선호 민감",
		situation: "내가 쓸 핸드크림을 하나 고르는데.",
		correctOption: "무향 핸드크림",
		wrongOption: "장미향 가득한 핸드크림",
	},
	{
		id: "H-08-nuance-context",
		lever: "nuance",
		// planner at work BUT spontaneous at play → naive "planner→rigid" wrong.
		seed: [
			"나 일할 땐 계획을 빡빡하게 세우는 사람인데, 여행만큼은 또 좀 풀어놓는 편이야. 놀 때까지 분 단위로 짜면 숨 막히더라고.",
		],
		distractors: [],
		recallQuery: "여행 계획 스타일 즉흥",
		situation: "이번 휴가 여행 일정을 어떻게 짤지.",
		correctOption: "큰 틀만 잡고 나머지는 즉흥으로",
		wrongOption: "분 단위로 꽉 짜인 완벽 일정",
	},
];

function extractText(content: { type: string; text?: string }[]): string {
	return content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}
function parsePrediction(text: string): "A" | "B" | null {
	const m = text.match(/예측\s*[:：]?\s*\(?\s*([AB])/i);
	return m ? (m[1]!.toUpperCase() as "A" | "B") : null;
}
async function predict(llm: LLMClient, probe: string, memoryContext: string[]): Promise<string> {
	const sys =
		memoryContext.length > 0
			? SYSTEM + "\n\n사용자에 대해 네가 아는 것(과거 발화):\n" + memoryContext.map((m) => `- ${m}`).join("\n")
			: SYSTEM;
	const res = await llm.generate({ messages: [{ role: "user", content: probe }], system: sys, maxTokens: 256, temperature: 0.7 });
	return extractText(res.content as { type: string; text?: string }[]);
}

interface Tally { correct: number; wrong: number; unparsed: number; pickA: number; }
const fresh = (): Tally => ({ correct: 0, wrong: 0, unparsed: 0, pickA: 0 });
function score(pred: "A" | "B" | null, correctLabel: "A" | "B", t: Tally): void {
	if (pred === null) { t.unparsed++; return; }
	if (pred === "A") t.pickA++;
	if (pred === correctLabel) t.correct++; else t.wrong++;
}

async function main() {
	if (process.env.PREDICT_LIVE !== "1" || !KEY) {
		console.log(
			"[skip] prediction-anchor v3 LIVE bench는 opt-in입니다 (실 Gemini 크레딧 보호).\n" +
				"  실행: cd /var/home/luke/alpha-adk && set -a; . <(tr -d '\\r' < data-private/key/llm-key.env); set +a\n" +
				"        PREDICT_LIVE=1 PREDICT_RUNS=5 pnpm --dir projects/naia-agent exec tsx examples/prediction-anchor-v3.ts\n" +
				`  gateway=${GATEWAY} main=${MAIN_MODEL} key=${KEY ? "SET" : "MISSING"}`,
		);
		process.exit(0);
	}
	const RUNS = Math.max(1, Number(process.env.PREDICT_RUNS ?? 5) | 0);
	const embedder = new OpenAICompatEmbeddingProvider(GATEWAY, KEY, EMBED_MODEL, EMBED_DIMS);
	const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
	const provider = createOpenAICompatible({ name: "naia-gw", apiKey: KEY, baseURL: `${GATEWAY}/v1` });
	const llm = new VercelClient(provider.chatModel(MAIN_MODEL), { defaultMaxTokens: 512 });

	console.log(
		`[bench] prediction anchor v3 (HARD) — LIVE (${RUNS} runs, ${SCENARIOS.length} scenarios)\n` +
			`  main=${MAIN_MODEL}  levers=implicit/noise/recency/nuance  order randomized  extra-noise=${EXTRA_NOISE}\n` +
			`  A = memory-injected   B = blind   (memory also reports signal-retrieval to split retrieval vs use)`,
	);

	const withMem = fresh();
	const blind = fresh();
	const perScenario: Record<string, { a: Tally; b: Tally; sigRetrieved: number; lever: string }> = {};

	for (let run = 0; run < RUNS; run++) {
		if (RUNS > 1) console.log(`\n═══ run ${run + 1}/${RUNS} ═══`);
		for (const sc of SCENARIOS) {
			perScenario[sc.id] ??= { a: fresh(), b: fresh(), sigRetrieved: 0, lever: sc.lever };
			const dbPath = join(mkdtempSync(join(tmpdir(), "predict3-")), "mem.db");
			const mem = new LiteMemoryProvider({ dbPath, embedder, writesEnabled: true });
			// Encode signal+support+distractors in interleaved order (bury the signal).
			const all = [...sc.seed, ...sc.distractors, ...fillerNoise(EXTRA_NOISE)];
			for (const s of all) await mem.encode({ content: s, role: "user" } as Parameters<LiteMemoryProvider["encode"]>[0]);
			const hits = (await mem.recall(sc.recallQuery, { topK: 5 })).map((h) => h.content);
			// signal = seed[0]; did it survive noise into the top-k?
			const signal = sc.seed[0]!;
			const sigRetrieved = hits.some((h) => h.includes(signal.slice(0, 14)));

			const correctIsA = Math.random() < 0.5;
			const optA = correctIsA ? sc.correctOption : sc.wrongOption;
			const optB = correctIsA ? sc.wrongOption : sc.correctOption;
			const correctLabel: "A" | "B" = correctIsA ? "A" : "B";
			const probe = `${sc.situation} 후보는 (A) ${optA} (B) ${optB}. 내가 뭘 고를 것 같아?`;

			const aPred = parsePrediction(await predict(llm, probe, hits));
			const bPred = parsePrediction(await predict(llm, probe, []));
			await mem.close();

			score(aPred, correctLabel, withMem);
			score(bPred, correctLabel, blind);
			score(aPred, correctLabel, perScenario[sc.id]!.a);
			score(bPred, correctLabel, perScenario[sc.id]!.b);
			if (sigRetrieved) perScenario[sc.id]!.sigRetrieved++;

			console.log(
				`  ${sc.id} [${sc.lever}] 정답=${correctLabel}  A[mem]=${aPred ?? "?"}${aPred === correctLabel ? "✓" : "✗"}(sig ${sigRetrieved ? "Y" : "·"})` +
					`  B[blind]=${bPred ?? "?"}${bPred === correctLabel ? "✓" : "✗"}`,
			);
		}
	}

	const N = RUNS * SCENARIOS.length;
	const pct = (n: number) => `${((n / N) * 100).toFixed(0)}%`;
	const line = (t: Tally) => `${t.correct}/${N} (${pct(t.correct)})  wrong=${t.wrong} unparsed=${t.unparsed}  pickedA=${pct(t.pickA)}`;
	console.log(`\n[result] N=${N}/condition, HARD scenarios, order randomized`);
	console.log(`  A  memory-injected : ${line(withMem)}`);
	console.log(`  B  blind baseline  : ${line(blind)}`);
	const lift = ((withMem.correct - blind.correct) / N) * 100;
	console.log(`  → memory lift = ${lift >= 0 ? "+" : ""}${lift.toFixed(0)} pp`);
	console.log(`\n[per-scenario]  A / B correct out of ${RUNS}  (signal-retrieved)`);
	for (const [id, v] of Object.entries(perScenario)) {
		const useFail = v.sigRetrieved > 0 && v.a.correct < v.sigRetrieved ? "  ⚠use-fail" : "";
		console.log(`  ${id} [${v.lever}]: A ${v.a.correct}/${RUNS}  B ${v.b.correct}/${RUNS}  (sig ${v.sigRetrieved}/${RUNS})${useFail}`);
	}
	console.log(`\n⚠ 예측정확도는 proxy이지 telos 아님(SoT). HARD v3: 암시/잡음/recency/nuance. A<100% 면 천장 깨짐.`);
}

main().then(
	() => process.exit(0),
	(e) => { console.error(`✗ v3 FAILED: ${(e as Error).stack ?? (e as Error).message}`); process.exit(1); },
);
