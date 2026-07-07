// UC-HLMEM types — human-like memory measurement (memory-as-user-model).
// Contract: docs/progress/99.dev-comm/UC-HLMEM-humanlike-memory-measurement-contract-2026-07-07.md
// PURE deterministic core — NO memory/LLM/provider imports (import-boundary clean).
// The live SUT (P5) is a separate module that wires MemoryPort + ProviderPort.

/** A seed turn = the user's past utterance saved to long-term memory (MemoryPort.save). */
export interface SeedTurn {
  readonly userText: string;
  /** optional assistant reply that was in that historical turn. */
  readonly assistantText?: string;
  /** F3 only (P6): emotional VALENCE in [0,1] (0.5 neutral). NOT intensity. */
  readonly emotion?: number;
  /** F3 only (P6): importance override in [0,1]. */
  readonly importance?: number;
}

export interface HumanlikeUser {
  readonly id: string;
  readonly label: string;
  readonly seed: readonly SeedTurn[];
}

/** One held-out A/B option. `correctFor` names the user for whom this option is the
 *  preference-consistent (correct) choice — used to score after order randomization. */
export interface HumanlikeOption {
  readonly text: string;
  readonly correctFor: string; // userId
}

export type HumanlikeFamily = "preference" | "self-spec" | "emotion";

export interface HumanlikeScenario {
  readonly id: string;
  readonly family: HumanlikeFamily;
  /** F1/F3 = 1 user; F2 = 2 opposite-preference users. */
  readonly users: readonly HumanlikeUser[];
  /** held-out situation stem; options appended by the runner with randomized A/B order. */
  readonly situation: string;
  /** exactly 2 options, each correctFor a distinct user. */
  readonly options: readonly [HumanlikeOption, HumanlikeOption];
  /** natural retrieval query the automatic recall would search on. */
  readonly recallQuery: string;
}

/** Which memory a prediction condition sees. */
export type MemoryCondition = "matched" | "mismatched" | "blind";

/** Deterministic trace of one probe under one condition — defined against the
 *  canonical MemoryPort AUTOMATIC recall (FR-MEM-1), NOT a model-emitted marker. */
export interface HumanlikeTrace {
  readonly scenarioId: string;
  readonly targetUserId: string;
  readonly condition: MemoryCondition;
  /** the label (A|B) that was assigned to the target user's correct option this trial. */
  readonly correctLabel: "A" | "B";
  /** parsed model prediction, or null if unparseable. */
  readonly predicted: "A" | "B" | null;
  /** did the automatic recall surface the target's seed? (retrieval vs use split) */
  readonly recallReturnedTarget: boolean;
  /** did formatRecalledMemory produce a non-empty injected block? (blind = false) */
  readonly memoryInjected: boolean;
  /** the raw model response text (for fixture record + exec-error detection). */
  readonly responseText: string;
}

export type HumanlikeOutcome =
  | "correct"
  | "wrong"
  | "unparsed"
  | "exec-error"; // empty/degenerate response = infra failure, NOT a prediction failure

export interface HumanlikeResult {
  readonly trace: HumanlikeTrace;
  readonly outcome: HumanlikeOutcome;
}
