import { describe, expect, it } from "vitest";
import {
	encodeFrame,
	parseFrame,
	PROTOCOL_VERSION,
	ProtocolError,
	type StdioFrame,
} from "../index.js";

/**
 * @nextain/agent-protocol — Phase A.1 test suite.
 *
 * Specs mirror `phase-a-test-plan.md` v2 §3 A.1. Tests that intentionally
 * fail against the current source are marked with a comment referencing the
 * corresponding B-BUG code (PR-03, PR-06, PR-08) and use `.fails` to
 * invert the pass/fail so the suite runs green while the bug is pinned.
 */

function makeFrame<P>(overrides: Partial<StdioFrame<P>> = {}): StdioFrame<P> {
	return {
		v: PROTOCOL_VERSION,
		id: "test-1",
		type: "request",
		payload: null as unknown as P,
		...overrides,
	};
}

// ─── PR-10 (C-GUARD) — ProtocolError identity ───────────────────────────

describe("ProtocolError", () => {
	it("has name === 'ProtocolError' and is an Error", () => {
		const err = new ProtocolError("some_code", "some message");
		expect(err.name).toBe("ProtocolError");
		expect(err).toBeInstanceOf(Error);
	});

	it("exposes `code` as a readable property", () => {
		const err = new ProtocolError("malformed_frame", "oops");
		expect(err.code).toBe("malformed_frame");
		expect(err.message).toBe("oops");
	});
});

// ─── PR-01 — encodeFrame has no newline characters ──────────────────────

describe("encodeFrame — output framing contract", () => {
	it("output contains no embedded newline characters", () => {
		const frame = makeFrame<{ text: string }>({
			payload: { text: "single-line" },
		});
		const line = encodeFrame(frame);
		expect(line).not.toMatch(/\n/);
		expect(line).not.toMatch(/\r/);
	});

	it("output has no trailing newline (caller adds framing)", () => {
		const frame = makeFrame();
		const line = encodeFrame(frame);
		expect(line.endsWith("\n")).toBe(false);
	});

	it("payload containing \\n inside a string is JSON-escaped, round-trips intact", () => {
		const frame = makeFrame<{ text: string }>({
			payload: { text: "line1\nline2\nline3" },
		});
		const line = encodeFrame(frame);
		// No raw newlines in the wire representation:
		expect(line).not.toMatch(/\n/);
		// Round-trip recovers the \n:
		const back = parseFrame<{ text: string }>(line);
		expect(back.payload.text).toBe("line1\nline2\nline3");
	});
});

// ─── PR-02 — round-trip for every FrameType and varied payloads ─────────

describe("parseFrame(encodeFrame(f)) — round-trip invariance", () => {
	const payloads: Array<[string, unknown]> = [
		["null", null],
		["empty object", {}],
		["simple object", { k: "v", n: 3 }],
		["empty array", []],
		["number array", [1, 2, 3]],
		["nested object", { a: { b: { c: [1, 2] } } }],
		["string", "just a string"],
		["number", 42],
		["boolean true", true],
		["boolean false", false],
	];

	for (const type of ["request", "response", "event"] as const) {
		for (const [label, payload] of payloads) {
			it(`${type} + ${label} round-trips deep-equal`, () => {
				const frame = makeFrame({ type, payload });
				const line = encodeFrame(frame);
				const back = parseFrame(line);
				expect(back).toEqual(frame);
			});
		}
	}
});

// ─── PR-11 — id round-trip ─────────────────────────────────────────────

describe("parseFrame — id preservation", () => {
	const ids = [
		"",
		"simple",
		"with-dashes",
		"with_underscores",
		"요청-한글-1",
		"mixed-한글-123",
		"a".repeat(1000),
		"🎉-unicode-emoji",
	];
	for (const id of ids) {
		it(`id "${id.slice(0, 40)}${id.length > 40 ? "..." : ""}" survives round-trip`, () => {
			const frame = makeFrame({ id });
			const back = parseFrame(encodeFrame(frame));
			expect(back.id).toBe(id);
		});
	}
});

// ─── PR-03 — parseFrame wraps JSON.parse errors ─────────────────────────
// B-BUG: current source throws raw SyntaxError. Pinned as red via .fails.

describe("parseFrame — malformed JSON handling", () => {
	it.fails(
		"[B-BUG PR-03] throws ProtocolError on malformed JSON (currently raw SyntaxError)",
		() => {
			expect(() => parseFrame("not json at all")).toThrowError(ProtocolError);
		},
	);

	it("[B-BUG PR-03 pin] currently throws SyntaxError — remove this test when PR-03 is fixed", () => {
		expect(() => parseFrame("not json at all")).toThrow(SyntaxError);
	});
});

// ─── PR-04/05 — shape-check throws ProtocolError ────────────────────────

describe("parseFrame — shape validation", () => {
	it("PR-04 non-object JSON input throws ProtocolError", () => {
		expect(() => parseFrame('"just a string"')).toThrowError(ProtocolError);
	});

	it("PR-04 JSON number throws ProtocolError", () => {
		expect(() => parseFrame("42")).toThrowError(ProtocolError);
	});

	it("PR-04 JSON null throws ProtocolError", () => {
		expect(() => parseFrame("null")).toThrowError(ProtocolError);
	});

	it("PR-04 JSON array throws ProtocolError", () => {
		expect(() => parseFrame("[1,2,3]")).toThrowError(ProtocolError);
	});

	it("PR-05 object missing v throws ProtocolError", () => {
		const bad = JSON.stringify({ id: "x", type: "request", payload: null });
		expect(() => parseFrame(bad)).toThrowError(ProtocolError);
	});

	it("PR-05 object missing id throws ProtocolError", () => {
		const bad = JSON.stringify({ v: "1", type: "request", payload: null });
		expect(() => parseFrame(bad)).toThrowError(ProtocolError);
	});

	it("PR-05 object missing payload throws ProtocolError", () => {
		const bad = JSON.stringify({ v: "1", id: "x", type: "request" });
		expect(() => parseFrame(bad)).toThrowError(ProtocolError);
	});

	it("PR-07 unknown type throws ProtocolError", () => {
		const bad = JSON.stringify({
			v: "1",
			id: "x",
			type: "unknown-type",
			payload: null,
		});
		expect(() => parseFrame(bad)).toThrowError(ProtocolError);
	});

	it("PR-05b missing type throws ProtocolError", () => {
		// Round 3 reviewer: spec implied but no assertion pinned.
		const bad = JSON.stringify({ v: "1", id: "x", payload: null });
		expect(() => parseFrame(bad)).toThrowError(ProtocolError);
	});

	it("PR-16 non-string id (number) throws ProtocolError", () => {
		// Round 3 reviewer: isFrame branch for typeof id !== "string" was unpinned.
		const bad = JSON.stringify({
			v: "1",
			id: 42,
			type: "request",
			payload: null,
		});
		expect(() => parseFrame(bad)).toThrowError(ProtocolError);
	});

	it("PR-16 non-string id (object) throws ProtocolError", () => {
		const bad = JSON.stringify({
			v: "1",
			id: { nested: "x" },
			type: "request",
			payload: null,
		});
		expect(() => parseFrame(bad)).toThrowError(ProtocolError);
	});

	it("PR-16 non-string type (array) throws ProtocolError", () => {
		// type === "request" should NOT match ["request"]; verify.
		const bad = JSON.stringify({
			v: "1",
			id: "x",
			type: ["request"],
			payload: null,
		});
		expect(() => parseFrame(bad)).toThrowError(ProtocolError);
	});
});

// ─── PR-12 — prototype pollution (security) ─────────────────────────────
// Round 3 (security profile) concrete recommendation. Node's JSON.parse
// treats "__proto__" as an own property (not a prototype setter), which
// means v8 already protects against pollution. Pin this so the contract
// does not silently regress if the parse path is ever replaced by
// Object.assign or a spread-based construction.

describe("parseFrame — prototype pollution rejection", () => {
	it("PR-12 __proto__ key does not pollute Object.prototype", () => {
		const line = JSON.stringify({
			v: "1",
			id: "x",
			type: "request",
			payload: null,
			__proto__: { isAdmin: true },
		});
		// Current Node behaviour: the parsed object's prototype is still
		// Object.prototype (unchanged). Verify.
		parseFrame(line);
		// Critical: no other object has been polluted.
		const witness = {} as { isAdmin?: unknown };
		expect(witness.isAdmin).toBeUndefined();
	});

	it("PR-12 __proto__ on a frame is stored as an own key (not a prototype setter)", () => {
		const line = JSON.stringify({
			v: "1",
			id: "x",
			type: "request",
			payload: { __proto__: { polluted: true } },
		});
		const frame = parseFrame<{ polluted?: unknown }>(line);
		// If JSON.parse had set the prototype, `polluted` would leak. It does not.
		expect((frame.payload as { polluted?: unknown }).polluted).toBeUndefined();
		// And global Object.prototype is unchanged:
		expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
	});

	it("PR-12 constructor key — frame stores it as data, but global Object.prototype is NOT tampered", () => {
		// JSON.parse treats "constructor" as a regular own property, so the
		// parsed frame's `.constructor` *will* be replaced on this specific
		// object. That is safe in isolation (no global pollution), but means
		// downstream code relying on `frame.constructor === Object` would be
		// surprised. Pin both facts:
		const line = JSON.stringify({
			v: "1",
			id: "x",
			type: "request",
			payload: null,
			constructor: { prototype: { tampered: true } },
		});
		const frame = parseFrame(line);
		// Fact 1: the own-property replaces the default constructor pointer on this object
		expect((frame as { constructor: unknown }).constructor).toEqual({
			prototype: { tampered: true },
		});
		// Fact 2: the GLOBAL Object.prototype is not tampered (the invariant that matters)
		const witness = {} as { tampered?: unknown };
		expect(witness.tampered).toBeUndefined();
		expect(Object.prototype.hasOwnProperty.call(Object.prototype, "tampered")).toBe(false);
	});

	it.fails(
		"[B-BUG PR-12 (minor)] parseFrame rejects frames with reserved JS keys (__proto__, constructor, prototype) — currently accepted",
		() => {
			// Defensive policy: a frame arriving over the wire should not use
			// reserved JS identifiers as payload keys. Currently accepted.
			const line = JSON.stringify({
				v: "1",
				id: "x",
				type: "request",
				payload: null,
				constructor: { x: 1 },
			});
			expect(() => parseFrame(line)).toThrowError(ProtocolError);
		},
	);
});

// ─── PR-13 — oversized payload ──────────────────────────────────────────

describe("parseFrame — oversized payload handling", () => {
	it("PR-13 1 MB payload round-trips without error", () => {
		// No documented limit today. Pin current behaviour (unbounded, synchronous).
		// A future limit would make this test red and force an explicit contract update.
		const big = "x".repeat(1024 * 1024);
		const frame = makeFrame<{ text: string }>({ payload: { text: big } });
		const line = encodeFrame(frame);
		expect(line.length).toBeGreaterThan(1024 * 1024);
		const back = parseFrame<{ text: string }>(line);
		expect(back.payload.text.length).toBe(big.length);
	});
});

// ─── PR-14 — UTF-8 / lone surrogate round-trip ──────────────────────────

describe("parseFrame — Unicode edge cases", () => {
	it("PR-14 payload with 4-byte emoji round-trips byte-identically", () => {
		const frame = makeFrame<{ text: string }>({
			payload: { text: "Hello 🎉 World 한글 𐍈" },
		});
		const back = parseFrame<{ text: string }>(encodeFrame(frame));
		expect(back.payload.text).toBe(frame.payload.text);
	});

	it("PR-14 payload with lone surrogate — JSON.stringify preserves it, parse accepts it", () => {
		// Lone high surrogate U+D800. Node JSON preserves the replacement behaviour
		// consistently across encode/decode (verified on Node 22). Pin behaviour.
		const frame = makeFrame<{ text: string }>({
			payload: { text: "\uD800 lone" },
		});
		const line = encodeFrame(frame);
		const back = parseFrame<{ text: string }>(line);
		// Either identical (current behaviour) OR replaced — pin whichever.
		// Current: Node preserves.
		expect(back.payload.text).toBe("\uD800 lone");
	});
});

// ─── PR-15 — duplicate keys (last-wins) ─────────────────────────────────

describe("parseFrame — duplicate key handling", () => {
	it("PR-15 duplicate 'v' keys — last value wins per JSON.parse semantics", () => {
		// Hand-crafted JSON (JSON.stringify can't produce duplicates).
		const line = '{"v":"1","v":"99","id":"x","type":"request","payload":null}';
		// Current: JSON.parse last-wins → v === "99" → B-BUG PR-06 means this
		// is accepted. Pin behaviour explicitly so a future strict parser is
		// forced to update this test.
		const back = parseFrame(line);
		expect(back.v).toBe("99" as unknown as typeof PROTOCOL_VERSION);
	});
});

// ─── PR-06 — version value check ─────────────────────────────────────────
// B-BUG: isFrame at :54 only checks typeof f["v"] === "string", ignores value.
// JSDoc :16-18 explicitly states "accepting unknown versions would be silent
// corruption" — implementation contradicts its own comment.

describe("parseFrame — wire version enforcement", () => {
	it("valid version '1' parses", () => {
		const line = JSON.stringify({
			v: "1",
			id: "x",
			type: "request",
			payload: null,
		});
		const back = parseFrame(line);
		expect(back.v).toBe("1");
	});

	it.fails(
		"[B-BUG PR-06] unknown version string '99' rejected (currently accepted — silent corruption risk)",
		() => {
			const line = JSON.stringify({
				v: "99",
				id: "x",
				type: "request",
				payload: null,
			});
			expect(() => parseFrame(line)).toThrowError(ProtocolError);
		},
	);

	it("[B-BUG PR-06 pin] currently accepts any string v — remove when PR-06 is fixed", () => {
		const line = JSON.stringify({
			v: "99",
			id: "x",
			type: "request",
			payload: null,
		});
		const back = parseFrame(line);
		expect(back.v).toBe("99" as unknown as typeof PROTOCOL_VERSION);
	});

	it.fails(
		"[B-BUG PR-06] empty version string rejected (currently accepted)",
		() => {
			const line = JSON.stringify({
				v: "",
				id: "x",
				type: "request",
				payload: null,
			});
			expect(() => parseFrame(line)).toThrowError(ProtocolError);
		},
	);
});

// ─── PR-08 — encodeFrame validates shape ────────────────────────────────
// B-BUG: encodeFrame has no validation; any unknown-cast input is serialized.

describe("encodeFrame — shape validation", () => {
	it.fails(
		"[B-BUG PR-08] rejects frame with unknown version (currently serializes blindly)",
		() => {
			const bogus = {
				v: "99",
				id: "x",
				type: "request",
				payload: null,
			} as unknown as StdioFrame;
			expect(() => encodeFrame(bogus)).toThrowError(ProtocolError);
		},
	);

	it.fails(
		"[B-BUG PR-08] rejects frame with unknown type (currently serializes blindly)",
		() => {
			const bogus = {
				v: "1",
				id: "x",
				type: "not-a-real-type",
				payload: null,
			} as unknown as StdioFrame;
			expect(() => encodeFrame(bogus)).toThrowError(ProtocolError);
		},
	);

	it("[B-BUG PR-08 pin] currently serializes unknown-type frames without complaint", () => {
		const bogus = {
			v: "1",
			id: "x",
			type: "not-a-real-type",
			payload: null,
		} as unknown as StdioFrame;
		const out = encodeFrame(bogus);
		expect(out).toContain("not-a-real-type");
	});
});

// ─── Constant guard: PROTOCOL_VERSION ───────────────────────────────────

describe("PROTOCOL_VERSION constant guard", () => {
	it("is exactly '1' at Phase 1 freeze", () => {
		expect(PROTOCOL_VERSION).toBe("1");
	});
});
