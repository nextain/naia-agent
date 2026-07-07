// UC-HLMEM parse/assign helpers — pure, deterministic (no side effects, testable).
import type { HumanlikeScenario } from "./types.js";

/** Parse the forced `예측: A|B` format. null = unparseable.
 *  Robust to: a word starting with A/B ("Apple" ≠ A — word-boundary guarded) and a
 *  negation ("B가 아니라 A" → A). Takes standalone A/B tokens in the ~40 chars after
 *  the first 예측; a trailing "아니라/말고" negation picks the LAST token. */
export function parsePrediction(text: string): "A" | "B" | null {
  const seg = text.match(/예측\s*[:：]?\s*([\s\S]{0,40})/i)?.[1] ?? "";
  const toks = [...seg.matchAll(/(?<![A-Za-z])([AB])(?![A-Za-z])/gi)].map((m) => m[1]!.toUpperCase());
  if (toks.length === 0) return null;
  if (/아니라|말고/.test(seg) && toks.length >= 2) return toks[toks.length - 1] as "A" | "B";
  return toks[0] as "A" | "B";
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
  if (targetUserId === "_") throw new Error("assignOptions: '_' is the distractor sentinel, not a target user");
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
