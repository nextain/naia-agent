// UC-HLMEM parse/assign helpers — pure, deterministic (no side effects, testable).
import type { HumanlikeScenario } from "./types.js";

/** Parse the forced `예측: A|B` first-line format. null = unparseable. */
export function parsePrediction(text: string): "A" | "B" | null {
  const m = text.match(/예측\s*[:：]?\s*\(?\s*([AB])/i);
  return m ? (m[1]!.toUpperCase() as "A" | "B") : null;
}

/** An empty/degenerate response is an execution/infra failure (e.g. empty live
 *  completion from a bad token/credential), NOT a clean prediction — must be
 *  separated so it never false-scores (FR-HLMEM-6). */
export function isDegenerateResponse(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return true;
  // a lone emoji / punctuation with no letters or digits
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  return false;
}

export interface AssignedOptions {
  readonly optA: string;
  readonly optB: string;
  readonly correctLabel: "A" | "B";
  readonly probe: string;
}

/**
 * Position-bias control (FR-HLMEM-4): assign the target user's correct option and
 * the other option to labels A/B. `correctIsA` is injected (Math.random in the
 * runner; fixed in tests) so this stays a pure function.
 */
export function assignOptions(
  scenario: HumanlikeScenario,
  targetUserId: string,
  correctIsA: boolean,
): AssignedOptions {
  const correct = scenario.options.find((o) => o.correctFor === targetUserId);
  const other = scenario.options.find((o) => o.correctFor !== targetUserId);
  if (!correct || !other) {
    throw new Error(`scenario ${scenario.id}: no option pair for target ${targetUserId}`);
  }
  const optA = correctIsA ? correct.text : other.text;
  const optB = correctIsA ? other.text : correct.text;
  const correctLabel: "A" | "B" = correctIsA ? "A" : "B";
  const probe = `${scenario.situation} 후보는 (A) ${optA} (B) ${optB}. 내가 뭘 고를 것 같아?`;
  return { optA, optB, correctLabel, probe };
}
