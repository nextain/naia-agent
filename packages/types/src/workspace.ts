/**
 * WorkspaceWatcher — observes file changes inside a sub-agent's workdir
 * and produces WorkspaceChange events (D19, D20 workspace_change).
 *
 * Spec: docs/adapter-contract.md §6
 */
export interface WorkspaceChange {
  readonly path: string; // workdir-relative
  readonly kind: "add" | "modify" | "delete";
  readonly timestamp: number;
  readonly sourceSession?: string;
}

export interface WorkspaceWatcher {
  /**
   * Watch workdir. Yields debounced (default 100ms) WorkspaceChange events.
   * Same file changed multiple times within debounce window → 1 event (latest).
   * Stops on signal.aborted.
   */
  watch(workdir: string, signal: AbortSignal): AsyncIterable<WorkspaceChange>;

  /**
   * Compute git-style unified diff for path. Lazy. Returns null if not in
   * git repo or path unchanged. Handles stash/rebase states gracefully.
   */
  diff(workdir: string, path: string): Promise<string | null>;

  /** Aggregate stats. */
  stats(
    workdir: string,
    path?: string,
  ): Promise<{ additions: number; deletions: number }>;
}
