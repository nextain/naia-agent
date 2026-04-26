import type { ReportStats, VerificationResult } from "@nextain/agent-types";

export interface FormatReportInput {
  filesChanged: number;
  additions: number;
  deletions: number;
  durationMs: number;
  verifications: readonly VerificationResult[];
}

/**
 * Honest report formatter (D19). Numeric only — no editorial. Used by
 * supervisor before emitting the `report` chunk.
 *
 * Example output:
 *   files: 3 (+12/-3)
 *   tests: 24/24 PASS (3.2s)
 *   typecheck: PASS (1.8s)
 *   elapsed: 12.4s
 */
export function formatReport(input: FormatReportInput): string {
  const lines: string[] = [];
  lines.push(
    `files: ${input.filesChanged} (+${input.additions}/-${input.deletions})`,
  );
  for (const v of input.verifications) {
    lines.push(formatVerifier(v));
  }
  lines.push(`elapsed: ${(input.durationMs / 1000).toFixed(1)}s`);
  return lines.join("\n");
}

export function reportStatsFromInput(input: FormatReportInput): ReportStats {
  let testsPassed = 0;
  let testsFailed = 0;
  for (const v of input.verifications) {
    if (v.runner === "test") {
      testsPassed = v.stats.passed ?? 0;
      testsFailed = v.stats.failed ?? 0;
    }
  }
  return {
    filesChanged: input.filesChanged,
    additions: input.additions,
    deletions: input.deletions,
    testsPassed,
    testsFailed,
    durationMs: input.durationMs,
  };
}

function formatVerifier(v: VerificationResult): string {
  const dur = (v.durationMs / 1000).toFixed(1);
  if (v.runner === "test") {
    const passed = v.stats.passed ?? 0;
    const failed = v.stats.failed ?? 0;
    const total = v.stats.total ?? passed + failed;
    const verdict = v.pass ? "PASS" : "FAIL";
    return `tests: ${passed}/${total} ${verdict}${
      failed > 0 ? ` (failed=${failed})` : ""
    } (${dur}s)${v.partial ? " [partial]" : ""}`;
  }
  const verdict = v.pass ? "PASS" : "FAIL";
  return `${v.runner}: ${verdict} (${dur}s)${v.partial ? " [partial]" : ""}`;
}
