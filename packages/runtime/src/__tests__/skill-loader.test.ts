import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSkillLoader, parseSkillManifest } from "../skill-loader.js";

/**
 * Phase A.2 — `parseSkillManifest` + helpers unit tests.
 * Specs mirror `phase-a-test-plan.md` v3 §3 A.2 (SK-01..SK-13).
 *
 * A.2 is the last Phase A sub-phase. Cross-review log:
 * - Round 10 pending (after tests written) — final rotated profile
 */

const FALLBACKS = { fallbackName: "fallback-dir", sourcePath: "test/SKILL.md" };

function wrapFM(inner: string): string {
	return `---\n${inner}\n---\nbody content here`;
}

// ─── SK-01 — minimal valid manifest ────────────────────────────────────

describe("parseSkillManifest — minimal valid (SK-01)", () => {
	it("name + description + version + tier + empty input_schema", () => {
		const raw = wrapFM(
			`name: my-skill\ndescription: A test skill\nversion: 0.1.0\ntier: T1`,
		);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d).not.toBeNull();
		expect(d?.name).toBe("my-skill");
		expect(d?.description).toBe("A test skill");
		expect(d?.version).toBe("0.1.0");
		expect(d?.tier).toBe("T1");
		expect(d?.inputSchema).toEqual({});
	});
});

// ─── SK-02 — block scalar description ──────────────────────────────────

describe("parseSkillManifest — block scalar description (SK-02)", () => {
	it("pipe `|` block scalar joins lines with \\n, strips leading indent", () => {
		const raw = wrapFM(
			`name: s\ndescription: |\n  line1\n  line2\n  line3\nversion: 0.1.0`,
		);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.description).toBe("line1\nline2\nline3");
	});

	it("`>` block scalar also recognized (folded)", () => {
		const raw = wrapFM(`name: s\ndescription: >\n  folded\n  text\nversion: 0.1.0`);
		const d = parseSkillManifest(raw, FALLBACKS);
		// Current impl treats `>` same as `|` (no folding logic) — pin behaviour
		expect(d?.description).toBe("folded\ntext");
	});

	it("trailing blank lines trimmed from block scalar", () => {
		const raw = wrapFM(`name: s\ndescription: |\n  content\n\n\nversion: 0.1.0`);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.description).toBe("content");
	});
});

// ─── SK-03 — block list ────────────────────────────────────────────────

describe("parseSkillManifest — block list (SK-03)", () => {
	it("block list under a key captures items", () => {
		const raw = wrapFM(
			`name: s\ndescription: d\nversion: 0.1.0\ntags:\n  - alpha\n  - beta`,
		);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.tags).toEqual(["alpha", "beta"]);
	});
});

// ─── SK-04 — inline list ───────────────────────────────────────────────

describe("parseSkillManifest — inline list (SK-04)", () => {
	it("inline `[a, b]` parses as array", () => {
		const raw = wrapFM(
			`name: s\ndescription: d\nversion: 0.1.0\ntags: [foo, bar, baz]`,
		);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.tags).toEqual(["foo", "bar", "baz"]);
	});

	it("quoted inline preserves spaces", () => {
		const raw = wrapFM(
			`name: s\ndescription: d\nversion: 0.1.0\ntags: ["a b", 'c d']`,
		);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.tags).toEqual(["a b", "c d"]);
	});
});

// ─── SK-05 — empty inline list ──────────────────────────────────────────

describe("parseSkillManifest — empty list (SK-05)", () => {
	it("inline `[]` parses to empty tags", () => {
		const raw = wrapFM(`name: s\ndescription: d\nversion: 0.1.0\ntags: []`);
		const d = parseSkillManifest(raw, FALLBACKS);
		// Per :282: "if tags !== undefined && tags.length > 0" — empty yields undefined
		expect(d?.tags).toBeUndefined();
	});
});

// ─── SK-06 — missing name → fallback (by design) ───────────────────────

describe("parseSkillManifest — missing name (SK-06)", () => {
	it("missing `name` uses fallbacks.fallbackName (directory-name fallback)", () => {
		const raw = wrapFM(`description: d\nversion: 0.1.0\ntier: T1`);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.name).toBe(FALLBACKS.fallbackName);
	});
});

// ─── SK-07 — unknown top-level keys tolerated ──────────────────────────

describe("parseSkillManifest — unknown keys tolerated (SK-07)", () => {
	it("unknown top-level key silently dropped", () => {
		const raw = wrapFM(
			`name: s\ndescription: d\nversion: 0.1.0\nfutureField: some-value`,
		);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d).not.toBeNull();
		expect(d?.name).toBe("s");
		// Ensure the unknown key doesn't leak into descriptor
		expect((d as unknown as Record<string, unknown>).futureField).toBeUndefined();
	});
});

// ─── SK-BUG-A — description starting with `[` silently dropped (R11) ───

describe("parseSkillManifest — bracketed scalar in description field (SK-BUG-A)", () => {
	it("[B-BUG SK-BUG-A pin] description of exactly '[DRAFT]' is parsed as list then dropped to ''", () => {
		// Condition: value startsWith '[' AND endsWith ']' takes list branch at :292-296.
		// '[DRAFT]' matches → ["DRAFT"] → typeof==='string' at :255 fails → description=''.
		const raw = `---\nname: s\ndescription: [DRAFT]\nversion: 0.1.0\n---\nbody`;
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.description).toBe("");
	});

	it.fails(
		"[B-BUG SK-BUG-A Phase D contract] description '[DRAFT]' should preserve the text",
		() => {
			const raw = `---\nname: s\ndescription: [DRAFT]\nversion: 0.1.0\n---\nbody`;
			const d = parseSkillManifest(raw, FALLBACKS);
			expect(d?.description).toContain("DRAFT");
		},
	);

	it("description '[DRAFT] suffix text' (not pure bracketed) stays as string (endsWith not ']')", () => {
		// Narrows the bug scope — only pure `[...]` values trip it.
		const raw = `---\nname: s\ndescription: [DRAFT] draft text\nversion: 0.1.0\n---\nbody`;
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.description).toBe("[DRAFT] draft text");
	});
});

// ─── SK-BUG-B — inline list trailing comma → phantom tag (R11) ────────

describe("parseSkillManifest — inline-list trailing comma (SK-BUG-B)", () => {
	it("[B-BUG SK-BUG-B pin] trailing comma produces phantom empty-string tag", () => {
		const raw = `---\nname: s\ndescription: d\nversion: 0.1.0\ntags: [a, b, ]\n---\nbody`;
		const d = parseSkillManifest(raw, FALLBACKS);
		// parseScalarOrList at :295 uses inner.split(",") — trailing comma
		// yields three elements including "". Current filter at :269-271
		// keeps strings including "".
		expect(d?.tags).toEqual(["a", "b", ""]);
	});

	it.fails(
		"[B-BUG SK-BUG-B Phase D contract] trailing comma should NOT produce empty tag",
		() => {
			const raw = `---\nname: s\ndescription: d\nversion: 0.1.0\ntags: [a, b, ]\n---\nbody`;
			const d = parseSkillManifest(raw, FALLBACKS);
			expect(d?.tags).toEqual(["a", "b"]);
		},
	);
});

// ─── SK-EDGE — other adversarial inputs pinned to current behaviour ────

describe("parseSkillManifest — adversarial edges (R11)", () => {
	it("BOM (U+FEFF) before --- breaks front-matter detection (regex anchored at ^)", () => {
		const raw = `﻿---\nname: s\ndescription: d\nversion: 0.1.0\n---\nbody`;
		const d = parseSkillManifest(raw, FALLBACKS);
		// Regex at :287 requires literal `---` at position 0, BOM defeats it.
		expect(d).toBeNull();
	});

	it("[SK-EDGE CRLF pin] CRLF breaks per-key parsing — top-level regex .* fails on trailing \\r, descriptor returns all fallbacks", () => {
		// Frontmatter extraction succeeds (outer regex tolerates \r via \s*),
		// but per-line key regex `/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/` fails on
		// "name: s\r": `.*` doesn't eat \r and `$` without /m requires string
		// end, which \r is not. So every key is silently lost → fallback.
		const raw = `---\r\nname: s\r\ndescription: d\r\nversion: 0.1.0\r\n---\r\nbody`;
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d).not.toBeNull();
		expect(d?.name).toBe(FALLBACKS.fallbackName);
		expect(d?.description).toBe("");
	});

	it.fails(
		"[B-BUG SK-EDGE-CRLF Phase D contract] CRLF frontmatter should parse with trimmed \\r — user fields preserved",
		() => {
			const raw = `---\r\nname: s\r\ndescription: d\r\nversion: 0.1.0\r\n---\r\nbody`;
			const d = parseSkillManifest(raw, FALLBACKS);
			expect(d?.name).toBe("s");
			expect(d?.description).toBe("d");
		},
	);

	it("triple-dash inside block scalar truncates early (non-greedy regex)", () => {
		const raw = `---\nname: s\ndescription: |\n  before ---\n  after\nversion: 0.1.0\n---\nbody`;
		const d = parseSkillManifest(raw, FALLBACKS);
		// The outer regex `([\s\S]*?)\n---` is non-greedy — it closes at the
		// FIRST `\n---` match. Any literal `---` on its own line inside a
		// block scalar prematurely ends the frontmatter.
		// Here "  before ---" has `---` at end but preceded by spaces, not \n,
		// so it shouldn't trigger. Let's pin behaviour carefully.
		expect(d).not.toBeNull();
		// description should contain both lines (the inner --- is not on its own line)
		expect(d?.description).toContain("before");
	});
});

// ─── SK-08 — tab indentation (R11 add) ─────────────────────────────────

describe("parseSkillManifest — tab indentation (SK-08)", () => {
	it("tab-indented block scalar content parses (strip leading tabs at :233)", () => {
		const raw = `---\nname: s\ndescription: |\n\tline1\n\tline2\nversion: 0.1.0\n---\nbody`;
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.description).toBe("line1\nline2");
	});

	it("tab-indented block list items parse", () => {
		const raw = `---\nname: s\ndescription: d\nversion: 0.1.0\ntags:\n\t- tab-item-1\n\t- tab-item-2\n---\nbody`;
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.tags).toEqual(["tab-item-1", "tab-item-2"]);
	});

	it("mixed space+tab indentation: at :205, only leading ' ' OR '\\t' at position 0 excludes top-level match", () => {
		// " \tkey: value" starts with space → treated as continuation of
		// current collecting key. If no key is being collected, it's just lost.
		// Pin current behaviour.
		const raw = `---\nname: s\ndescription: |\n  mixed\n\ttab\nversion: 0.1.0\n---\nbody`;
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.description).toBe("mixed\ntab");
	});
});

// ─── SK-09 — Unicode fields ────────────────────────────────────────────

describe("parseSkillManifest — Unicode fields (SK-09)", () => {
	it("Korean name, description, tag round-trip unchanged", () => {
		const raw = wrapFM(
			`name: 한글-skill\ndescription: 한글 설명입니다\nversion: 0.1.0\ntier: T1\ntags: [검색, 분석]`,
		);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.name).toBe("한글-skill");
		expect(d?.description).toBe("한글 설명입니다");
		expect(d?.tags).toEqual(["검색", "분석"]);
	});

	it("block scalar with Korean content preserves newlines", () => {
		const raw = wrapFM(
			`name: s\ndescription: |\n  첫 줄\n  둘째 줄\nversion: 0.1.0`,
		);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.description).toBe("첫 줄\n둘째 줄");
	});
});

// ─── SK-10 — input_schema one-level nesting ────────────────────────────

describe("parseSkillManifest — input_schema nesting (SK-10)", () => {
	it("one-level nested properties parses correctly", () => {
		const raw = wrapFM(
			`name: s\ndescription: d\nversion: 0.1.0\ninput_schema:\n  type: object\n  properties:\n    foo:\n      type: string`,
		);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.inputSchema).toEqual({
			type: "object",
			properties: { foo: { type: "string" } },
		});
	});

	it("input_schema with required list", () => {
		const raw = wrapFM(
			`name: s\ndescription: d\nversion: 0.1.0\ninput_schema:\n  type: object\n  required: [foo, bar]`,
		);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.inputSchema).toEqual({
			type: "object",
			required: ["foo", "bar"],
		});
	});
});

// ─── SK-11 — invalid tier → T1 default ─────────────────────────────────

describe("parseSkillManifest — invalid tier fallback (SK-11)", () => {
	it("invalid tier value falls back to T1", () => {
		const raw = wrapFM(
			`name: s\ndescription: d\nversion: 0.1.0\ntier: T5`,
		);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.tier).toBe("T1");
	});

	it("missing tier falls back to T1", () => {
		const raw = wrapFM(`name: s\ndescription: d\nversion: 0.1.0`);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.tier).toBe("T1");
	});

	it("valid tiers T0/T2/T3 preserved", () => {
		for (const tier of ["T0", "T2", "T3"] as const) {
			const raw = wrapFM(`name: s\ndescription: d\nversion: 0.1.0\ntier: ${tier}`);
			const d = parseSkillManifest(raw, FALLBACKS);
			expect(d?.tier).toBe(tier);
		}
	});
});

// ─── SK-12 — empty tags → undefined ─────────────────────────────────────

describe("parseSkillManifest — tags emptiness semantics (SK-12)", () => {
	it("empty tags array → descriptor.tags is undefined (not [])", () => {
		const raw = wrapFM(`name: s\ndescription: d\nversion: 0.1.0\ntags: []`);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.tags).toBeUndefined();
	});

	it("non-string values in tags filtered out", () => {
		// Source has no way to produce non-string from inline list (stripQuotes
		// returns string), but the filter at :270 is defensive. Pin it exists.
		const raw = wrapFM(
			`name: s\ndescription: d\nversion: 0.1.0\ntags: [valid, "also"]`,
		);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.tags).toEqual(["valid", "also"]);
	});
});

// ─── SK-13 — malformed front-matter → null ─────────────────────────────

describe("parseSkillManifest — malformed input (SK-13)", () => {
	it("no front matter → null", () => {
		const d = parseSkillManifest("just body, no frontmatter", FALLBACKS);
		expect(d).toBeNull();
	});

	it("unclosed front matter → null", () => {
		const d = parseSkillManifest("---\nname: s\ndescription: d\nno-closing", FALLBACKS);
		expect(d).toBeNull();
	});

	it("empty file → null", () => {
		expect(parseSkillManifest("", FALLBACKS)).toBeNull();
	});

	it("zero-content front-matter (---\\n---\\n) → null (regex requires \\n--- boundary)", () => {
		// The extractFrontMatter regex at :287 requires at least one \n before
		// the closing ---. `---\n---\n` has no preceding \n for the closing
		// boundary, so the regex fails to match. Pin current behaviour.
		const d = parseSkillManifest("---\n---\nbody", FALLBACKS);
		expect(d).toBeNull();
	});

	it("frontmatter with only whitespace content → null (`if (!fm) return null` at :176 treats empty string as falsy)", () => {
		// `---\n\n---\n` has an empty frontmatter block. parseSkillManifest's
		// guard at `skill-loader.ts:176` uses truthy check (`if (!fm)`), so
		// empty string falls through as null. Note: this is subtly different
		// from "no front matter at all" (extractFrontMatter would return null)
		// and from "valid frontmatter with all fields missing".
		const d = parseSkillManifest("---\n\n---\nbody", FALLBACKS);
		expect(d).toBeNull();
	});

	it("single-field front-matter → descriptor with fallbacks for unfilled fields", () => {
		// The smallest non-empty frontmatter that triggers the parse path.
		const d = parseSkillManifest(
			"---\nname: tiny\n---\nbody",
			FALLBACKS,
		);
		expect(d).not.toBeNull();
		expect(d?.name).toBe("tiny");
		expect(d?.description).toBe("");
		expect(d?.version).toBe("0.0.0");
		expect(d?.tier).toBe("T1");
	});
});

// ─── FileSkillLoader — class lifecycle (tmpdir I/O) ────────────────────

describe("FileSkillLoader — lifecycle and scan", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "skill-loader-test-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true }).catch(() => {});
	});

	async function writeSkill(name: string, body: string) {
		const dir = join(root, ".agents", "skills", name);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "SKILL.md"), body, "utf-8");
	}

	it("list returns empty array when skills dir does not exist", async () => {
		const loader = new FileSkillLoader({ workspaceRoot: root });
		const list = await loader.list();
		expect(list).toEqual([]);
	});

	it("list discovers SKILL.md files and parses descriptors", async () => {
		await writeSkill(
			"alpha",
			"---\nname: alpha\ndescription: alpha skill\nversion: 0.1.0\ntier: T1\n---\nbody",
		);
		await writeSkill(
			"beta",
			"---\nname: beta\ndescription: beta skill\nversion: 0.2.0\ntier: T2\n---\nbody",
		);
		const loader = new FileSkillLoader({ workspaceRoot: root });
		const list = await loader.list();
		expect(list.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
	});

	it("get returns descriptor by name, null when absent", async () => {
		await writeSkill(
			"alpha",
			"---\nname: alpha\ndescription: a\nversion: 0.1.0\n---\nbody",
		);
		const loader = new FileSkillLoader({ workspaceRoot: root });
		const hit = await loader.get("alpha");
		expect(hit?.name).toBe("alpha");
		const miss = await loader.get("nonexistent");
		expect(miss).toBeNull();
	});

	it("list caches — reload clears cache", async () => {
		await writeSkill(
			"alpha",
			"---\nname: alpha\ndescription: a\nversion: 0.1.0\n---\nbody",
		);
		const loader = new FileSkillLoader({ workspaceRoot: root });
		const first = await loader.list();
		expect(first).toHaveLength(1);

		// Add a second skill — without reload, list stays cached
		await writeSkill(
			"beta",
			"---\nname: beta\ndescription: b\nversion: 0.1.0\n---\nbody",
		);
		const cached = await loader.list();
		expect(cached).toHaveLength(1);

		loader.reload();
		const fresh = await loader.list();
		expect(fresh).toHaveLength(2);
	});

	it("invoke without injected invoker returns parse-only error", async () => {
		await writeSkill(
			"alpha",
			"---\nname: alpha\ndescription: a\nversion: 0.1.0\n---\nbody",
		);
		const loader = new FileSkillLoader({ workspaceRoot: root });
		const result = await loader.invoke("alpha", { args: {} });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("parse-only");
	});

	it("invoke on non-existent skill returns not-found error", async () => {
		const loader = new FileSkillLoader({ workspaceRoot: root });
		const result = await loader.invoke("ghost", { args: {} });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("not found");
	});

	it("invoker is called when injected", async () => {
		await writeSkill(
			"alpha",
			"---\nname: alpha\ndescription: a\nversion: 0.1.0\n---\nbody",
		);
		const loader = new FileSkillLoader({
			workspaceRoot: root,
			invoker: async (d, input) => ({
				content: `ran ${d.name} with args=${JSON.stringify(input.args)}`,
			}),
		});
		const result = await loader.invoke("alpha", { args: { x: 1 } });
		expect(result.content).toBe('ran alpha with args={"x":1}');
		expect(result.isError).toBeUndefined();
	});

	it("malformed SKILL.md warns via onWarn and is skipped", async () => {
		// No front matter → parseSkillManifest returns null → skill skipped
		await writeSkill("broken", "no frontmatter just body");
		const warnings: string[] = [];
		const loader = new FileSkillLoader({
			workspaceRoot: root,
			onWarn: (msg) => warnings.push(msg),
		});
		const list = await loader.list();
		expect(list).toHaveLength(0);
		expect(warnings.some((w) => w.includes("malformed"))).toBe(true);
	});

	it("non-directory entries in skills/ are ignored", async () => {
		// Create a stray file at .agents/skills/not-a-dir.txt
		await mkdir(join(root, ".agents", "skills"), { recursive: true });
		await writeFile(join(root, ".agents", "skills", "stray.txt"), "ignored");
		const loader = new FileSkillLoader({ workspaceRoot: root });
		const list = await loader.list();
		expect(list).toEqual([]);
	});

	it("skill dir without SKILL.md warns via onWarn", async () => {
		await mkdir(join(root, ".agents", "skills", "empty-dir"), { recursive: true });
		const warnings: string[] = [];
		const loader = new FileSkillLoader({
			workspaceRoot: root,
			onWarn: (msg) => warnings.push(msg),
		});
		const list = await loader.list();
		expect(list).toEqual([]);
		expect(warnings.some((w) => w.includes("failed to read"))).toBe(true);
	});
});

// ─── sourcePath and author optional fields ─────────────────────────────

describe("parseSkillManifest — optional fields", () => {
	it("sourcePath from fallbacks is set on descriptor", () => {
		const raw = wrapFM(`name: s\ndescription: d\nversion: 0.1.0`);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.sourcePath).toBe(FALLBACKS.sourcePath);
	});

	it("author field preserved when present", () => {
		const raw = wrapFM(
			`name: s\ndescription: d\nversion: 0.1.0\nauthor: Luke`,
		);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.author).toBe("Luke");
	});

	it("author field absent when not provided", () => {
		const raw = wrapFM(`name: s\ndescription: d\nversion: 0.1.0`);
		const d = parseSkillManifest(raw, FALLBACKS);
		expect(d?.author).toBeUndefined();
	});
});
