// Slice 3-XR-Handoff (#50) P5 — the headline test loop.
//
// User directive (2026-05-21): "컨텍스트가 일정 이상 차면 진행하게 테스트 루프
// 만들어서 진행해" — verify the auto-trigger fires when compaction is
// insufficient, and that a fresh Agent importing the blob recalls the
// pre-handoff fact.

import { describe, it, expect } from "vitest";
import { Agent } from "@nextain/agent-core";
import type {
	CompactableCapable,
	CompactionInput,
	CompactionResult,
	ConsolidationSummary,
	HandoffBlob,
	HandoffCapable,
	LLMClient,
	LLMRequest,
	LLMStreamChunk,
	MemoryHit,
	MemoryInput,
	MemoryProvider,
} from "@nextain/agent-types";
import { createHost } from "../host/create-host.js";

/**
 * Mock memory that:
 * - Implements CompactableCapable with a verbose recap (so the recap itself
 *   keeps a lot of token bulk — which is what forces budget-95-post-compact
 *   to fire in practice).
 * - Implements HandoffCapable.attachHandoff for cross-session attach
 *   verification.
 * - Records every encode for the "fact persisted across sessions" assertion.
 */
class HandoffTestMemory
	implements MemoryProvider, CompactableCapable, HandoffCapable
{
	readonly encoded: { role: string; content: string }[] = [];
	readonly attachedBlobs: HandoffBlob[] = [];
	async encode(input: MemoryInput): Promise<void> {
		this.encoded.push({ role: input.role, content: input.content });
	}
	async recall(query: string): Promise<MemoryHit[]> {
		const q = query.toLowerCase();
		const matches = this.encoded
			.filter((r) => r.content.toLowerCase().includes(q))
			.slice(0, 3)
			.map<MemoryHit>((r, i) => ({
				id: `mem-${i}`,
				content: r.content,
				score: 1,
				timestamp: Date.now(),
			}));
		// Also surface any attached handoff anchors via recall (cross-session
		// fact-level recall, the headline guarantee).
		for (const blob of this.attachedBlobs) {
			for (const anchor of blob.anchors) {
				if (anchor.toLowerCase().includes(q) || q.includes(anchor.toLowerCase())) {
					matches.push({
						id: `handoff-${anchor}`,
						content: `[from prior session] ${anchor}`,
						score: 1,
						timestamp: blob.createdAt,
					});
				}
			}
		}
		return matches;
	}
	async consolidate(): Promise<ConsolidationSummary> {
		return { factsCreated: 0, durationMs: 0 };
	}
	async close(): Promise<void> {}
	async compact(input: CompactionInput): Promise<CompactionResult> {
		// Verbose recap: every input message contributes a line plus an
		// anchor identifier. This is what makes the post-compact request
		// STILL exceed budget — i.e. compaction insufficient → handoff.
		const lines = input.messages.map(
			(m, i) =>
				`- ${m.role}#${i}: ${m.content.slice(0, 60)} [ref-${i}]`,
		);
		const summary =
			(input.priorRecap ? `Prior: ${input.priorRecap.content}\n\n` : "") +
			`[Verbose recap of ${input.messages.length} msgs — strategy=${input.strategy ?? "default"}]\n` +
			lines.join("\n");
		return {
			summary: { role: "assistant", content: summary, timestamp: Date.now() },
			droppedCount: input.messages.length,
		};
	}
	async attachHandoff(blob: HandoffBlob): Promise<void> {
		this.attachedBlobs.push(blob);
	}
}

/** Scripted LLM: replies with a verbose message that contains a UUID-like
 *  identifier whenever the user message asks about a fact. */
class ScriptedLLM implements LLMClient {
	#i = 0;
	constructor(private readonly fact: string) {}
	async generate(): Promise<never> {
		throw new Error("not used");
	}
	async *stream(_: LLMRequest): AsyncIterable<LLMStreamChunk> {
		this.#i++;
		// Every reply 200+ chars, embeds the fact at turn 1 only (so handoff
		// must propagate it forward).
		const verbose =
			this.#i === 1
				? `Recorded fact: ${this.fact}. Will remember for future turns. ${"lorem ipsum ".repeat(15)}`
				: `Acknowledged turn ${this.#i}. ${"dolor sit amet ".repeat(20)}`;
		yield { type: "text_delta", text: verbose };
	}
}

/** Build a host with the test memory + scripted LLM. */
function hostFor(llm: LLMClient, memory: MemoryProvider) {
	return createHost({
		llm,
		memory,
		logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
	});
}

describe("Auto-handoff loop (Slice 3-XR-Handoff #50 P5 — headline)", () => {
	const FACT = "Order-#A-7421-customer-Jane-doe";

	it("HF-LOOP-01: auto-fires `handoff.exported` when budget≥95% AND compaction already ran (50-turn drive)", async () => {
		const memory = new HandoffTestMemory();
		const llm = new ScriptedLLM(FACT);
		const agent = new Agent({
			host: hostFor(llm, memory),
			// Aggressive estimator → triggers compaction quickly, then handoff
			// once compaction's verbose recap can't shrink enough.
			estimateTokens: (req: LLMRequest) =>
				JSON.stringify(req).length, // ~chars
			contextBudget: 800,
			compactionStrategy: "reactive",
			compactionKeepTail: 1,
			handoffThreshold: 0.95,
		});

		const events: Array<{ type: string; trigger?: string }> = [];
		// Drive turns until we see a handoff event (cap at 50 for safety).
		for (let t = 0; t < 50; t++) {
			for await (const ev of agent.sendStream(
				t === 0 ? `Remember the fact: ${FACT}` : `Turn ${t} please continue.`,
			)) {
				if (ev.type === "compaction" || ev.type === "handoff.exported") {
					events.push({
						type: ev.type,
						...(ev.type === "handoff.exported"
							? { trigger: ev.trigger }
							: {}),
					});
				}
			}
			if (events.some((e) => e.type === "handoff.exported")) break;
		}

		// Headline assertion: a compaction MUST have fired AND a handoff MUST
		// have fired AFTER the compaction (post-compact gate).
		const compactIdx = events.findIndex((e) => e.type === "compaction");
		const handoffIdx = events.findIndex((e) => e.type === "handoff.exported");
		expect(compactIdx).toBeGreaterThanOrEqual(0);
		expect(handoffIdx).toBeGreaterThanOrEqual(0);
		expect(handoffIdx).toBeGreaterThan(compactIdx);
		const handoffEv = events.find((e) => e.type === "handoff.exported")!;
		expect(handoffEv.trigger).toBe("budget-95-post-compact");
	});

	it("HF-LOOP-02: handoff blob carries the FACT (recap or anchors) so the next session can recall", async () => {
		const memory = new HandoffTestMemory();
		const llm = new ScriptedLLM(FACT);
		const agent = new Agent({
			host: hostFor(llm, memory),
			estimateTokens: (req: LLMRequest) => JSON.stringify(req).length,
			contextBudget: 800,
			compactionStrategy: "reactive",
			compactionKeepTail: 1,
			handoffThreshold: 0.95,
		});

		let blob: HandoffBlob | undefined;
		for (let t = 0; t < 50 && !blob; t++) {
			for await (const ev of agent.sendStream(
				t === 0 ? `Remember the fact: ${FACT}` : `Turn ${t} please.`,
			)) {
				if (ev.type === "handoff.exported") {
					blob = ev.blob;
					break;
				}
			}
		}

		expect(blob).toBeDefined();
		expect(blob!.version).toBe(1);
		expect(blob!.turnCount).toBeGreaterThan(0);
		expect(blob!.trigger).toBe("budget-95-post-compact");
		// Either the recap content or the anchors must carry the FACT —
		// the verbose recap includes every input message line, and the FACT
		// matches our identifier regex (`#A-7421`).
		const carriesFact =
			blob!.recap.content.includes(FACT) ||
			blob!.recap.content.includes("#A-7421") ||
			blob!.anchors.some((a) => a.includes("#A-7421"));
		expect(carriesFact).toBe(true);
	});

	it("HF-LOOP-03: importHandoff on a fresh Agent injects recap into system prompt + attaches to memory", async () => {
		const memory1 = new HandoffTestMemory();
		const llm1 = new ScriptedLLM(FACT);
		const agent1 = new Agent({
			host: hostFor(llm1, memory1),
			estimateTokens: (req: LLMRequest) => JSON.stringify(req).length,
			contextBudget: 800,
			compactionStrategy: "reactive",
			compactionKeepTail: 1,
			handoffThreshold: 0.95,
		});

		// Drive until handoff fires.
		let blob: HandoffBlob | undefined;
		for (let t = 0; t < 50 && !blob; t++) {
			for await (const ev of agent1.sendStream(
				t === 0 ? `Remember the fact: ${FACT}` : `Turn ${t}.`,
			)) {
				if (ev.type === "handoff.exported") {
					blob = ev.blob;
					break;
				}
			}
		}
		expect(blob).toBeDefined();

		// Fresh Agent (new memory, new LLM that captures incoming system prompt).
		const memory2 = new HandoffTestMemory();
		let capturedSystem = "";
		class InspectingLLM implements LLMClient {
			async generate(): Promise<never> {
				throw new Error("not used");
			}
			async *stream(req: LLMRequest): AsyncIterable<LLMStreamChunk> {
				capturedSystem += typeof req.system === "string" ? req.system : "";
				yield { type: "text_delta", text: "Acknowledged prior session." };
			}
		}
		const agent2 = new Agent({
			host: hostFor(new InspectingLLM(), memory2),
			compactionStrategy: "off",
			handoffThreshold: 0, // no auto-fire in the receiver
		});
		await agent2.importHandoff(blob!);

		// Drain one turn — the import is one-shot, so this turn MUST inject.
		for await (const _ of agent2.sendStream("What do you know already?")) {
			/* drain */
		}

		// Headline: the system prompt of the FIRST turn after import carries
		// "Prior session recap" + at least one anchor.
		expect(capturedSystem).toContain("Prior session recap");
		expect(capturedSystem).toContain("#A-7421");
		// And the blob is attached to memory2's long-term store.
		expect(memory2.attachedBlobs.length).toBe(1);
	});

	it("HF-LOOP-04: handoff fires AT MOST ONCE per session (no thrash spam)", async () => {
		const memory = new HandoffTestMemory();
		const llm = new ScriptedLLM(FACT);
		const agent = new Agent({
			host: hostFor(llm, memory),
			estimateTokens: (req: LLMRequest) => JSON.stringify(req).length,
			contextBudget: 600,
			compactionStrategy: "reactive",
			compactionKeepTail: 1,
			handoffThreshold: 0.95,
		});

		const handoffEvents: Array<{ trigger: string }> = [];
		for (let t = 0; t < 50; t++) {
			for await (const ev of agent.sendStream(`Turn ${t} please.`)) {
				if (ev.type === "handoff.exported") {
					handoffEvents.push({ trigger: ev.trigger });
				}
			}
		}
		// Even with 50 turns and persistent budget pressure, handoff fires
		// exactly once (idempotent guard).
		expect(handoffEvents.length).toBe(1);
	});

	it("HF-LOOP-05: manual exportHandoff('manual') produces a blob WITHOUT needing budget pressure", async () => {
		const memory = new HandoffTestMemory();
		const llm = new ScriptedLLM(FACT);
		const agent = new Agent({
			host: hostFor(llm, memory),
			contextBudget: 100_000, // way above
			compactionStrategy: "reactive",
		});

		// Just one turn, no budget pressure.
		for await (const _ of agent.sendStream(`Hello ${FACT}.`)) {
			/* drain */
		}

		const blob = await agent.exportHandoff("manual");
		expect(blob.version).toBe(1);
		expect(blob.trigger).toBe("manual");
		expect(blob.turnCount).toBe(1);
		expect(blob.recap.content.length).toBeGreaterThan(0);
	});

	it("HF-LOOP-06: handoffThreshold=0 disables auto-trigger (manual export still works)", async () => {
		const memory = new HandoffTestMemory();
		const llm = new ScriptedLLM(FACT);
		const agent = new Agent({
			host: hostFor(llm, memory),
			estimateTokens: (req: LLMRequest) => JSON.stringify(req).length,
			contextBudget: 800,
			compactionStrategy: "reactive",
			compactionKeepTail: 1,
			handoffThreshold: 0, // explicit disable
		});

		const handoffEvents: Array<unknown> = [];
		for (let t = 0; t < 30; t++) {
			for await (const ev of agent.sendStream(`Turn ${t}.`)) {
				if (ev.type === "handoff.exported") handoffEvents.push(ev);
			}
		}
		expect(handoffEvents.length).toBe(0);

		// But explicit export still works.
		const blob = await agent.exportHandoff("manual");
		expect(blob.trigger).toBe("manual");
	});
});
