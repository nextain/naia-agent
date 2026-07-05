/**
 * Salience-earning demo (HL-5b) — does a REACTED-TO memory surface selectively?
 *
 * The 5-stab finding was that naia's emotion bottleneck is SELECTIVITY, not
 * retrieval: with many memories present, the agent should surface the ones that
 * matter and suppress the flat ones. The first-class reaction signal (naia-memory
 * `emotion` on encode) is the lever. This demo seeds one emotionally reacted-to
 * memory among many flat, equally-on-topic distractors, then recalls with a small
 * topK — WITH vs WITHOUT the reaction tag — to show that the tag makes the
 * reacted-to memory win the cut while the flat peer falls out.
 *
 * Run (opt-in — real Gemini):
 *   cd /var/home/luke/alpha-adk
 *   set -a; . data-private/key/llm-key.env; set +a
 *   SALIENCE_DEMO=1 pnpm --dir projects/naia-agent exec tsx examples/salience-earning-demo.ts
 */
import { LocalAdapter, buildLLMFactExtractor, HeuristicContradictionFilter } from "@nextain/naia-memory";
import { OpenAICompatEmbeddingProvider } from "/var/home/luke/alpha-adk/projects/naia-memory/src/memory/embeddings.ts";
import { NaiaMemoryProvider } from "/var/home/luke/alpha-adk/projects/naia-memory/dist/memory/provider.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATEWAY = "https://naia-gateway-181404717065.asia-northeast3.run.app";
const KEY = (process.env.NAIA_PROD_KEY ?? "").trim();
const TOPK = 3;

// Two on-topic memories about the user's hobby — one reacted-to, one flat — plus
// mundane distractors. Only the reaction tag differs between the two runs.
const REACTED = "나 요즘 서예를 시작했는데, 처음 붓을 잡고 획을 긋는 순간 왈칵 눈물이 났어. 돌아가신 할아버지가 늘 하시던 거라서.";
const FLAT_PEER = "아 그리고 주말에 그냥 심심해서 유튜브로 종이접기 영상도 좀 봤어.";
const DISTRACTORS = [
	"점심은 그냥 편의점 삼각김밥으로 때웠어.",
	"오늘 지하철이 좀 붐볐어.",
	"핸드폰 배터리를 깜빡하고 안 챙겼네.",
	"어제 마트에서 휴지랑 세제 샀어.",
	"날씨가 좀 흐린 것 같아.",
	"이번 주 회의가 수요일로 밀렸대.",
];

async function build(withReaction: boolean): Promise<NaiaMemoryProvider> {
	const embedder = new OpenAICompatEmbeddingProvider(GATEWAY, KEY, "vertexai:text-multilingual-embedding-002", 768);
	const factExtractor = buildLLMFactExtractor({ apiKey: KEY, baseURL: `${GATEWAY}/v1/`, model: "vertexai:gemini-3.1-flash-lite" });
	const adapter = new LocalAdapter({ storePath: join(mkdtempSync(join(tmpdir(), "salience-")), "m.json"), embeddingProvider: embedder });
	const mem = new NaiaMemoryProvider({ adapter, factExtractor, contradictionFilter: new HeuristicContradictionFilter() });
	// The reacted-to memory: tag emotion=0.9 only in the treatment run.
	await mem.encode({ content: REACTED, role: "user", ...(withReaction ? { emotion: 0.9 } : {}) });
	await mem.encode({ content: FLAT_PEER, role: "user" });
	for (const d of DISTRACTORS) await mem.encode({ content: d, role: "user" });
	await mem.consolidate();
	return mem;
}

async function main() {
	if (process.env.SALIENCE_DEMO !== "1" || !KEY) {
		console.log("[skip] salience-earning demo는 opt-in입니다. SALIENCE_DEMO=1 + NAIA_PROD_KEY 필요.");
		process.exit(0);
	}
	const query = "사용자 취미"; // hobby — both 서예 and 종이접기 are on-topic
	for (const withReaction of [false, true]) {
		const mem = await build(withReaction);
		const hits = await mem.recall(query, { topK: TOPK });
		const inTop = (kw: string) => {
			const i = hits.findIndex((h) => h.content.includes(kw));
			return i < 0 ? "OUT" : `#${i + 1} (${(hits[i]!.score ?? 0).toFixed(3)})`;
		};
		console.log(
			`reaction=${withReaction ? "ON (서예 emotion=0.9)" : "off"}  topK=${TOPK}:` +
				`  서예(reacted)=${inTop("서예")}  종이접기(flat)=${inTop("종이접기")}`,
		);
		await mem.close();
	}
	console.log(
		"\n해석: reaction ON에서 서예(반응한 기억)가 topK 안으로 올라오고 flat peer는 밀려나면,\n" +
			"차등 salience가 선택적 회상을 만든다는 것 — 반응한 것만 우선 떠오르는 naia thesis.",
	);
}

main().then(
	() => process.exit(0),
	(e) => {
		console.error(`✗ salience demo FAILED: ${(e as Error).stack ?? (e as Error).message}`);
		process.exit(1);
	},
);
