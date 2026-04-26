import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { WorkspaceChange, WorkspaceWatcher } from "@nextain/agent-types";
import { gitDiff, gitDiffStats } from "./git-diff.js";

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_IGNORED: readonly (string | RegExp)[] = [
  /(^|[/\\])\../, // dotfiles (.git, .DS_Store, etc.)
  /(^|[/\\])node_modules([/\\]|$)/,
  /(^|[/\\])dist([/\\]|$)/,
  /(^|[/\\])coverage([/\\]|$)/,
];

export interface ChokidarWatcherOptions {
  /** Debounce window — same path multiple changes within window → 1 chunk. */
  debounceMs?: number;
  /** Force chokidar polling mode (network FS, container fallback). */
  usePolling?: boolean;
  /** Polling interval (ms) when usePolling=true. */
  pollingInterval?: number;
  /** Additional ignore patterns appended to defaults. */
  extraIgnored?: readonly (string | RegExp)[];
  /** Optional sourceSession to label all WorkspaceChange events with. */
  sourceSession?: string;
}

/**
 * D19 + D20 — observes workdir for file events and produces WorkspaceChange.
 * Internally debounced: multiple events for the same path within debounceMs
 * collapse to one (latest kind wins; precedence: delete > add > modify).
 */
export class ChokidarWatcher implements WorkspaceWatcher {
  readonly #opts: Required<
    Pick<ChokidarWatcherOptions, "debounceMs" | "usePolling" | "pollingInterval">
  > & {
    extraIgnored: readonly (string | RegExp)[];
    sourceSession: string | undefined;
  };

  constructor(opts: ChokidarWatcherOptions = {}) {
    this.#opts = {
      debounceMs: opts.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      usePolling: opts.usePolling ?? false,
      pollingInterval: opts.pollingInterval ?? 200,
      extraIgnored: opts.extraIgnored ?? [],
      sourceSession: opts.sourceSession,
    };
  }

  watch(workdir: string, signal: AbortSignal): AsyncIterable<WorkspaceChange> {
    const opts = this.#opts;
    const root = path.resolve(workdir);
    const ignored: (string | RegExp)[] = [...DEFAULT_IGNORED, ...opts.extraIgnored];
    const watcher: FSWatcher = chokidar.watch(root, {
      ignored,
      ignoreInitial: true,
      persistent: true,
      usePolling: opts.usePolling,
      interval: opts.pollingInterval,
      awaitWriteFinish: false,
    });

    // Pending debounce buckets keyed by relative path. Latest kind wins,
    // but deletion takes precedence over add/modify within the window.
    const pending = new Map<
      string,
      { kind: WorkspaceChange["kind"]; timer: NodeJS.Timeout; flushedAt: number }
    >();
    const queue: WorkspaceChange[] = [];
    const waiters: Array<(value: IteratorResult<WorkspaceChange>) => void> = [];
    let closed = false;

    const flush = (rel: string, kind: WorkspaceChange["kind"]) => {
      const change: WorkspaceChange = {
        path: rel,
        kind,
        timestamp: Date.now(),
        ...(opts.sourceSession !== undefined && {
          sourceSession: opts.sourceSession,
        }),
      };
      pending.delete(rel);
      if (waiters.length > 0) {
        waiters.shift()!({ value: change, done: false });
      } else {
        queue.push(change);
      }
    };

    const upsertDebounced = (
      absPath: string,
      kind: WorkspaceChange["kind"],
    ) => {
      if (closed) return;
      const rel = path.relative(root, absPath);
      if (rel.length === 0 || rel.startsWith("..")) return; // outside root
      const existing = pending.get(rel);
      if (existing) {
        clearTimeout(existing.timer);
        // delete takes precedence
        const finalKind: WorkspaceChange["kind"] =
          existing.kind === "delete" || kind === "delete" ? "delete" : kind;
        existing.kind = finalKind;
        existing.timer = setTimeout(() => flush(rel, finalKind), opts.debounceMs);
        existing.flushedAt = Date.now() + opts.debounceMs;
      } else {
        const timer = setTimeout(() => flush(rel, kind), opts.debounceMs);
        pending.set(rel, {
          kind,
          timer,
          flushedAt: Date.now() + opts.debounceMs,
        });
      }
    };

    watcher.on("add", (p) => upsertDebounced(p, "add"));
    watcher.on("change", (p) => upsertDebounced(p, "modify"));
    watcher.on("unlink", (p) => upsertDebounced(p, "delete"));

    const closeAll = () => {
      if (closed) return;
      closed = true;
      // flush any pending
      for (const [rel, b] of pending) {
        clearTimeout(b.timer);
        flush(rel, b.kind);
      }
      void watcher.close();
      while (waiters.length > 0) {
        waiters.shift()!({ value: undefined as never, done: true });
      }
    };

    if (signal.aborted) {
      closeAll();
    } else {
      signal.addEventListener("abort", closeAll, { once: true });
    }

    const iter: AsyncIterable<WorkspaceChange> = {
      [Symbol.asyncIterator](): AsyncIterator<WorkspaceChange> {
        return {
          async next(): Promise<IteratorResult<WorkspaceChange>> {
            if (queue.length > 0) {
              return { value: queue.shift()!, done: false };
            }
            if (closed) {
              return { value: undefined as never, done: true };
            }
            return new Promise((resolve) => waiters.push(resolve));
          },
          async return(): Promise<IteratorResult<WorkspaceChange>> {
            closeAll();
            return { value: undefined as never, done: true };
          },
        };
      },
    };
    return iter;
  }

  async diff(workdir: string, p: string): Promise<string | null> {
    return gitDiff(workdir, p);
  }

  async stats(
    workdir: string,
    p?: string,
  ): Promise<{ additions: number; deletions: number }> {
    return gitDiffStats(workdir, p);
  }
}
