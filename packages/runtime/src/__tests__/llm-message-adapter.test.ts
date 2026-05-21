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

	it("ADP-08: history with reasoning → default prune strips it (returns shrunk)", () => {
		// Cookbook default `reasoning: "all"` strips thinking blocks from
		// assistants. With at least one reasoning block to strip, the no-op
		// guard passes and we get a shrunk result.
		const prepare = createLLMMessagePrepareCompact();
		const history: LLMMessage[] = [
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "I should respond politely" },
					{ type: "text", text: "world" },
				],
			},
		];
		const pruned = prepare(history);
		expect(pruned).toBeDefined();
		expect(pruned!.length).toBeGreaterThanOrEqual(1);
		// thinking block must be gone from the assistant message
		const asst = pruned!.find((m) => m.role === "assistant");
		expect(asst).toBeDefined();
		const hasThinking =
			typeof asst!.content !== "string" &&
			asst!.content.some((b) => b.type === "thinking");
		expect(hasThinking).toBe(false);
	});

	it("ADP-08b (codex R1 #1): no-op prune returns undefined — guard against unchanged result", () => {
		// Plain-text history has nothing to strip with cookbook defaults
		// (no reasoning, no tool_calls). pruneMessages returns the same
		// content. The factory MUST reject this so the Agent doesn't treat
		// the no-op as a successful compaction.
		const prepare = createLLMMessagePrepareCompact();
		const history: LLMMessage[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "world" },
		];
		expect(prepare(history)).toBeUndefined();
	});

	it("ADP-09: host can pass explicit threshold to double-gate", () => {
		// Host passes a huge threshold → estimator never exceeds → undefined.
		const prepare = createLLMMessagePrepareCompact({
			compactAfterTokens: 10_000_000,
		});
		const history: LLMMessage[] = [{ role: "user", content: "tiny" }];
		expect(prepare(history)).toBeUndefined();
	});

	it("ADP-09b (codex R1 #2): url-backed image round-trips as url (not base64)", () => {
		const orig: LLMMessage = {
			role: "user",
			content: [
				{
					type: "image",
					source: {
						type: "url",
						mediaType: "image/png",
						data: "https://example.com/x.png",
					},
				},
			],
		};
		const back = modelMessageToLLMMessage(llmMessageToModelMessage(orig));
		expect(back.role).toBe("user");
		const blocks = typeof back.content === "string" ? [] : back.content;
		const img = blocks.find((b) => b.type === "image") as
			| (LLMMessage["content"] extends Array<infer T> ? T : never)
			| undefined;
		expect(img).toBeDefined();
		expect((img as unknown as { source: { type: string; data: string } }).source.type).toBe(
			"url",
		);
		expect(
			(img as unknown as { source: { type: string; data: string } }).source.data,
		).toBe("https://example.com/x.png");
	});

	it("ADP-09c (codex R1 #3): tool_result.isError survives round-trip", () => {
		const orig: LLMMessage = {
			role: "tool",
			content: [
				{
					type: "tool_result",
					toolCallId: "call_fail",
					content: "permission denied",
					isError: true,
				},
			],
		};
		const back = modelMessageToLLMMessage(llmMessageToModelMessage(orig));
		expect(back.role).toBe("tool");
		const blocks = typeof back.content === "string" ? [] : back.content;
		const tr = blocks.find((b) => b.type === "tool_result") as
			| { type: "tool_result"; content: string; isError?: boolean }
			| undefined;
		expect(tr).toBeDefined();
		expect(tr!.content).toBe("permission denied");
		expect(tr!.isError).toBe(true);
	});

	it("ADP-09d (codex R1 #3): tool_result without isError stays without isError", () => {
		const orig: LLMMessage = {
			role: "tool",
			content: [
				{
					type: "tool_result",
					toolCallId: "call_ok",
					content: "ok response",
				},
			],
		};
		const back = modelMessageToLLMMessage(llmMessageToModelMessage(orig));
		const blocks = typeof back.content === "string" ? [] : back.content;
		const tr = blocks.find((b) => b.type === "tool_result") as
			| { type: "tool_result"; isError?: boolean }
			| undefined;
		expect(tr).toBeDefined();
		expect(tr!.isError).toBeUndefined();
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
