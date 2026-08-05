import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../benchmark/run-mixed-issue-team-live.mjs", import.meta.url), "utf8");

describe("mixed issue-team paid live benchmark contract", () => {
  it("fails closed before paid execution without an explicit bounded confirmation", () => {
    expect(source).toContain('process.argv.includes("--confirm-seven-paid-calls")');
    expect(source).toContain('process.env.NAIA_MIXED_TEAM_LIVE_CONFIRM === "1"');
    expect(source).toContain("if (paidCalls >= 7)");
    expect(source).toContain('return endedSession("mixed live paid-call ceiling reached")');
    expect(source).toContain("roleDeadlineMs: 180_000");
  });

  it("uses three real coding apps with one and only one writing role", () => {
    expect(source).toContain('agentKind: "claude-code"');
    expect(source).toContain('agentKind: "opencode"');
    expect(source).toContain('agentKind: "codex"');
    expect(source.match(/filesystemAccess: "workspace_write"/gu)).toHaveLength(1);
    expect(source).toContain('model: "opencode/deepseek-v4-flash-free"');
    expect(source).toContain('model: "azure-foundry/gpt-5-4-nano"');
  });

  it("requires exact artifacts, complete identities, and all three apps before allowing a claim", () => {
    expect(source).toContain('resultBytes === "NAIA_MIXED_TEAM_OK\\n"');
    expect(source).toContain('seedBytes === "SEED_MUST_STAY\\n"');
    expect(source).toContain("const evidenceComplete = receipts.length >= 4");
    expect(source).toContain('receipt.sessionEvidenceSource === "provider_reported"');
    expect(source).toContain("const mixedAppsObserved = new Set(receipts.map((receipt) => receipt.agentKind)).size === 3");
    expect(source).toContain("claimAllowed: passed");
  });
});
