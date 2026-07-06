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
 * seed (채식 seed → 갈비/수제비 투표 probe 식). A correct prediction therefore requires
 * GENERALIZING the preference, not string-matching — the line between real 길들임
 * (generalizes → predicts) and overfit (memorizes surface).
 *
 * POSITION-BIAS CONTROL (v2): the two options are assigned to labels A/B at RANDOM
 * per trial. The first-probe (v1) exposed a blind "always pick A" bias that
 * inflated any scenario whose correct answer was A. With randomized order the
 * blind baseline collapses to ~chance (50%), so A−B lift measures real prediction.
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
	/** Situation stem (ends right before the two options are listed). */
	readonly situation: string;
	/** The preference-consistent option (label assigned at random per trial). */
	readonly correctOption: string;
	/** The tempting default / opposite option. */
	readonly wrongOption: string;
}

// 9 scenarios. Every option pair is held-out (no seed-vocabulary overlap) so a
// hit requires generalizing the preference. correctOption is the consistent one.
const SCENARIOS: readonly PredScenario[] = [
	{
		id: "PA-01-vegetarian",
		seed: [
			"나 3년 전부터 채식을 하고 있어. 윤리적인 이유라 웬만해선 안 흔들려.",
			"회식 자리에서도 고기는 안 먹고 사이드나 채소 위주로만 챙겨 먹어.",
		],
		recallQuery: "음식 취향 식습관 회식 메뉴 선택",
		situation: "이번 모임 장소를 다수결로 정한대.",
		correctOption: "들깨수제비 전문점",
		wrongOption: "소갈비 무한리필",
	},
	{
		id: "PA-02-caffeine",
		seed: [
			"나 카페인에 되게 민감해. 예전에 오후에 커피 마시고 밤새 심장이 두근거려서 응급실 갈 뻔한 뒤로 조심해.",
			"요즘은 오후엔 무조건 디카페인만 마셔.",
		],
		recallQuery: "카페 음료 선택 카페인 건강",
		situation: "오후 4시 미팅 카페에서 음료 하나 골라야 해.",
		correctOption: "캐모마일 티",
		wrongOption: "콜드브루 더블샷",
	},
	{
		id: "PA-03-morning",
		seed: [
			"나 완전 아침형이야. 밤 10시만 되면 눈이 감겨서 늦게까지 있는 자리는 질색이야.",
			"새벽에 일어나서 운동하는 게 하루 루틴이라 저녁 약속은 일찍 끝나는 걸 선호해.",
		],
		recallQuery: "생활 패턴 아침형 저녁 약속 시간대 선호",
		situation: "친구가 둘 중 하나 고르래.",
		correctOption: "아침 8시 등산 모임",
		wrongOption: "밤 9시 시작하는 심야 영화",
	},
	{
		id: "PA-04-spicy-averse",
		seed: [
			"나 매운 거 진짜 못 먹어. 신라면도 물 타서 먹을 정도라 땀 뻘뻘 흘리며 먹는 건 고역이야.",
			"매운 음식 앞에선 늘 순한 걸 찾게 돼.",
		],
		recallQuery: "음식 매운맛 선호 메뉴 선택",
		situation: "점심 메뉴를 둘 중에 투표한대.",
		correctOption: "담백한 온소바",
		wrongOption: "불닭 마라샹궈",
	},
	{
		id: "PA-05-introvert",
		seed: [
			"나 사람 많은 데 가면 기 다 빨려. 시끌벅적한 자리보다 몇 명이서 조용히 있는 게 훨씬 편해.",
			"큰 모임은 생각만 해도 부담스러워.",
		],
		recallQuery: "성향 모임 사교 사람 많은 자리 선호",
		situation: "주말 약속을 둘 중 하나로 정한대.",
		correctOption: "집에서 넷이서 보드게임",
		wrongOption: "200명 규모 네트워킹 파티",
	},
	{
		id: "PA-06-frugal",
		seed: [
			"나 돈 관리 빡세게 해. 충동구매는 절대 안 하고 몇 달씩 비교하고 사는 편이야.",
			"가성비 안 나오면 아무리 좋아 보여도 안 사.",
		],
		recallQuery: "소비 성향 구매 결정 가성비 절약",
		situation: "노트북을 둘 중 하나 사려는데.",
		correctOption: "중고로 잘 나온 작년 모델",
		wrongOption: "갓 출시된 최신형 풀옵션",
	},
	{
		id: "PA-07-pet-lover",
		seed: [
			"나 강아지라면 사족을 못 써. 길에서 마주치면 무조건 인사하고 유기견 봉사도 다녀.",
			"반려견이랑 못 떨어져서 어디 가든 같이 갈 수 있는지부터 봐.",
		],
		recallQuery: "반려동물 강아지 여행 동반 선호",
		situation: "1박 여행 숙소를 둘 중에 골라야 해.",
		correctOption: "반려견 동반 가능 캠핑장",
		wrongOption: "반려동물 금지 5성급 호텔",
	},
	{
		id: "PA-08-cold-averse",
		seed: [
			"나 추위를 진짜 많이 타. 겨울엔 롱패딩에 핫팩 두 개는 기본이고, 여름이 백배 나아.",
			"찬 데 오래 있으면 금방 지쳐.",
		],
		recallQuery: "날씨 추위 더위 계절 선호",
		situation: "회사 워크숍 장소를 투표한대.",
		correctOption: "한여름 남해 해변 리조트",
		wrongOption: "한겨울 대관령 스키 캠프",
	},
	{
		id: "PA-09-planner",
		seed: [
			"나 뭐든 계획을 세워야 마음이 놓여. 즉흥은 불안해서 여행도 분 단위로 일정을 짜는 편이야.",
			"변수 많은 상황은 딱 질색이야.",
		],
		recallQuery: "여행 스타일 계획 즉흥 성향",
		situation: "친구랑 여행 방식을 정하는데.",
		correctOption: "일정 다 짜인 패키지 투어",
		wrongOption: "아무 계획 없는 즉흥 백패킹",
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
	pickA: number; // how often this condition answered "A" (position-bias telltale)
}
const fresh = (): Tally => ({ correct: 0, wrong: 0, unparsed: 0, pickA: 0 });

function score(pred: "A" | "B" | null, correctLabel: "A" | "B", t: Tally): void {
	if (pred === null) { t.unparsed++; return; }
	if (pred === "A") t.pickA++;
	if (pred === correctLabel) t.correct++;
	else t.wrong++;
}

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
		`[bench] prediction anchor v2 — LIVE (${RUNS} run${RUNS > 1 ? "s" : ""}, ${SCENARIOS.length} scenarios)\n` +
			`  gateway=${GATEWAY}  main=${MAIN_MODEL}  embed=${EMBED_MODEL}(${EMBED_DIMS}d)\n` +
			`  A = memory-injected   B = blind   guard = held-out probe + RANDOMIZED option order (kills position bias)`,
	);

	const withMem = fresh();
	const blind = fresh();
	const perScenario: Record<string, { a: Tally; b: Tally; retrieved: number }> = {};

	for (let run = 0; run < RUNS; run++) {
		if (RUNS > 1) console.log(`\n═══ run ${run + 1}/${RUNS} ═══`);
		for (const sc of SCENARIOS) {
			perScenario[sc.id] ??= { a: fresh(), b: fresh(), retrieved: 0 };
			const dbPath = join(mkdtempSync(join(tmpdir(), "predict-")), "mem.db");
			const mem = new LiteMemoryProvider({ dbPath, embedder, writesEnabled: true });
			for (const s of sc.seed) await mem.encode({ content: s, role: "user" } as Parameters<LiteMemoryProvider["encode"]>[0]);
			const hits = (await mem.recall(sc.recallQuery, { topK: 4 })).map((h) => h.content);
			const retrieved = hits.some((h) => sc.seed.some((s) => h.includes(s.slice(0, 12))));

			// Position-bias control: randomly assign correct/wrong option to A/B.
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
			if (retrieved) perScenario[sc.id]!.retrieved++;

			console.log(
				`  ${sc.id}  정답=${correctLabel}  A[mem]=${aPred ?? "?"}${aPred === correctLabel ? "✓" : "✗"}(ret ${retrieved ? "Y" : "·"})` +
					`  B[blind]=${bPred ?? "?"}${bPred === correctLabel ? "✓" : "✗"}`,
			);
		}
	}

	const N = RUNS * SCENARIOS.length;
	const pct = (n: number) => `${((n / N) * 100).toFixed(0)}%`;
	const line = (t: Tally) => `${t.correct}/${N} (${pct(t.correct)})  wrong=${t.wrong} unparsed=${t.unparsed}  pickedA=${pct(t.pickA)}`;
	console.log(`\n[result] N=${N} predictions/condition (${SCENARIOS.length} scenarios × ${RUNS} runs), option order randomized`);
	console.log(`  A  memory-injected : ${line(withMem)}`);
	console.log(`  B  blind baseline  : ${line(blind)}   ← expect ~50% (chance) + pickedA~50% if bias neutralized`);
	const lift = ((withMem.correct - blind.correct) / N) * 100;
	console.log(`  → memory lift = ${lift >= 0 ? "+" : ""}${lift.toFixed(0)} pp  (A − B accuracy)`);
	console.log(`\n[per-scenario]  (A correct / B correct / retrieved, out of ${RUNS})`);
	for (const [id, v] of Object.entries(perScenario)) {
		console.log(`  ${id}: A ${v.a.correct}/${RUNS}  B ${v.b.correct}/${RUNS}  (retrieved ${v.retrieved}/${RUNS})`);
	}
	console.log(
		`\n⚠ 예측정확도는 proxy이지 telos 아님(SoT). v2: ${SCENARIOS.length} 시나리오·N=${RUNS}, Lite(cosine) 회상, ` +
			`보기순서 무작위(위치편향 제거). blind pickedA≈50% 면 편향 중화 확인. baseline=blind gemini.`,
	);
}

main().then(
	() => process.exit(0),
	(e) => {
		console.error(`✗ prediction-anchor bench FAILED: ${(e as Error).stack ?? (e as Error).message}`);
		process.exit(1);
	},
);
