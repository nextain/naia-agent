// Slice 3-XR-Compact v2 / Phase 1.2 (#56) — LLMMessage ↔ ModelMessage
// adapter unit tests. The adapter is the boundary that lets the Vercel SDK
// `pruneMessages` operate on naia-agent's `LLMMessage[]` history without
// leaking the `ai` SDK type into `@nextain/agent-core`.

import { describe, expect, it } from "vitest";
import type { LLMMessage } from "@nextain/agent-types";
import type { ModelMessage } from "ai";
import {
	llmMessageToModelMessage,
	modelMessageToLLMMessage,
	createLLMMessagePrepareCompact,
} from "../compaction/vercel-prepare-step.js";

describe("LLMMessage adapter (Phase 1.2 / #56)", () => {
	// ── round-trip basics ──────────────────────────────────────────────

	it("ADP-01: user message with plain string round-trips", () => {
		const orig: LLMMessage = { role: "user", content: "hi there" };
		const mm = llmMessageToModelMessage(orig);
		expect(mm.role).toBe("user");
		const back = modelMessageToLLMMessage(mm);
		expect(back).toEqual(orig);
	});

	it("ADP-02: assistant text + reasoning blocks survive round-trip", () => {
		const orig: LLMMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "thought one" },
				{ type: "text", text: "spoken one" },
			],
		};
		const mm = llmMessageToModelMessage(orig);
		expect(mm.role).toBe("assistant");
		const back = modelMessageToLLMMessage(mm);
		expect(back.role).toBe("assistant");
		expect(back.content).toEqual([
			{ type: "thinking", thinking: "thought one" },
			{ type: "text", text: "spoken one" },
		]);
	});

	it("ADP-03: assistant tool_use round-trips (id/name/input)", () => {
		const orig: LLMMessage = {
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "call_abc",
					name: "read_file",
					input: { path: "a.txt" },
				},
			],
		};
		const back = modelMessageToLLMMessage(llmMessageToModelMessage(orig));
		expect(back.content).toEqual([
			{
				type: "tool_use",
				id: "call_abc",
				name: "read_file",
				input: { path: "a.txt" },
			},
		]);
	});

	it("ADP-04: tool-role tool_result round-trips (toolCallId/content)", () => {
		const orig: LLMMessage = {
			role: "tool",
			content: [
				{
					type: "tool_result",
					toolCallId: "call_abc",
					content: "file body here",
				},
			],
		};
		const back = modelMessageToLLMMessage(llmMessageToModelMessage(orig));
		expect(back.role).toBe("tool");
		expect(back.content).toEqual([
			{
				type: "tool_result",
				toolCallId: "call_abc",
				content: "file body here",
			},
		]);
	});

	// ── lossy / drop behaviour ─────────────────────────────────────────

	it("ADP-05: redacted_thinking is dropped (no SDK part)", () => {
		const orig: LLMMessage = {
			role: "assistant",
			content: [
				{ type: "redacted_thinking", data: "encrypted" },
				{ type: "text", text: "spoken" },
			],
		};
		const mm = llmMessageToModelMessage(orig);
		expect(mm.role).toBe("assistant");
		// Only text part survives.
		expect(Array.isArray(mm.content) ? mm.content.length : 0).toBe(1);
	});

	it("ADP-06: SDK system-role message coerces to assistant on reverse path", () => {
		// The reverse path receives a ModelMessage; if the SDK produced a
		// `system` role (we never emit one, but defensively), coerce.
		const sysMm: ModelMessage = { role: "system", content: "you are helpful" };
		const back = modelMessageToLLMMessage(sysMm);
		expect(["user", "assistant"]).toContain(back.role);
	});

	// ── createLLMMessagePrepareCompact end-to-end ──────────────────────

	it("ADP-07: empty history → undefined (no work, no throw)", () => {
		const prepare = createLLMMessagePrepareCompact();
		expect(prepare([])).toBeUndefined();
	});

	it("ADP-08: under default threshold (compactAfterTokens=0) → fires", () => {
		// Default is compactAfterTokens=0 so any non-empty history triggers.
		const prepare = createLLMMessagePrepareCompact();
		const history: LLMMessage[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "world" },
		];
		const pruned = prepare(history);
		// Cookbook defaults strip reasoning + old tool_calls + empty messages.
		// Plain text survives — pruned should at least keep the user/asst pair.
		expect(pruned).toBeDefined();
		expect(pruned!.length).toBeGreaterThanOrEqual(1);
	});

	it("ADP-09: host can pass explicit threshold to double-gate", () => {
		// Host passes a huge threshold → estimator never exceeds → undefined.
		const prepare = createLLMMessagePrepareCompact({
			compactAfterTokens: 10_000_000,
		});
		const history: LLMMessage[] = [{ role: "user", content: "tiny" }];
		expect(prepare(history)).toBeUndefined();
	});

	it("ADP-10: pathological prune-to-empty is rejected (returns undefined)", () => {
		// pruneMessages with `emptyMessages: "remove"` + history of empty
		// reasoning-only assistants → could prune to []. The factory must
		// reject this rather than wipe non-empty history.
		const prepare = createLLMMessagePrepareCompact({
			pruneOptions: {
				reasoning: "all",
				toolCalls: "all",
				emptyMessages: "remove",
			},
		});
		const history: LLMMessage[] = [
			{ role: "assistant", content: [{ type: "thinking", thinking: "x" }] },
		];
		// After stripping all reasoning + removing empty → []
		const out = prepare(history);
		expect(out).toBeUndefined();
	});
});
