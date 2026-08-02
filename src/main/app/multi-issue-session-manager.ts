import { randomUUID } from "node:crypto";
import type { IssueReport } from "../domain/issue-orchestration.js";
import { emptySessionCounts, isManagedSessionTerminal, type ManagedIssueSession, type MultiIssuePortfolio, type MultiIssueSubmission } from "../domain/multi-issue-session.js";
import type { MultiIssueSessionCommands, MultiIssueSessionQueries, MultiIssueSessionStore, SingleIssueExecutionPort } from "../ports/multi-issue-session.js";
import type { DiagnosticLog } from "../ports/uc1.js";

export interface MultiIssueSessionManagerDeps {
  readonly store: MultiIssueSessionStore;
  readonly issues: SingleIssueExecutionPort;
  readonly concurrency: number;
  readonly aggregateThresholdUsd?: number;
  readonly schedulerLeaseMs?: number;
  readonly ids?: () => string;
  readonly ownerIds?: () => string;
  readonly now?: () => string;
  readonly clockMs?: () => number;
  readonly autoPump?: boolean;
  readonly diag?: DiagnosticLog;
}

export class MultiIssueSessionManager implements MultiIssueSessionCommands, MultiIssueSessionQueries {
  readonly #ids: () => string;
  readonly #ownerId: string;
  readonly #now: () => string;
  readonly #clockMs: () => number;
  readonly #leaseMs: number;
  readonly #autoPump: boolean;
  #activePump?: Promise<void>;
  #pumpRequested = false;

  constructor(private readonly d: MultiIssueSessionManagerDeps) {
    if (!Number.isSafeInteger(d.concurrency) || d.concurrency <= 0) throw new Error("concurrency must be a positive integer");
    if (d.aggregateThresholdUsd !== undefined && (!Number.isFinite(d.aggregateThresholdUsd) || d.aggregateThresholdUsd < 0)) {
      throw new Error("aggregate threshold must be a non-negative finite amount");
    }
    this.#ids = d.ids ?? randomUUID;
    this.#ownerId = (d.ownerIds ?? randomUUID)();
    this.#now = d.now ?? (() => new Date().toISOString());
    this.#clockMs = d.clockMs ?? Date.now;
    this.#leaseMs = d.schedulerLeaseMs ?? 30_000;
    this.#autoPump = d.autoPump ?? true;
    if (!Number.isFinite(this.#leaseMs) || this.#leaseMs < 100) throw new Error("scheduler lease must be at least 100ms");
  }

  async submit(input: MultiIssueSubmission): Promise<ManagedIssueSession> {
    validateSubmission(input);
    const issue = await this.d.issues.ensure(input.request);
    const established = this.d.store.createOrGet({ submission: input, issue, sessionId: this.#ids(), now: this.#now() });
    this.debug("submit", { sessionId: established.snapshot.sessionId, issueId: issue.issueId, repeated: !established.created });
    this.triggerPump();
    return established.snapshot;
  }

  async answer(sessionId: string, questionId: string, answer: string): Promise<ManagedIssueSession> {
    const queued = this.d.store.queueAnswer(sessionId, { questionId, text: answer }, this.#now());
    this.debug("answer-queued", { sessionId, questionId });
    this.triggerPump();
    return queued;
  }

  async cancel(sessionId: string): Promise<ManagedIssueSession> {
    const requested = this.d.store.requestCancellation(sessionId, this.#now());
    this.debug("cancel-requested", { sessionId, state: requested.state });
    if (requested.state === "running") {
      void this.d.issues.cancel(requested.issueId).catch((error: unknown) => {
        this.debug("cancel-signal-failed", { sessionId, category: errorName(error) });
      });
    }
    this.triggerPump();
    return requested;
  }

  get(sessionId: string): ManagedIssueSession {
    const session = this.d.store.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    return session;
  }

  list(): readonly ManagedIssueSession[] { return this.d.store.list(); }

  portfolio(): MultiIssuePortfolio {
    const sessions = this.list();
    const counts = emptySessionCounts();
    let measured = 0;
    let unavailableReason: string | undefined;
    let activeReservationsUsd = 0;
    let settledMeasuredUsd = 0;
    let budgetEvidenceUnavailable = false;
    for (const session of sessions) {
      counts[session.state] += 1;
      if (session.state === "running") activeReservationsUsd += session.reservationUsd ?? 0;
      if (!isManagedSessionTerminal(session.state)) unavailableReason ??= `session ${session.sessionId} is ${session.state}`;
      else if (!session.report || session.report.totalCost.state === "unavailable") {
        budgetEvidenceUnavailable = true;
        unavailableReason ??= session.report?.totalCost.state === "unavailable"
          ? `session ${session.sessionId}: ${session.report.totalCost.reason}`
          : `session ${session.sessionId} has no cost evidence`;
      } else {
        measured += session.report.totalCost.usd;
        settledMeasuredUsd += session.report.totalCost.usd;
      }
    }
    const threshold = this.d.aggregateThresholdUsd;
    const nextReady = sessions.filter((session) => session.state === "queued")
      .sort((left, right) => (left.readyPriority === "recovery" ? 0 : 1) - (right.readyPriority === "recovery" ? 0 : 1)
        || left.readySequence - right.readySequence)[0];
    const runningReservationMissing = sessions.some((session) => session.state === "running" && session.reservationUsd === undefined);
    const nextReservation = nextReady?.reservationUsd;
    const budgetBlocked = threshold !== undefined && nextReady !== undefined
      && (budgetEvidenceUnavailable || runningReservationMissing || nextReservation === undefined
        || settledMeasuredUsd + activeReservationsUsd + nextReservation > threshold);
    return {
      sessions,
      counts,
      totalCost: unavailableReason
        ? { state: "unavailable", reason: unavailableReason }
        : { state: "measured", usd: measured, source: "sum_of_managed_session_reports" },
      activeReservationsUsd,
      budgetBlocked,
    };
  }

  pump(): Promise<void> {
    if (this.#activePump) {
      this.#pumpRequested = true;
      return this.#activePump;
    }
    const running = this.runPump();
    this.#activePump = running;
    void running.then(
      () => this.finishPump(running),
      () => this.finishPump(running),
    );
    return running;
  }

  private finishPump(running: Promise<void>): void {
    if (this.#activePump !== running) return;
    this.#activePump = undefined;
    if (!this.#pumpRequested) return;
    this.#pumpRequested = false;
    void this.pump().catch((error: unknown) => this.debug("pump-failed", { category: errorName(error) }));
  }

  private async runPump(): Promise<void> {
    const acquiredAt = this.#clockMs();
    if (!this.d.store.tryAcquireScheduler(this.#ownerId, acquiredAt, acquiredAt + this.#leaseMs)) {
      this.debug("scheduler-busy", {});
      return;
    }
    let claimLost = false;
    const controllers = new Set<AbortController>();
    const heartbeat = setInterval(() => {
      try {
        const at = this.#clockMs();
        if (!this.d.store.renewScheduler(this.#ownerId, at, at + this.#leaseMs)) {
          claimLost = true;
          for (const controller of controllers) controller.abort(new Error("scheduler lease lost"));
        }
      } catch (error) {
        claimLost = true;
        this.debug("scheduler-renewal-failed", { category: errorName(error) });
        for (const controller of controllers) controller.abort(new Error("scheduler lease renewal failed"));
      }
    }, Math.max(25, Math.min(500, Math.floor(this.#leaseMs / 3))));
    heartbeat.unref?.();
    try {
      this.d.store.recoverRunning(this.#ownerId, this.#clockMs(), this.#now());
      const active = new Set<Promise<void>>();
      while (!claimLost) {
        const claimed = this.d.store.claimReady({
          ownerId: this.#ownerId,
          nowMs: this.#clockMs(),
          now: this.#now(),
          limit: this.d.concurrency,
          ...(this.d.aggregateThresholdUsd === undefined ? {} : { aggregateThresholdUsd: this.d.aggregateThresholdUsd }),
        });
        for (const session of claimed) {
          const controller = new AbortController();
          controllers.add(controller);
          const execution = this.executeSession(session, controller.signal)
            .finally(() => { controllers.delete(controller); active.delete(execution); });
          active.add(execution);
        }
        if (active.size === 0) return;
        await Promise.race(active);
      }
    } finally {
      clearInterval(heartbeat);
      this.d.store.releaseScheduler(this.#ownerId);
    }
  }

  private async executeSession(session: ManagedIssueSession, signal: AbortSignal): Promise<void> {
    let report: IssueReport;
    try {
      const latest = this.get(session.sessionId);
      report = latest.cancellationRequested
        ? await this.d.issues.cancel(latest.issueId, signal)
        : latest.pendingAnswer
          ? await this.d.issues.answer(latest.issueId, latest.pendingAnswer.questionId, latest.pendingAnswer.text, signal)
          : await this.d.issues.resume(latest.issueId, signal);
    } catch (error) {
      report = {
        state: "outcome_unknown",
        summary: "single-issue execution could not be reconciled",
        issueId: session.issueId,
        changedFiles: [],
        verificationPassed: null,
        totalCost: { state: "unavailable", reason: `single-issue port error: ${errorName(error)}` },
      };
    }
    if (signal.aborted) return;
    const settled = this.d.store.settle(session.sessionId, this.#ownerId, this.#clockMs(), this.#now(), report);
    this.debug(settled ? "session-settled" : "session-settle-fenced", { sessionId: session.sessionId, state: report.state });
  }

  private triggerPump(): void {
    if (this.#autoPump) void this.pump().catch((error: unknown) => this.debug("pump-failed", { category: errorName(error) }));
  }

  private debug(stage: string, context: Readonly<Record<string, unknown>>): void {
    this.d.diag?.debug?.(`[MultiIssueSessionManager] ${stage}`, { at: this.#now(), ...context });
  }
}

function errorName(error: unknown): string { return error instanceof Error ? error.name : "unknown"; }

function validateSubmission(input: MultiIssueSubmission): void {
  if (!(["local", "discord", "shell", "other"] as const).includes(input.source.kind)
    || !validSourceId(input.source.sourceId) || !validSourceId(input.source.actorId)) throw new Error("source identity is required");
  if (input.reservationUsd !== undefined && (!Number.isFinite(input.reservationUsd) || input.reservationUsd < 0)) {
    throw new Error("reservation must be a non-negative finite amount");
  }
}


function validSourceId(value: string): boolean {
  return value.length > 0 && value === value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}
