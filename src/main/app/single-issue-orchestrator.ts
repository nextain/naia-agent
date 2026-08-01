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
import { IssueActorResultError } from "../ports/issue-orchestration.js";
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
  readonly ownerIds?: () => string;
  readonly clockMs?: () => number;
  readonly executionLeaseMs?: number;
  readonly executionPollMs?: number;
  readonly diag?: DiagnosticLog;
}

export class IssueRequestConflictError extends Error {}
export class IssueQuestionMismatchError extends Error {}

export class SingleIssueOrchestrator {
  readonly #now: () => string;
  readonly #ids: () => string;
  readonly #ownerIds: () => string;
  readonly #clockMs: () => number;
  readonly #executionLeaseMs: number;
  readonly #executionPollMs: number;
  readonly #executionOwners = new Map<string, string>();
  readonly #executionControllers = new Map<string, AbortController>();
  readonly #activeStarts = new Map<string, { readonly requestDigest: string; readonly run: Promise<IssueReport> }>();

  constructor(private readonly d: SingleIssueOrchestratorDeps) {
    this.#now = d.now ?? (() => new Date().toISOString());
    this.#ids = d.ids ?? randomUUID;
    this.#ownerIds = d.ownerIds ?? randomUUID;
    this.#clockMs = d.clockMs ?? Date.now;
    this.#executionLeaseMs = d.executionLeaseMs ?? 30_000;
    this.#executionPollMs = d.executionPollMs ?? 25;
  }

  async start(request: IssueStartRequest, signal: AbortSignal = new AbortController().signal): Promise<IssueReport> {
    validateStart(request);
    const requestDigest = digest(requestFingerprint(request));
    const active = this.#activeStarts.get(request.requestId);
    if (active) {
      if (active.requestDigest !== requestDigest) throw new IssueRequestConflictError("request id was reused with different content");
      return active.run;
    }
    const run = this.startOnce(request, requestDigest, signal);
    this.#activeStarts.set(request.requestId, { requestDigest, run });
    try {
      return await run;
    } finally {
      if (this.#activeStarts.get(request.requestId)?.run === run) this.#activeStarts.delete(request.requestId);
    }
  }

  private async startOnce(request: IssueStartRequest, requestDigest: string, signal: AbortSignal): Promise<IssueReport> {
    const established = this.d.store.createOrGet(request, { issueId: this.#ids(), requestDigest, now: this.#now() });
    const issue = established.snapshot;
    if (issue.requestDigest !== requestDigest) throw new IssueRequestConflictError("request id was reused with different content");
    this.debug("start", { issueId: issue.issueId, state: issue.state, repeated: !established.created });
    return this.resume(issue.issueId, signal);
  }

  async answer(issueId: string, questionId: string, answer: string, signal: AbortSignal = new AbortController().signal): Promise<IssueReport> {
    return this.withExecutionClaim(issueId, signal, async (executionSignal) => {
      const issue = this.required(issueId);
      const pending = issue.plan?.questions.find((question) => !issue.answers.some((prior) => prior.questionId === question.questionId));
      if (issue.state !== "awaiting_user" || pending?.questionId !== questionId || !answer.trim()) throw new IssueQuestionMismatchError("answer does not match the pending issue question");
      const updated = this.save(issue, {
        ...issue,
        state: "planning",
        answers: [...issue.answers, { questionId, text: answer }],
        updatedAt: this.#now(),
      }, "question_answered", { questionId });
      return this.runStages(updated.issueId, executionSignal);
    }, false);
  }

  async cancel(issueId: string, signal: AbortSignal = new AbortController().signal): Promise<IssueReport> {
    const issue = this.required(issueId);
    if (isIssueTerminal(issue.state)) return this.grounded(issue);
    const requested = this.d.store.requestCancellation(issueId, this.#now());
    this.#executionControllers.get(issueId)?.abort(new Error("issue cancellation requested"));
    if (isIssueTerminal(requested.state)) return this.grounded(requested);
    return this.resume(issueId, signal);
  }

  async resume(issueId: string, signal: AbortSignal = new AbortController().signal): Promise<IssueReport> {
    return this.withExecutionClaim(issueId, signal, (executionSignal) => this.runStages(issueId, executionSignal));
  }

  private async runStages(issueId: string, signal: AbortSignal): Promise<IssueReport> {
    let issue = this.required(issueId);
    let facingDispatchedInThisCall = false;
    let moderatorDispatchedInThisCall = false;
    let dispatchedInThisCall = false;
    let verifierDispatchedInThisCall = false;
    let reporterDispatchedInThisCall = false;
    for (;;) {
      this.debug("resume-stage", { issueId, state: issue.state });
      if (isIssueTerminal(issue.state)) return this.grounded(issue);
      if (issue.cancellationRequestedAt) {
        const actorWasInFlight = ["classifying", "moderator_running"].includes(issue.state);
        return this.terminalizeCancellation(issue, actorWasInFlight);
      }
      if (issue.state === "awaiting_user") return this.grounded(issue);

      if (issue.state === "accepted") {
        issue = this.save(issue, { ...issue, state: "classifying", updatedAt: this.#now() }, "facing_dispatched");
        facingDispatchedInThisCall = true;
        continue;
      }

      if (issue.state === "classifying") {
        if (!facingDispatchedInThisCall) return this.markUnknown(issue, "unreconciled_facing_restart");
        const key = `${issue.issueId}:facing:classify`;
        let result: Awaited<ReturnType<NaiaFacingPort["classify"]>> | undefined;
        try {
          result = await this.d.facing.classify({ requestId: issue.requestId, idempotencyKey: key, text: issue.originalText, signal });
          assertReceipt(result.receipt, "naia", key, issue.naiaBinding);
        } catch (error) {
          const cancelled = this.cancelAfterActor(issueId, "naia", key, issue.naiaBinding, error instanceof IssueActorResultError ? error.receipt : result?.receipt);
          return cancelled ?? this.actorFailure(issue, "naia", key, issue.naiaBinding, error, result?.receipt);
        }
        const cancelled = this.cancelAfterActor(issueId, "naia", key, issue.naiaBinding, result?.receipt);
        if (cancelled) return cancelled;
        if (!result) return this.markUnknown(issue, "facing_result_unavailable");
        if (result.classification.kind === "chat") {
          const receipts = appendReceipt(issue.receipts, result.receipt);
          const report: IssueReport = {
            state: "chat", summary: result.classification.chatReply ?? "", changedFiles: [],
            verificationPassed: null, totalCost: totalIssueCost(receipts),
          };
          issue = this.save(issue, {
            ...issue, state: "completed", classification: result.classification, receipts, report, updatedAt: this.#now(),
          }, "chat_completed", { kind: "chat", obligationCount: 0 });
          return report;
        }
        issue = this.save(issue, {
          ...issue,
          state: "classified",
          classification: result.classification,
          receipts: appendReceipt(issue.receipts, result.receipt),
          updatedAt: this.#now(),
        }, "request_classified", { kind: result.classification.kind, obligationCount: result.classification.obligations.length });
        continue;
      }

      if (issue.state === "classified") {
        issue = this.save(issue, { ...issue, state: "planning", updatedAt: this.#now() }, "moderator_requested");
        continue;
      }

      if (issue.state === "planning") {
        issue = this.save(issue, { ...issue, state: "moderator_running", updatedAt: this.#now() }, "moderator_dispatched");
        moderatorDispatchedInThisCall = true;
        continue;
      }

      if (issue.state === "moderator_running") {
        if (!moderatorDispatchedInThisCall) return this.markUnknown(issue, "unreconciled_moderator_restart");
        const key = `${issue.issueId}:moderator:${issue.answers.length}`;
        let result: Awaited<ReturnType<DevelopmentModeratorPort["plan"]>> | undefined;
        try {
          result = await this.d.moderator.plan({
            issueId, idempotencyKey: key, originalText: issue.originalText,
            obligations: issue.classification?.obligations ?? [], answers: issue.answers,
            signal,
          });
          assertReceipt(result.receipt, "moderator", key, issue.moderatorBinding);
          assertIndependent(issue.receipts, result.receipt);
        } catch (error) {
          const cancelled = this.cancelAfterActor(issueId, "moderator", key, issue.moderatorBinding, error instanceof IssueActorResultError ? error.receipt : result?.receipt);
          return cancelled ?? this.actorFailure(issue, "moderator", key, issue.moderatorBinding, error, result?.receipt);
        }
        const cancelled = this.cancelAfterActor(issueId, "moderator", key, issue.moderatorBinding, result?.receipt);
        if (cancelled) return cancelled;
        if (!result) return this.markUnknown(issue, "moderator_result_unavailable");
        const moderatorReceipts = appendReceipt(issue.receipts, result.receipt);
        try { assertPlan(result.plan); } catch (error) {
          issue = this.save(issue, {
            ...issue, state: "failed", plan: result.plan, receipts: moderatorReceipts, updatedAt: this.#now(),
          }, "moderator_plan_rejected", { category: errorName(error) });
          return this.grounded(issue);
        }
        const workerBinding = issue.workerProfiles[result.plan.workerProfile];
        if (!workerBinding) {
          issue = this.save(issue, {
            ...issue, state: "failed", plan: result.plan, receipts: moderatorReceipts, updatedAt: this.#now(),
          }, "moderator_profile_rejected", { profileId: result.plan.workerProfile });
          return this.grounded(issue);
        }
        const unanswered = result.plan.questions.filter((question) => !issue.answers.some((answer) => answer.questionId === question.questionId));
        const nextState = unanswered.length > 0 ? "awaiting_user" : "dispatch_ready";
        issue = this.save(issue, {
          ...issue,
          state: nextState,
          plan: result.plan,
          workerBinding,
          dispatchId: nextState === "dispatch_ready" ? issue.dispatchId ?? `${issue.issueId}:dispatch:1` : issue.dispatchId,
          receipts: moderatorReceipts,
          updatedAt: this.#now(),
        }, nextState === "awaiting_user" ? "moderator_question" : "plan_ready", {
          questionCount: unanswered.length, profileId: result.plan.workerProfile,
        });
        continue;
      }

      if (issue.state === "dispatch_ready") {
        if (signal.aborted) {
          issue = this.d.store.requestCancellation(issueId, this.#now());
          return this.terminalizeCancellation(issue, false);
        }
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
              binding: issue.workerBinding!,
              acceptanceChecks: issue.plan!.acceptanceChecks,
              signal,
            })
            : await this.d.worker.reconcile?.(issue.dispatchId!);
          if (!worker) {
            issue = this.save(issue, { ...issue, state: "outcome_unknown", updatedAt: this.#now() }, "worker_outcome_unknown", { category: "unreconciled_restart" });
            return this.grounded(issue);
          }
          assertReceipt(worker.receipt, "worker", issue.dispatchId!, issue.workerBinding);
          assertIndependent(issue.receipts, worker.receipt);
          issue = this.save(issue, {
            ...issue,
            state: worker.ok ? "verifying" : "reporting",
            worker,
            receipts: appendReceipt(issue.receipts, worker.receipt),
            updatedAt: this.#now(),
          }, worker.ok ? "worker_completed" : "worker_failed", { changedFiles: worker.changedFiles.length });
          verifierDispatchedInThisCall = worker.ok;
        } catch (error) {
          if (error instanceof IssueActorResultError) {
            try {
              assertReceipt(error.receipt, "worker", issue.dispatchId!);
              assertIndependent(issue.receipts, error.receipt);
            } catch { return this.markUnknown(issue, "worker_rejected_receipt_invalid"); }
            issue = this.save(issue, {
              ...issue, state: "failed", receipts: appendReceipt(issue.receipts, error.receipt), updatedAt: this.#now(),
            }, "actor_result_rejected", { role: "worker", category: errorName(error) });
            return this.grounded(issue);
          }
          issue = this.save(issue, { ...issue, state: "outcome_unknown", updatedAt: this.#now() }, "worker_outcome_unknown", { category: errorName(error) });
          return this.grounded(issue);
        }
        continue;
      }

      if (issue.state === "verifying") {
        if (!verifierDispatchedInThisCall) return this.markUnknown(issue, "unreconciled_verifier_restart");
        try {
          const verification = await this.d.verifier.verify({
            issueId,
            idempotencyKey: `${issue.issueId}:verify:1`,
            worktreePath: issue.worker!.worktreePath,
            acceptanceChecks: issue.plan!.acceptanceChecks,
            signal,
          });
          assertReceipt(verification.receipt, "verifier", `${issue.issueId}:verify:1`);
          assertIndependent(issue.receipts, verification.receipt);
          issue = this.save(issue, {
            ...issue,
            state: "reporting",
            verification,
            receipts: appendReceipt(issue.receipts, verification.receipt),
            updatedAt: this.#now(),
          }, verification.ok ? "verification_passed" : "verification_failed", { checkCount: verification.checks.length });
        } catch (error) {
          return this.markUnknown(issue, `verifier_call_or_receipt_unavailable:${errorName(error)}`);
        }
        continue;
      }

      if (issue.state === "reporting") {
        issue = this.save(issue, { ...issue, state: "reporter_running", updatedAt: this.#now() }, "reporter_dispatched");
        reporterDispatchedInThisCall = true;
        continue;
      }

      if (issue.state === "reporter_running") {
        if (!reporterDispatchedInThisCall) return this.markUnknown(issue, "unreconciled_reporter_restart");
        const terminal = issue.classification?.kind === "chat" ? "completed"
          : issue.worker?.ok !== true || issue.verification?.ok !== true ? "failed" : "completed";
        const key = `${issue.issueId}:report:1`;
        let result: Awaited<ReturnType<NaiaIssueReporterPort["report"]>> | undefined;
        try {
          result = await this.d.reporter.report({
            issue: { ...issue, state: terminal }, events: this.d.store.events(issueId), idempotencyKey: key, signal,
          });
          assertReceipt(result.receipt, "reporter", key, issue.naiaBinding);
          assertIndependent(issue.receipts, result.receipt);
        } catch (error) { return this.actorFailure(issue, "reporter", key, issue.naiaBinding, error, result?.receipt); }
        if (!result) return this.markUnknown(issue, "reporter_result_unavailable");
        const receipts = appendReceipt(issue.receipts, result.receipt);
        const report: IssueReport = {
          issueId,
          state: terminal,
          summary: groundedSummary(issue, terminal),
          ...(result.report.summary.trim() ? { naiaCommentary: result.report.summary.trim() } : {}),
          changedFiles: issue.worker?.changedFiles ?? [],
          verificationPassed: issue.verification?.ok ?? null,
          totalCost: totalIssueCost(receipts),
        };
        issue = this.save(issue, { ...issue, state: terminal, report, receipts, updatedAt: this.#now() }, "issue_reported", { terminal });
        return report;
      }

      throw new Error(`unsupported issue state: ${issue.state}`);
    }
  }

  snapshot(issueId: string): IssueSnapshot { return this.required(issueId); }

  private async withExecutionClaim(issueId: string, signal: AbortSignal, operation: (executionSignal: AbortSignal) => Promise<IssueReport>, stopAtAwaiting = true): Promise<IssueReport> {
    const ownerId = this.#ownerIds();
    for (;;) {
      const current = this.required(issueId);
      if (isIssueTerminal(current.state)
        || (stopAtAwaiting && current.state === "awaiting_user" && !current.cancellationRequestedAt)) return this.grounded(current);
      const nowMs = this.#clockMs();
      if (this.d.store.tryAcquireExecution(issueId, ownerId, nowMs, nowMs + this.#executionLeaseMs)) break;
      await waitForExecution(this.#executionPollMs, signal);
    }
    const controller = new AbortController();
    const executionSignal = AbortSignal.any([signal, controller.signal]);
    let claimLost = false;
    const heartbeat = setInterval(() => {
      try {
        if (!this.d.store.renewExecution(issueId, ownerId, this.#clockMs() + this.#executionLeaseMs)) {
          claimLost = true;
          controller.abort(new Error("issue execution claim lost"));
          return;
        }
        if (this.d.store.get(issueId)?.cancellationRequestedAt) controller.abort(new Error("issue cancellation requested"));
      } catch (error) {
        this.debug("execution-lease-renewal-failed", { issueId, category: errorName(error) });
      }
    }, Math.max(25, Math.min(500, Math.floor(this.#executionLeaseMs / 3))));
    heartbeat.unref?.();
    this.#executionOwners.set(issueId, ownerId);
    this.#executionControllers.set(issueId, controller);
    try {
      const report = await operation(executionSignal);
      if (!claimLost) return report;
    } catch (error) {
      if (!claimLost) throw error;
    } finally {
      clearInterval(heartbeat);
      if (this.#executionOwners.get(issueId) === ownerId) this.#executionOwners.delete(issueId);
      if (this.#executionControllers.get(issueId) === controller) this.#executionControllers.delete(issueId);
      this.d.store.releaseExecution(issueId, ownerId);
    }
    return this.resume(issueId, signal);
  }

  private required(issueId: string): IssueSnapshot {
    const issue = this.d.store.get(issueId);
    if (!issue) throw new Error(`unknown issue: ${issueId}`);
    return issue;
  }

  private save(previous: IssueSnapshot, next: IssueSnapshot, eventType: string, payload: Readonly<Record<string, unknown>> = {}): IssueSnapshot {
    const executionOwnerId = this.#executionOwners.get(previous.issueId);
    return this.d.store.save({
      expectedVersion: previous.version, snapshot: next, eventType, payload,
      ...(executionOwnerId ? { executionOwnerId, executionNowMs: this.#clockMs() } : {}),
    });
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
      totalCost: issue.state === "outcome_unknown"
        ? { state: "unavailable", reason: "an in-flight actor outcome or cost could not be reconciled" }
        : totalIssueCost(issue.receipts),
    };
  }

  private markUnknown(issue: IssueSnapshot, category: string): IssueReport {
    return this.grounded(this.save(issue, { ...issue, state: "outcome_unknown", updatedAt: this.#now() }, "actor_outcome_unknown", { category }));
  }

  private actorFailure(issue: IssueSnapshot, role: ActorReceipt["role"], key: string, binding: { provider: string; model: string; reasoningEffort?: string }, error: unknown, candidate?: ActorReceipt): IssueReport {
    const receipt = error instanceof IssueActorResultError ? error.receipt : candidate;
    try {
      if (!receipt) throw new Error("receipt unavailable");
      assertReceipt(receipt, role, key, binding);
      assertIndependent(issue.receipts, receipt);
      const failed = this.save(issue, {
        ...issue, state: "failed", receipts: appendReceipt(issue.receipts, receipt), updatedAt: this.#now(),
      }, "actor_result_rejected", { role, category: errorName(error) });
      return this.grounded(failed);
    } catch {
      return this.markUnknown(issue, `${role}_call_or_receipt_unavailable`);
    }
  }

  private cancelAfterActor(issueId: string, role: ActorReceipt["role"], key: string, binding: { provider: string; model: string; reasoningEffort?: string }, candidate?: ActorReceipt): IssueReport | undefined {
    const latest = this.required(issueId);
    if (!latest.cancellationRequestedAt) return undefined;
    if (!candidate) return this.terminalizeCancellation(latest, true);
    try {
      assertReceipt(candidate, role, key, binding);
      assertIndependent(latest.receipts, candidate);
      return this.terminalizeCancellation({ ...latest, receipts: appendReceipt(latest.receipts, candidate) }, false);
    } catch {
      return this.terminalizeCancellation(latest, true);
    }
  }

  private terminalizeCancellation(issue: IssueSnapshot, costIncomplete: boolean): IssueReport {
    const totalCost = costIncomplete
      ? { state: "unavailable" as const, reason: "cancelled while an actor outcome or cost was in flight" }
      : totalIssueCost(issue.receipts);
    const report: IssueReport = {
      issueId: issue.issueId, state: "cancelled", summary: "cancelled",
      changedFiles: issue.worker?.changedFiles ?? [], verificationPassed: issue.verification?.ok ?? null, totalCost,
    };
    const cancelled = this.save(issue, { ...issue, state: "cancelled", report, updatedAt: this.#now() }, "issue_cancelled");
    return this.grounded(cancelled);
  }

  private debug(stage: string, context: Readonly<Record<string, unknown>>): void {
    this.d.diag?.debug?.(`[SingleIssueOrchestrator] ${stage}`, { at: this.#now(), ...context });
  }
}

function validateStart(request: IssueStartRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.requestId)) throw new Error("invalid request id");
  if (!request.text.trim()) throw new Error("request text is required");
  if (!request.workspacePath.trim()) throw new Error("workspace path is required");
  if (!validBinding(request.naiaBinding) || !validBinding(request.moderatorBinding)) {
    throw new Error("invalid facing or moderator binding");
  }
  const profiles = Object.entries(request.workerProfiles);
  if (profiles.length === 0) throw new Error("at least one worker profile is required");
  for (const [profileId, binding] of profiles) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileId) || !validBinding(binding)) {
      throw new Error("invalid worker profile binding");
    }
  }
}

function validBinding(binding: { provider: string; model: string; reasoningEffort?: string }): boolean {
  const concrete = (value: string) => value.length > 0 && value === value.trim() && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);
  return concrete(binding.provider) && concrete(binding.model)
    && (binding.reasoningEffort === undefined || ["low", "medium", "high", "xhigh"].includes(binding.reasoningEffort));
}

function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function errorName(error: unknown): string { return error instanceof Error ? error.name : "unknown"; }

function requestFingerprint(request: IssueStartRequest): string {
  const binding = (value: { provider: string; model: string; reasoningEffort?: string }) => ({
    provider: value.provider, model: value.model, reasoningEffort: value.reasoningEffort ?? null,
  });
  return JSON.stringify({
    text: request.text,
    workspacePath: request.workspacePath,
    naiaBinding: binding(request.naiaBinding),
    moderatorBinding: binding(request.moderatorBinding),
    workerProfiles: Object.fromEntries(Object.entries(request.workerProfiles).sort(([left], [right]) => left.localeCompare(right))
      .map(([profileId, value]) => [profileId, binding(value)])),
  });
}

function groundedSummary(issue: IssueSnapshot, terminal: "completed" | "failed"): string {
  const files = issue.worker?.changedFiles.length ?? 0;
  const verification = issue.verification?.ok === true ? "passed" : issue.verification?.ok === false ? "failed" : "not-run";
  return `state=${terminal}; changedFiles=${files}; verification=${verification}`;
}

function assertReceipt(receipt: ActorReceipt, role: ActorReceipt["role"], expectedKey: string, binding?: { provider: string; model: string; reasoningEffort?: string }): void {
  if (receipt.role !== role || !receipt.sessionId || !receipt.executionId || receipt.idempotencyKey !== expectedKey) throw new Error(`invalid ${role} receipt`);
  if (binding && (receipt.provider !== binding.provider || receipt.model !== binding.model)) throw new Error(`invalid ${role} binding receipt`);
  if (binding?.reasoningEffort && receipt.reasoningEffort !== binding.reasoningEffort) throw new Error(`invalid ${role} reasoning receipt`);
  for (const value of [receipt.inputTokens, receipt.cachedInputTokens, receipt.outputTokens]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${role} receipt accounting`);
  }
  if (!Number.isFinite(receipt.latencyMs) || receipt.latencyMs < 0 || receipt.cachedInputTokens > receipt.inputTokens) throw new Error(`invalid ${role} receipt accounting`);
  if (!receipt.tokenCountsAvailable && (receipt.inputTokens !== 0 || receipt.cachedInputTokens !== 0 || receipt.outputTokens !== 0 || receipt.cost.state === "measured")) {
    throw new Error(`invalid ${role} unavailable usage receipt`);
  }
  if (receipt.cost.state === "measured" && (!Number.isFinite(receipt.cost.usd) || receipt.cost.usd < 0 || !receipt.cost.source.trim())) {
    throw new Error(`invalid ${role} measured cost receipt`);
  }
  if (receipt.cost.state === "unavailable" && !receipt.cost.reason.trim()) throw new Error(`invalid ${role} unavailable cost receipt`);
}

function assertPlan(plan: import("../domain/issue-orchestration.js").ModeratorPlan): void {
  if (!plan.workerTask.trim() || !plan.workerProfile.trim() || plan.acceptanceChecks.length === 0
    || plan.acceptanceChecks.some((check) => !check.trim())) throw new Error("invalid moderator plan");
  const questionIds = plan.questions.map((question) => question.questionId);
  if (plan.questions.some((question) => !question.questionId.trim() || !question.text.trim()) || new Set(questionIds).size !== questionIds.length) {
    throw new Error("invalid moderator questions");
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

function waitForExecution(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("execution wait aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void { signal.removeEventListener("abort", aborted); resolve(); }
    function aborted(): void { clearTimeout(timer); reject(signal.reason ?? new Error("execution wait aborted")); }
    signal.addEventListener("abort", aborted, { once: true });
  });
}
