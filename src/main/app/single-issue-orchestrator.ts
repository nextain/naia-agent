import { createHash, randomUUID } from "node:crypto";
import {
  isIssueTerminal,
  totalIssueCost,
  type ActorReceipt,
  type IssueReport,
  type IssueSnapshot,
  type IssueStartRequest,
} from "../domain/issue-orchestration.js";
import type {
  DevelopmentModeratorPort,
  IssueOrchestrationStore,
  IssueVerifierPort,
  IssueWorkerPort,
  NaiaFacingPort,
  NaiaIssueReporterPort,
} from "../ports/issue-orchestration.js";
import type { DiagnosticLog } from "../ports/uc1.js";

export interface SingleIssueOrchestratorDeps {
  readonly store: IssueOrchestrationStore;
  readonly facing: NaiaFacingPort;
  readonly moderator: DevelopmentModeratorPort;
  readonly worker: IssueWorkerPort;
  readonly verifier: IssueVerifierPort;
  readonly reporter: NaiaIssueReporterPort;
  readonly now?: () => string;
  readonly ids?: () => string;
  readonly diag?: DiagnosticLog;
}

export class IssueRequestConflictError extends Error {}
export class IssueQuestionMismatchError extends Error {}

export class SingleIssueOrchestrator {
  readonly #now: () => string;
  readonly #ids: () => string;

  constructor(private readonly d: SingleIssueOrchestratorDeps) {
    this.#now = d.now ?? (() => new Date().toISOString());
    this.#ids = d.ids ?? randomUUID;
  }

  async start(request: IssueStartRequest, signal: AbortSignal = new AbortController().signal): Promise<IssueReport> {
    validateStart(request);
    const requestDigest = digest(request.text);
    const existing = this.d.store.getByRequestId(request.requestId);
    if (existing && existing.requestDigest !== requestDigest) throw new IssueRequestConflictError("request id was reused with different content");
    const issue = existing ?? this.d.store.create(request, { issueId: this.#ids(), requestDigest, now: this.#now() });
    this.debug("start", { issueId: issue.issueId, state: issue.state, repeated: Boolean(existing) });
    return this.resume(issue.issueId, signal);
  }

  async answer(issueId: string, questionId: string, answer: string, signal: AbortSignal = new AbortController().signal): Promise<IssueReport> {
    const issue = this.required(issueId);
    const pending = issue.plan?.questions.find((question) => question.questionId === questionId);
    if (issue.state !== "awaiting_user" || !pending || !answer.trim()) throw new IssueQuestionMismatchError("answer does not match the pending issue question");
    const updated = this.save(issue, {
      ...issue,
      state: "planning",
      answers: [...issue.answers, { questionId, text: answer }],
      updatedAt: this.#now(),
    }, "question_answered", { questionId });
    return this.resume(updated.issueId, signal);
  }

  cancel(issueId: string): IssueReport {
    const issue = this.required(issueId);
    if (isIssueTerminal(issue.state)) return this.grounded(issue);
    if (["worker_running", "verifying", "reporting"].includes(issue.state)) throw new Error("in-flight issue cancellation requires the worker lifecycle adapter");
    const cancelled = this.save(issue, { ...issue, state: "cancelled", updatedAt: this.#now() }, "issue_cancelled");
    return this.grounded(cancelled);
  }

  async resume(issueId: string, signal: AbortSignal = new AbortController().signal): Promise<IssueReport> {
    let issue = this.required(issueId);
    let dispatchedInThisCall = false;
    for (;;) {
      this.debug("resume-stage", { issueId, state: issue.state });
      if (isIssueTerminal(issue.state)) return this.grounded(issue);
      if (issue.state === "awaiting_user") return this.grounded(issue);

      if (issue.state === "accepted") {
        const result = await this.d.facing.classify({
          requestId: issue.requestId,
          idempotencyKey: `${issue.issueId}:facing:classify`,
          text: issue.originalText,
        });
        assertReceipt(result.receipt, "naia");
        issue = this.save(issue, {
          ...issue,
          state: result.classification.kind === "chat" ? "reporting" : "classified",
          classification: result.classification,
          receipts: appendReceipt(issue.receipts, result.receipt),
          updatedAt: this.#now(),
        }, "request_classified", { kind: result.classification.kind, obligationCount: result.classification.obligations.length });
        if (result.classification.kind === "chat") {
          const report: IssueReport = {
            state: "chat", summary: result.classification.chatReply ?? "", changedFiles: [],
            verificationPassed: null, totalCost: totalIssueCost(issue.receipts),
          };
          issue = this.save(issue, { ...issue, state: "completed", report, updatedAt: this.#now() }, "chat_completed");
          return report;
        }
        continue;
      }

      if (issue.state === "classified") {
        issue = this.save(issue, { ...issue, state: "planning", updatedAt: this.#now() }, "moderator_requested");
        continue;
      }

      if (issue.state === "planning") {
        const result = await this.d.moderator.plan({
          issueId,
          idempotencyKey: `${issue.issueId}:moderator:${issue.answers.length}`,
          originalText: issue.originalText,
          obligations: issue.classification?.obligations ?? [],
          answers: issue.answers,
        });
        assertReceipt(result.receipt, "moderator");
        assertIndependent(issue.receipts, result.receipt);
        const unanswered = result.plan.questions.filter((question) => !issue.answers.some((answer) => answer.questionId === question.questionId));
        const nextState = unanswered.length > 0 ? "awaiting_user" : "dispatch_ready";
        issue = this.save(issue, {
          ...issue,
          state: nextState,
          plan: result.plan,
          dispatchId: nextState === "dispatch_ready" ? issue.dispatchId ?? `${issue.issueId}:dispatch:1` : issue.dispatchId,
          receipts: appendReceipt(issue.receipts, result.receipt),
          updatedAt: this.#now(),
        }, nextState === "awaiting_user" ? "moderator_question" : "plan_ready", {
          questionCount: unanswered.length, profileId: result.plan.workerProfile,
        });
        continue;
      }

      if (issue.state === "dispatch_ready") {
        if (signal.aborted) return this.cancel(issueId);
        issue = this.save(issue, { ...issue, state: "worker_running", updatedAt: this.#now() }, "worker_dispatched", { dispatchId: issue.dispatchId! });
        dispatchedInThisCall = true;
        continue;
      }

      if (issue.state === "worker_running") {
        try {
          const worker = dispatchedInThisCall
            ? await this.d.worker.execute({
              issueId,
              dispatchId: issue.dispatchId!,
              workspacePath: issue.workspacePath,
              task: issue.plan!.workerTask,
              profileId: issue.plan!.workerProfile,
              acceptanceChecks: issue.plan!.acceptanceChecks,
              signal,
            })
            : await this.d.worker.reconcile?.(issue.dispatchId!);
          if (!worker) {
            issue = this.save(issue, { ...issue, state: "outcome_unknown", updatedAt: this.#now() }, "worker_outcome_unknown", { category: "unreconciled_restart" });
            return this.grounded(issue);
          }
          assertReceipt(worker.receipt, "worker");
          assertIndependent(issue.receipts, worker.receipt);
          issue = this.save(issue, {
            ...issue,
            state: worker.ok ? "verifying" : "reporting",
            worker,
            receipts: appendReceipt(issue.receipts, worker.receipt),
            updatedAt: this.#now(),
          }, worker.ok ? "worker_completed" : "worker_failed", { changedFiles: worker.changedFiles.length });
        } catch (error) {
          issue = this.save(issue, { ...issue, state: "outcome_unknown", updatedAt: this.#now() }, "worker_outcome_unknown", { category: errorName(error) });
          return this.grounded(issue);
        }
        continue;
      }

      if (issue.state === "verifying") {
        const verification = await this.d.verifier.verify({
          issueId,
          idempotencyKey: `${issue.issueId}:verify:1`,
          worktreePath: issue.worker!.worktreePath,
          acceptanceChecks: issue.plan!.acceptanceChecks,
        });
        assertReceipt(verification.receipt, "verifier");
        assertIndependent(issue.receipts, verification.receipt);
        issue = this.save(issue, {
          ...issue,
          state: "reporting",
          verification,
          receipts: appendReceipt(issue.receipts, verification.receipt),
          updatedAt: this.#now(),
        }, verification.ok ? "verification_passed" : "verification_failed", { checkCount: verification.checks.length });
        continue;
      }

      if (issue.state === "reporting") {
        const terminal = issue.classification?.kind === "chat" ? "completed"
          : issue.worker?.ok !== true || issue.verification?.ok !== true ? "failed" : "completed";
        const result = await this.d.reporter.report({
          issue: { ...issue, state: terminal }, events: this.d.store.events(issueId),
          idempotencyKey: `${issue.issueId}:report:1`,
        });
        assertReceipt(result.receipt, "reporter");
        assertIndependent(issue.receipts, result.receipt);
        const receipts = appendReceipt(issue.receipts, result.receipt);
        const report: IssueReport = { ...result.report, issueId, state: terminal, totalCost: totalIssueCost(receipts) };
        issue = this.save(issue, { ...issue, state: terminal, report, receipts, updatedAt: this.#now() }, "issue_reported", { terminal });
        return report;
      }

      throw new Error(`unsupported issue state: ${issue.state}`);
    }
  }

  snapshot(issueId: string): IssueSnapshot { return this.required(issueId); }

  private required(issueId: string): IssueSnapshot {
    const issue = this.d.store.get(issueId);
    if (!issue) throw new Error(`unknown issue: ${issueId}`);
    return issue;
  }

  private save(previous: IssueSnapshot, next: IssueSnapshot, eventType: string, payload: Readonly<Record<string, unknown>> = {}): IssueSnapshot {
    return this.d.store.save({ expectedVersion: previous.version, snapshot: next, eventType, payload });
  }

  private grounded(issue: IssueSnapshot): IssueReport {
    if (issue.report) return issue.report;
    const question = issue.state === "awaiting_user"
      ? issue.plan?.questions.find((candidate) => !issue.answers.some((answer) => answer.questionId === candidate.questionId))
      : undefined;
    return {
      state: issue.state === "awaiting_user" ? "awaiting_user" : issue.state as "failed" | "cancelled" | "outcome_unknown",
      summary: question?.text ?? issue.worker?.summary ?? issue.state,
      issueId: issue.issueId,
      ...(question ? { question } : {}),
      changedFiles: issue.worker?.changedFiles ?? [],
      verificationPassed: issue.verification?.ok ?? null,
      totalCost: totalIssueCost(issue.receipts),
    };
  }

  private debug(stage: string, context: Readonly<Record<string, unknown>>): void {
    this.d.diag?.debug?.(`[SingleIssueOrchestrator] ${stage}`, { at: this.#now(), ...context });
  }
}

function validateStart(request: IssueStartRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.requestId)) throw new Error("invalid request id");
  if (!request.text.trim()) throw new Error("request text is required");
  if (!request.workspacePath.trim()) throw new Error("workspace path is required");
}

function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function errorName(error: unknown): string { return error instanceof Error ? error.name : "unknown"; }

function assertReceipt(receipt: ActorReceipt, role: ActorReceipt["role"]): void {
  if (receipt.role !== role || !receipt.sessionId || !receipt.executionId || !receipt.idempotencyKey) throw new Error(`invalid ${role} receipt`);
  for (const value of [receipt.inputTokens, receipt.cachedInputTokens, receipt.outputTokens, receipt.latencyMs]) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${role} receipt accounting`);
  }
}

function assertIndependent(receipts: readonly ActorReceipt[], next: ActorReceipt): void {
  if (receipts.some((receipt) => receipt.sessionId === next.sessionId || receipt.executionId === next.executionId)) {
    throw new Error(`actor identity collision for ${next.role}`);
  }
}

function appendReceipt(receipts: readonly ActorReceipt[], next: ActorReceipt): readonly ActorReceipt[] {
  const prior = receipts.find((receipt) => receipt.idempotencyKey === next.idempotencyKey);
  if (!prior) return [...receipts, next];
  if (JSON.stringify(prior) !== JSON.stringify(next)) throw new Error("idempotency receipt mismatch");
  return receipts;
}
