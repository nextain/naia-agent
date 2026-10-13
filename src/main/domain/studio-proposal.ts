// domain — RevisionProposal card state machine (alpha-adk #51 / FE-NS-008,009 / REQ-NS-008,017)

export type ProposalStatus =
  | "draft"
  | "needs_clarification"
  | "preview_ready"
  | "awaiting_approval"
  | "generating"
  | "completed"
  | "failed"
  | "unsupported";

export type ProposalAction =
  | "clarify"
  | "ready_preview"
  | "await_approval"
  | "approve"
  | "complete"
  | "fail"
  | "mark_unsupported"
  | "cancel";

const TRANSITIONS: Record<ProposalStatus, Partial<Record<ProposalAction, ProposalStatus>>> = {
  draft: {
    clarify: "needs_clarification",
    ready_preview: "preview_ready",
    await_approval: "awaiting_approval",
    mark_unsupported: "unsupported",
    cancel: "failed",
  },
  needs_clarification: {
    ready_preview: "preview_ready",
    await_approval: "awaiting_approval",
    mark_unsupported: "unsupported",
    cancel: "failed",
  },
  preview_ready: {
    await_approval: "awaiting_approval",
    cancel: "failed",
  },
  awaiting_approval: {
    approve: "generating",
    mark_unsupported: "unsupported",
    cancel: "failed",
  },
  generating: {
    complete: "completed",
    fail: "failed",
  },
  completed: {},
  failed: {},
  unsupported: {},
};

export interface ClarificationPrompt {
  question: string;
  choices: string[];
}

export interface RevisionProposal {
  id: string;
  status: ProposalStatus;
  title: string;
  range: { startMs: number; endMs: number };
  lyricExcerpt: string;
  userRequest: string;
  aiInterpretation: string;
  impact: string;
  expectedResult: string;
  previewAvailable: boolean;
  baseVersionId: string;
  newVersionId?: string;
  capabilityRequired: Array<"supportsPreview" | "supportsSegmentEdit">;
  correlationId: string;
  /** Present when status is needs_clarification (or after clarify()). */
  clarification?: ClarificationPrompt;
  clarificationAnswer?: string;
}

export class ProposalError extends Error {
  constructor(readonly code: "illegal_transition" | "approve_without_wait" | "invalid") {
    super(code);
    this.name = "ProposalError";
  }
}

export function createProposal(input: Omit<RevisionProposal, "status" | "newVersionId">): RevisionProposal {
  if (!input.id || !input.baseVersionId || !input.correlationId) throw new ProposalError("invalid");
  if (input.range.endMs < input.range.startMs) throw new ProposalError("invalid");
  return { ...input, status: "draft" };
}

export function applyProposalAction(proposal: RevisionProposal, action: ProposalAction): RevisionProposal {
  const next = TRANSITIONS[proposal.status][action];
  if (!next) throw new ProposalError("illegal_transition");
  return { ...proposal, status: next };
}

/**
 * MVP-1: if required capabilities are missing, mark unsupported (or caller may regenerate-all).
 * Does not create a revision job.
 */
export function resolveCapabilityOrUnsupported(
  proposal: RevisionProposal,
  capability: { supportsPreview: boolean; supportsSegmentEdit: boolean },
): RevisionProposal {
  for (const need of proposal.capabilityRequired) {
    if (need === "supportsPreview" && !capability.supportsPreview) {
      return applyProposalAction(proposal, "mark_unsupported");
    }
    if (need === "supportsSegmentEdit" && !capability.supportsSegmentEdit) {
      return applyProposalAction(proposal, "mark_unsupported");
    }
  }
  return proposal;
}

/** Approval is the only path that enters generating. */
export function approveProposal(proposal: RevisionProposal): RevisionProposal {
  if (proposal.status !== "awaiting_approval") throw new ProposalError("approve_without_wait");
  return applyProposalAction(proposal, "approve");
}

/** Enter clarification with a question payload (UC-NS-008). */
export function requestClarification(
  proposal: RevisionProposal,
  clarification: ClarificationPrompt,
): RevisionProposal {
  if (!clarification.question.trim() || clarification.choices.length === 0) {
    throw new ProposalError("invalid");
  }
  const next = applyProposalAction(proposal, "clarify");
  return { ...next, clarification };
}

/** Record the user's answer; stays in needs_clarification until markAwaitingApproval. */
export function answerClarification(proposal: RevisionProposal, answer: string): RevisionProposal {
  if (proposal.status !== "needs_clarification") throw new ProposalError("illegal_transition");
  if (!answer.trim()) throw new ProposalError("invalid");
  if (proposal.clarification && !proposal.clarification.choices.includes(answer)) {
    throw new ProposalError("invalid");
  }
  return { ...proposal, clarificationAnswer: answer };
}
