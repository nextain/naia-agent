/**
 * R4 Slice 6A — Active brain skeleton (no LLM, log-only).
 *
 * naia-memory#26 Background brain emits SpikeEvent. This module subscribes
 * via SpikeHandler and decides inject / skip using rule-based source-monitor
 * (project scope + confidence + opt-out + topic / recent-fact match).
 *
 * LLM-driven source-monitor + pragmatic-gate are deferred to Slice 6B / 6C.
 *
 * Schema: @nextain/agent-types/spike (commit 335e7cf).
 */

import type {
  ActiveContext,
  SpikeAction,
  SpikeEvent,
  SpikeHandler,
} from "@nextain/agent-types";

export interface ActiveBrainOptions {
  activeContext: ActiveContext;
  /** stderr by default. */
  log?: (msg: string) => void;
  /** Confidence floor; below = skip. Default 0.5. */
  minConfidence?: number;
}

export class ActiveBrain {
  private active: ActiveContext;
  private readonly log: (msg: string) => void;
  private readonly minConfidence: number;

  constructor(opts: ActiveBrainOptions) {
    this.active = opts.activeContext;
    this.log = opts.log ?? ((m) => process.stderr.write(m));
    this.minConfidence = opts.minConfidence ?? 0.5;
  }

  setActiveContext(ctx: ActiveContext): void {
    this.active = ctx;
  }

  getActiveContext(): ActiveContext {
    return this.active;
  }

  readonly handle: SpikeHandler = async (
    event: SpikeEvent,
  ): Promise<SpikeAction | void> => {
    if (
      event.scope?.project !== undefined &&
      event.scope.project !== this.active.scope.project
    ) {
      return {
        decision: "skip",
        reason: `cross-project: event=${event.scope.project} active=${this.active.scope.project}`,
      };
    }

    if (event.confidence < this.minConfidence) {
      return {
        decision: "skip",
        reason: `confidence ${event.confidence.toFixed(2)} < ${this.minConfidence}`,
      };
    }

    const optOut = this.active.optOutTopics ?? [];
    const lowerContent = event.content.toLowerCase();
    for (const t of optOut) {
      if (lowerContent.includes(t.toLowerCase())) {
        return { decision: "skip", reason: `opt-out: ${t}` };
      }
    }

    let topicMatch = false;
    for (const topic of this.active.topics) {
      if (lowerContent.includes(topic.toLowerCase())) {
        topicMatch = true;
        break;
      }
    }

    let recentMatch = false;
    for (const id of event.relatedFactIds) {
      if (this.active.recentFactIds.includes(id)) {
        recentMatch = true;
        break;
      }
    }

    if (!topicMatch && !recentMatch) {
      return { decision: "skip", reason: "no topic + no recent match" };
    }

    const matchKind = topicMatch && recentMatch
      ? "topic+recent"
      : topicMatch
        ? "topic"
        : "recent";
    this.log(
      `[active-brain] inject spike-reason=${event.reason} confidence=${event.confidence.toFixed(2)} match=${matchKind} content=${truncate(event.content, 80)}\n`,
    );

    return {
      decision: "inject-next-turn",
      reason: `match=${matchKind} spike-reason=${event.reason}`,
      modifiedContent: event.content,
    };
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
