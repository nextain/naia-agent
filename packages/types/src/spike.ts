/**
 * R4 #26 — Background brain spike + Active context types.
 *
 * naia-memory#26 (Background brain) 와 naia-agent#26 (Active brain) 가
 * 공유하는 schema. naia-memory 의 spike emit + naia-agent 의 source-monitor
 * + pragmatic-gate 가 동일 type 사용.
 *
 * 학계 정합 (anchor §A08):
 * - Sharp-wave ripples (Buzsáki 1996) — hippocampus fast replay burst
 * - CLS (McClelland 1995) — fast hippocampal + slow neocortical
 * - DMN (Raichle 2001) — spontaneous reorganization
 * - Source monitoring (Johnson 1993) — naia-agent 책임
 * - Gricean pragmatics (Grice 1975) — naia-agent 책임
 *
 * 책임 분리:
 * - naia-memory = consolidation worker + replay + spike emit
 * - naia-agent = subscribe + source monitor + pragmatic gate + active inject
 */

/** Spike event — significant 사건 발견 시 naia-memory 가 emit. */
export interface SpikeEvent {
	factId: string;
	content: string;
	reason:
		| "contradiction" // R2.5 supersede 시점
		| "high-importance-relevant" // active context topic + importance ≥ 0.8
		| "recall-failure-resolved" // 사용자 query 가 자주 fail 했는데 새 fact 추출
		| "temporal-anchor" // 365/180/90/30일 anniversary
		| "cross-domain-analogy" // KG bridging fact (future)
		| "user-emotion-anniversary" // high importance 같은 month/day
		| "repeated-fail"; // 같은 query 반복 + 답 변경
	confidence: number; // 0-1
	relatedFactIds: string[];
	emittedAt: number; // unix ms
	/** project scope — naia-agent 가 active session 의 project 와 비교 후
	 *  inject 결정. cross-project leak 방지 (anchor §A10). */
	scope?: { project?: string };
}

/** Active context — naia-agent 가 *현재 대화 context* 를 naia-memory 에 push.
 *  Background brain 이 spike rule 평가 시 active context 와 매칭. */
export interface ActiveContext {
	topics: string[];
	recentFactIds: string[];
	/** 필수 — cross-project leak 방지 (anchor §A10). */
	scope: { project: string };
	/** 사용자 명시 차단 topic — spike 가 이 topic fact 면 emit X. */
	optOutTopics?: string[];
}

/** Spike action — naia-agent 의 source-monitor + pragmatic-gate 결정 결과. */
export interface SpikeAction {
	decision: "inject-now" | "inject-next-turn" | "skip";
	reason: string;
	/** pragmatic gate 가 발화 다듬은 경우. */
	modifiedContent?: string;
}

/** Spike emit handler — naia-agent 가 subscribe 시 받는 callback.
 *  Returns SpikeAction or void (skip). */
export type SpikeHandler = (event: SpikeEvent) => Promise<SpikeAction | void>;
