/**
 * Prediction anchor — SELF-SPECIFICITY (the real persona measure).
 *
 * "Is this naia THIS person's?" We build PAIRS of users with OPPOSITE preferences
 * on one axis (vegetarian vs carnivore, morning vs night, …). For each user X we
 * predict X's held-out choice under three memory conditions:
 *   - matched     : X's OWN memory        → should be correct (X's preference)
 *   - mismatched  : the OTHER user's memory → tests if the wrong person's memory
 *                    MISLEADS (options are the two users' favored choices, so a
 *                    wrong prediction here = predicting the memory-owner's favor)
 *   - blind       : no memory              → default prior baseline
 *
 * Self-specificity signal = matched − mismatched accuracy. If mismatched also
 * drops BELOW blind, the wrong user's memory is actively misleading (not just
 * unhelpful) — the strongest evidence that memory is user-specific, i.e. the
 * formed self genuinely belongs to that person and not a generic one.
 *
 * Position-bias controlled (options assigned to A/B at random per trial, shared
 * across the 3 conditions of that trial). Objective prediction accuracy, not a
 * morality filter.
 *
 * Run:
 *   cd /var/home/luke/alpha-adk
 *   set -a; . <(tr -d '\r' < data-private/key/llm-key.env); set +a
 *   PREDICT_LIVE=1 PREDICT_RUNS=3 pnpm --dir projects/naia-agent exec \
 *     tsx examples/prediction-anchor-selfspec.ts
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

const SYSTEM =
	"너는 사용자를 오래 알고 지낸 친구야. 사용자가 어떤 선택을 할지 '예측'해. " +
	"조언이나 훈수가 아니라 사용자 본인이 실제로 뭘 고를지를 맞혀. " +
	"반드시 첫 줄에 `예측: A` 또는 `예측: B` 형식으로만 답하고, 다음 줄에 한 줄로 이유를 써.";

interface Persona {
	readonly label: string;
	readonly seed: readonly string[];
	/** The option THIS persona picks in the shared probe. */
	readonly favors: string;
}
interface SpecPair {
	readonly id: string;
	readonly recallQuery: string;
	readonly situation: string;
	readonly userA: Persona;
	readonly userB: Persona;
}

const PAIRS: readonly SpecPair[] = [
	{
		id: "SP-diet", recallQuery: "음식 고기 채식 취향", situation: "모임 장소를 다수결로 정하는데.",
		userA: { label: "채식", seed: ["나 3년째 채식 중이야. 윤리적 이유라 고기는 아예 안 먹어.", "회식에서도 채소랑 사이드만 챙겨 먹어."], favors: "채소 비빔밥 전문점" },
		userB: { label: "육식", seed: ["나 고기 없으면 밥이 아니지. 삼겹살에 소고기라면 매일도 먹어.", "채소 위주 식당 가면 늘 뭔가 아쉬워."], favors: "숯불 소고기 구이집" },
	},
	{
		id: "SP-caffeine", recallQuery: "커피 카페인 음료 취향", situation: "카페에서 음료 하나 고르는데.",
		userA: { label: "카페인민감", seed: ["나 카페인에 민감해서 오후엔 무조건 디카페인만 마셔.", "진한 커피 잘못 마시면 밤에 심장이 두근거려."], favors: "캐모마일 티" },
		userB: { label: "커피광", seed: ["나 하루에 에스프레소 서너 잔은 기본이야. 진할수록 좋아.", "디카페인은 커피도 아니지."], favors: "에스프레소 더블샷" },
	},
	{
		id: "SP-chrono", recallQuery: "생활 리듬 아침 밤 시간대 선호", situation: "번개 모임 시간을 정하는데.",
		userA: { label: "아침형", seed: ["나 완전 아침형이야. 밤 10시면 잠들고 새벽에 운동해.", "늦은 밤 약속은 질색이야."], favors: "아침 7시 조깅 모임" },
		userB: { label: "저녁형", seed: ["나 밤에 제일 쌩쌩해. 새벽 2-3시가 골든타임이야.", "아침 일찍은 죽어도 못 일어나."], favors: "밤 11시 심야 상영회" },
	},
	{
		id: "SP-social", recallQuery: "모임 사람 사교 성향 에너지", situation: "주말 약속을 정하는데.",
		userA: { label: "내향", seed: ["나 사람 많으면 진이 빠져. 조용히 몇 명이서가 편해.", "큰 모임은 생각만 해도 부담스러워."], favors: "집에서 넷이 보드게임" },
		userB: { label: "외향", seed: ["나 사람 많을수록 신나. 파티 가면 오히려 에너지가 충전돼.", "혼자 있으면 좀이 쑤셔."], favors: "100명 규모 클럽 파티" },
	},
	{
		id: "SP-temp", recallQuery: "계절 더위 추위 여행 선호", situation: "여행지를 둘 중 하나로 정하는데.",
		userA: { label: "추위질색", seed: ["나 추위를 질색해. 여름이 최고고 겨울 여행은 아예 안 가.", "겨울엔 롱패딩에 핫팩이 필수야."], favors: "여름 남해 해변" },
		userB: { label: "더위질색", seed: ["나 더위를 못 참아. 겨울이 훨씬 좋고 여름엔 축 늘어져.", "시원한 데 가면 살 것 같아."], favors: "겨울 대관령 스키장" },
	},
	{
		id: "SP-spice", recallQuery: "매운맛 음식 취향", situation: "점심 메뉴를 정하는데.",
		userA: { label: "매운맛광", seed: ["나 매운 거라면 환장해. 마라탕 불닭 다 좋아.", "안 매우면 밍밍해서 못 먹어."], favors: "얼얼한 마라 훠궈" },
		userB: { label: "매운맛질색", seed: ["나 매운 거 진짜 못 먹어. 신라면도 물 타서 먹어.", "늘 순한 것만 찾게 돼."], favors: "담백한 콩나물국밥" },
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

interface Tally { correct: number; wrong: number; unparsed: number; }
const fresh = (): Tally => ({ correct: 0, wrong: 0, unparsed: 0 });
function score(pred: "A" | "B" | null, correctLabel: "A" | "B", t: Tally): void {
	if (pred === null) t.unparsed++;
	else if (pred === correctLabel) t.correct++;
	else t.wrong++;
}

async function main() {
	if (process.env.PREDICT_LIVE !== "1" || !KEY) {
		console.log(
			"[skip] self-specificity LIVE bench는 opt-in입니다 (실 Gemini 크레딧 보호).\n" +
				"  실행: cd /var/home/luke/alpha-adk && set -a; . <(tr -d '\\r' < data-private/key/llm-key.env); set +a\n" +
				"        PREDICT_LIVE=1 PREDICT_RUNS=3 pnpm --dir projects/naia-agent exec tsx examples/prediction-anchor-selfspec.ts\n" +
				`  gateway=${GATEWAY} main=${MAIN_MODEL} key=${KEY ? "SET" : "MISSING"}`,
		);
		process.exit(0);
	}
	const RUNS = Math.max(1, Number(process.env.PREDICT_RUNS ?? 3) | 0);
	const embedder = new OpenAICompatEmbeddingProvider(GATEWAY, KEY, EMBED_MODEL, EMBED_DIMS);
	const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
	const provider = createOpenAICompatible({ name: "naia-gw", apiKey: KEY, baseURL: `${GATEWAY}/v1` });
	const llm = new VercelClient(provider.chatModel(MAIN_MODEL), { defaultMaxTokens: 512 });

	console.log(
		`[bench] prediction anchor — SELF-SPECIFICITY — LIVE (${RUNS} runs, ${PAIRS.length} opposite-preference pairs)\n` +
			`  main=${MAIN_MODEL}   matched = own memory | mismatched = other user's memory | blind = none   order randomized`,
	);

	const matched = fresh(), mismatched = fresh(), blind = fresh();
	const perPair: Record<string, { m: Tally; x: Tally; b: Tally }> = {};

	// Build a persona's fresh memory store, seed it, return recall fn.
	async function seededHits(p: Persona, query: string): Promise<string[]> {
		const dbPath = join(mkdtempSync(join(tmpdir(), "selfspec-")), "mem.db");
		const mem = new LiteMemoryProvider({ dbPath, embedder, writesEnabled: true });
		for (const s of p.seed) await mem.encode({ content: s, role: "user" } as Parameters<LiteMemoryProvider["encode"]>[0]);
		const hits = (await mem.recall(query, { topK: 4 })).map((h) => h.content);
		await mem.close();
		return hits;
	}

	for (let run = 0; run < RUNS; run++) {
		if (RUNS > 1) console.log(`\n═══ run ${run + 1}/${RUNS} ═══`);
		for (const pair of PAIRS) {
			perPair[pair.id] ??= { m: fresh(), x: fresh(), b: fresh() };
			const hitsA = await seededHits(pair.userA, pair.recallQuery);
			const hitsB = await seededHits(pair.userB, pair.recallQuery);

			// Predict for BOTH users; each user's correct = own favor.
			for (const target of ["A", "B"] as const) {
				const self = target === "A" ? pair.userA : pair.userB;
				const otherHits = target === "A" ? hitsB : hitsA;
				const selfHits = target === "A" ? hitsA : hitsB;
				const other = target === "A" ? pair.userB : pair.userA;

				// Randomize option order once; shared across the 3 conditions.
				const selfIsA = Math.random() < 0.5;
				const optA = selfIsA ? self.favors : other.favors;
				const optB = selfIsA ? other.favors : self.favors;
				const correctLabel: "A" | "B" = selfIsA ? "A" : "B";
				const probe = `${pair.situation} 후보는 (A) ${optA} (B) ${optB}. 내가 뭘 고를 것 같아?`;

				const mPred = parsePrediction(await predict(llm, probe, selfHits));   // matched
				const xPred = parsePrediction(await predict(llm, probe, otherHits));  // mismatched
				const bPred = parsePrediction(await predict(llm, probe, []));         // blind

				score(mPred, correctLabel, matched); score(mPred, correctLabel, perPair[pair.id]!.m);
				score(xPred, correctLabel, mismatched); score(xPred, correctLabel, perPair[pair.id]!.x);
				score(bPred, correctLabel, blind); score(bPred, correctLabel, perPair[pair.id]!.b);

				console.log(
					`  ${pair.id}/${self.label}  matched=${mPred ?? "?"}${mPred === correctLabel ? "✓" : "✗"}` +
						`  mismatched=${xPred ?? "?"}${xPred === correctLabel ? "✓" : "✗"}  blind=${bPred ?? "?"}${bPred === correctLabel ? "✓" : "✗"}`,
				);
			}
		}
	}

	const N = RUNS * PAIRS.length * 2;
	const pct = (t: Tally) => `${t.correct}/${N} (${((t.correct / N) * 100).toFixed(0)}%)`;
	console.log(`\n[result] N=${N}/condition (${PAIRS.length} pairs × 2 users × ${RUNS} runs)`);
	console.log(`  matched (own memory)      : ${pct(matched)}`);
	console.log(`  mismatched (other's mem)  : ${pct(mismatched)}`);
	console.log(`  blind (no memory)         : ${pct(blind)}`);
	const spec = ((matched.correct - mismatched.correct) / N) * 100;
	const misled = ((blind.correct - mismatched.correct) / N) * 100;
	console.log(`  → self-specificity = matched − mismatched = ${spec >= 0 ? "+" : ""}${spec.toFixed(0)} pp`);
	console.log(`  → mismatched below blind by ${misled.toFixed(0)} pp  (>0 ⇒ wrong-user memory ACTIVELY misleads)`);
	console.log(`\n[per-pair]  matched / mismatched / blind (correct out of ${RUNS * 2})`);
	for (const [id, v] of Object.entries(perPair)) {
		console.log(`  ${id}: m ${v.m.correct}  x ${v.x.correct}  b ${v.b.correct}  / ${RUNS * 2}`);
	}
	console.log(`\n⚠ 예측정확도는 proxy이지 telos 아님(SoT). self-specificity = 그 기억이 그 사람의 것인가.`);
}

main().then(
	() => process.exit(0),
	(e) => { console.error(`✗ selfspec FAILED: ${(e as Error).stack ?? (e as Error).message}`); process.exit(1); },
);
