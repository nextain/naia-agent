import type {
  ApprovalBroker,
  NaiaStreamChunk,
  ReportStats,
  SubAgentAdapter,
  ToolExecutionContext,
  Verifier,
  VerificationResult,
  VerificationResultRef,
  WorkspaceWatcher,
} from "@nextain/agent-types";
import { VerificationOrchestrator } from "@nextain/agent-verification";
import { formatReport, reportStatsFromInput } from "@nextain/agent-verification";
import { mergeStreams } from "./stream-merger.js";

export interface Phase1SupervisorOptions {
  adapter: SubAgentAdapter;
  watcher?: WorkspaceWatcher;
  verifiers?: readonly Verifier[];
  /** Skip post-task verification. Reports diff stats only. */
  noVerify?: boolean;
  /** Per-verifier wall-clock timeout. Default 60_000. */
  verificationTimeoutMs?: number;
  /**
   * Phase 2 Day 3.4 — show full unified diff in workspace_change chunks
   * (lazy via WorkspaceWatcher.diff()). Default false (stats only).
   */
  showDiff?: boolean;
  /**
   * Phase 2 — ApprovalBroker DI (Architect P0-2 / D38). When supervisor
   * runs an ACP-aware adapter (OpencodeAcpAdapter), the broker handles
   * `session/request_permission` callbacks for T2/T3 tool gating.
   */
  approvalBroker?: ApprovalBroker;
}

/**
 * Phase 1 minimal Supervisor — 1 sub-agent + workspace watcher + post-task
 * verification + final report. No LLM (passes prompt to adapter directly).
 *
 * D24 (supervisor) + D19 (정직 보고) + D26 (session_aggregated hook).
 */
export class Phase1Supervisor {
  readonly #opts: Phase1SupervisorOptions;

  constructor(opts: Phase1SupervisorOptions) {
    this.#opts = opts;
  }

  async *run(
    prompt: string,
    workdir: string,
    signal: AbortSignal,
  ): AsyncIterable<NaiaStreamChunk> {
    const start = Date.now();
    const tc: ToolExecutionContext = {
      sessionId: "phase1",
      workingDir: workdir,
    };

    // 1) Spawn sub-agent (Phase 2 — approvalBroker propagated to adapter)
    const session = await this.#opts.adapter.spawn(
      { prompt, workdir },
      {
        signal,
        toolContext: tc,
        ...(this.#opts.approvalBroker !== undefined && {
          approvalBroker: this.#opts.approvalBroker,
        }),
      },
    );

    // 2) Optional workspace watcher
    let workspaceStream: AsyncIterable<NaiaStreamChunk> | null = null;
    if (this.#opts.watcher) {
      const watcher = this.#opts.watcher;
      const showDiff = this.#opts.showDiff === true;
      workspaceStream = (async function* () {
        for await (const wc of watcher.watch(workdir, signal)) {
          let diff: string | undefined;
          if (showDiff && wc.kind !== "delete") {
            try {
              const d = await watcher.diff(workdir, wc.path);
              if (d) diff = d;
            } catch {
              /* diff failure non-fatal */
            }
          }
          yield {
            type: "workspace_change",
            path: wc.path,
            kind: wc.kind,
            ...(diff !== undefined && { diff }),
            ...(wc.sourceSession !== undefined && { sourceSession: wc.sourceSession }),
          } satisfies NaiaStreamChunk;
        }
      })();
    }

    // 3) Merge sub-agent stream + workspace stream until session_end
    const merged = workspaceStream
      ? mergeStreams<NaiaStreamChunk>(session.events(), workspaceStream)
      : session.events();

    let sessionEnded = false;
    let workspaceFiles = new Set<string>();
    let sessionId = session.id;

    for await (const chunk of merged) {
      if (chunk.type === "workspace_change") {
        workspaceFiles.add(chunk.path);
      }
      if (chunk.type === "session_start") {
        sessionId = chunk.sessionId;
      }
      yield chunk;
      if (chunk.type === "session_end") {
        sessionEnded = true;
        break;
      }
    }
    if (!sessionEnded) {
      // shouldn't happen with a well-behaved adapter (contract C2)
      yield {
        type: "session_end",
        sessionId,
        reason: "completed",
      };
    }

    // 4) Post-task verification (optional)
    let verifications: readonly VerificationResult[] = [];
    if (!this.#opts.noVerify && this.#opts.verifiers && this.#opts.verifiers.length > 0) {
      const orchestrator = new VerificationOrchestrator(this.#opts.verifiers, {
        timeoutMs: this.#opts.verificationTimeoutMs ?? 60_000,
      });
      for (const v of this.#opts.verifiers) {
        yield {
          type: "verification_start",
          runner: normalizeRunner(v.id),
          command: v.defaultCommand,
        };
      }
      verifications = await orchestrator.runAll(workdir, signal);
      for (const r of verifications) {
        yield {
          type: "verification_result",
          runner: normalizeRunner(r.runner),
          pass: r.pass,
          stats: r.stats,
          durationMs: r.durationMs,
          ...(r.stdoutTail !== undefined && { stdoutTail: r.stdoutTail }),
        };
      }
    }

    // 5) Aggregate stats from workspace + verifiers
    const stats = await aggregateStats(workdir, this.#opts.watcher, workspaceFiles);
    const verificationsRef: VerificationResultRef[] = verifications.map((v) => ({
      runner: v.runner,
      pass: v.pass,
      durationMs: v.durationMs,
    }));
    const reportInput = {
      filesChanged: stats.filesChanged,
      additions: stats.additions,
      deletions: stats.deletions,
      durationMs: Date.now() - start,
      verifications,
    };
    const reportStats: ReportStats = reportStatsFromInput(reportInput);
    const summary = formatReport(reportInput);

    // 6) session_aggregated (D26) + report (D19)
    yield {
      type: "session_aggregated",
      sessionId,
      stats: {
        ...reportStats,
        toolsUsed: 0, // tracked in Phase 2
        llmTurns: 1, // 1 sub-agent invocation
        llmTokensUsed: 0, // tracked in Phase 2
      },
      verifications: verificationsRef,
    };
    yield {
      type: "report",
      sessionId,
      summary,
      stats: reportStats,
      verifications: verificationsRef,
    };
    yield {
      type: "end",
      sessionId,
      stopReason: "end_turn",
    };
  }
}

async function aggregateStats(
  workdir: string,
  watcher: WorkspaceWatcher | undefined,
  changedFiles: Set<string>,
): Promise<{ filesChanged: number; additions: number; deletions: number }> {
  if (!watcher) {
    return { filesChanged: changedFiles.size, additions: 0, deletions: 0 };
  }
  const totals = await watcher.stats(workdir);
  return {
    filesChanged: changedFiles.size,
    additions: totals.additions,
    deletions: totals.deletions,
  };
}

function normalizeRunner(
  id: string,
): "test" | "lint" | "build" | "type_check" | "custom" {
  if (id === "test" || id === "lint" || id === "build" || id === "type_check") {
    return id;
  }
  return "custom";
}
