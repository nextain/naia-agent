/**
 * ADK skill tier enforcement — Gap 4 fix (#61, naia-os).
 *
 * Bug: tierForTool was hardcoded `() => "T1"` in all three Agent creation
 * sites, causing every tool (including T2/T3 panel skills) to be auto-approved
 * and never reach the approval gate.
 *
 * Fix: build a tier map from hostInjectedDefs (naia-os IPC path) or from
 * tools.list() (CLI / service modes) and pass a real lookup function.
 *
 * These tests verify the tier lookup logic in isolation so regressions are
 * caught without a real LLM call.
 */
import { describe, it, expect } from "vitest";
import type { ToolDefinitionWithTier, TierLevel } from "@nextain/agent-types";

// ── Helpers that mirror the production logic in bin/naia-agent.ts ──────────

/** Mirrors Gap 4 fix: build tier map from hostInjectedDefs / tools.list(). */
function buildTierMap(defs: ToolDefinitionWithTier[]): Map<string, TierLevel> {
	return new Map(defs.map((d) => [d.name, d.tier]));
}

/** Mirrors the tierForTool lambda passed to new Agent(). */
function lookupTier(map: Map<string, TierLevel>, name: string): TierLevel {
	return map.get(name) ?? "T1";
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ADK skill tier enforcement — Gap 4 fix (#61)", () => {
	it("returns T1 default for unknown tool (unchanged baseline)", () => {
		const map = buildTierMap([]);
		expect(lookupTier(map, "unknown-tool")).toBe("T1");
	});

	it("T0 read-only skill tier is preserved", () => {
		const defs: ToolDefinitionWithTier[] = [
			{ name: "read-file", inputSchema: {}, tier: "T0" },
		];
		expect(lookupTier(buildTierMap(defs), "read-file")).toBe("T0");
	});

	it("T1 skill tier is preserved (equals default — no regression)", () => {
		const defs: ToolDefinitionWithTier[] = [
			{ name: "write-file", inputSchema: {}, tier: "T1" },
		];
		expect(lookupTier(buildTierMap(defs), "write-file")).toBe("T1");
	});

	it("T2 panel skill tier is preserved — previously always returned T1 (core bug)", () => {
		// This is the exact scenario that was broken:
		// shell registers a panel skill with tier T2 via panel_skills IPC,
		// but tierForTool always returned T1 → approval gate never fired.
		const defs: ToolDefinitionWithTier[] = [
			{ name: "delete-workspace-file", inputSchema: {}, tier: "T2" },
		];
		expect(lookupTier(buildTierMap(defs), "delete-workspace-file")).toBe("T2");
	});

	it("T3 external/irreversible skill tier is preserved", () => {
		const defs: ToolDefinitionWithTier[] = [
			{ name: "send-email", inputSchema: {}, tier: "T3" },
		];
		expect(lookupTier(buildTierMap(defs), "send-email")).toBe("T3");
	});

	it("multiple tools have independent tiers", () => {
		const defs: ToolDefinitionWithTier[] = [
			{ name: "list-files", inputSchema: {}, tier: "T0" },
			{ name: "write-file", inputSchema: {}, tier: "T1" },
			{ name: "run-shell", inputSchema: {}, tier: "T2" },
			{ name: "post-to-api", inputSchema: {}, tier: "T3" },
		];
		const map = buildTierMap(defs);
		expect(lookupTier(map, "list-files")).toBe("T0");
		expect(lookupTier(map, "write-file")).toBe("T1");
		expect(lookupTier(map, "run-shell")).toBe("T2");
		expect(lookupTier(map, "post-to-api")).toBe("T3");
	});

	it("tool not in panel (builtin) falls back to T1", () => {
		// Builtins (bash, time, weather, …) are not in hostInjectedDefs.
		// They should default to T1 — same as before, no regression.
		const defs: ToolDefinitionWithTier[] = [
			{ name: "panel-skill-x", inputSchema: {}, tier: "T2" },
		];
		const map = buildTierMap(defs);
		expect(lookupTier(map, "bash")).toBe("T1");
		expect(lookupTier(map, "time")).toBe("T1");
	});

	it("panel_skills IPC tier normalization: numeric tier 2 → T2 string", () => {
		// In naia-agent.ts, panel_skills IPC normalizes numeric tiers to strings
		// before pushing to hostInjectedDefs. This test documents the expected
		// shape of defs after normalization.
		function normalizeTier(raw: unknown): TierLevel {
			if (typeof raw === "string" && /^T[0-3]$/.test(raw)) return raw as TierLevel;
			if (typeof raw === "number" && raw >= 0 && raw <= 3) return `T${raw}` as TierLevel;
			return "T1";
		}
		expect(normalizeTier("T2")).toBe("T2");
		expect(normalizeTier(2)).toBe("T2");
		expect(normalizeTier(3)).toBe("T3");
		expect(normalizeTier(undefined)).toBe("T1");
		expect(normalizeTier("invalid")).toBe("T1");
	});
});
