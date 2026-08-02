import type { CompactionPort, CompactionRequest, CompactionResult, HandoffBlob } from "../ports/compaction.js";
import type { ManagedMemoryPort } from "../ports/memory.js";
import type { RecalledMemory } from "../domain/memory.js";

export type ReloadableMemoryDelegate = ManagedMemoryPort & CompactionPort & { flush?: () => Promise<void> };

interface Slot {
  readonly delegate: ReloadableMemoryDelegate;
  inFlight: number;
  readonly idleWaiters: Array<() => void>;
}

export interface MemoryReplaceResult {
  readonly replaced: boolean;
  readonly closeError?: string;
}

export interface ReloadableMemoryPort extends ReloadableMemoryDelegate {
  reconfigure(build: () => Promise<ReloadableMemoryDelegate>): Promise<MemoryReplaceResult>;
  hasActive(): boolean;
}

/** Stable port whose delegate can be replaced without rewiring chat handlers. */
export function makeReloadableMemory(initial?: ReloadableMemoryDelegate): ReloadableMemoryPort {
  let current = initial ? makeSlot(initial) : undefined;
  let closed = false;
  let mutation = Promise.resolve();
  let reloadGate: Promise<void> | undefined;

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = mutation.then(work, work);
    mutation = result.then(() => undefined, () => undefined);
    return result;
  };

  const withCurrent = async <T>(fallback: T, work: (delegate: ReloadableMemoryDelegate) => Promise<T>): Promise<T> => {
    if (reloadGate) await reloadGate;
    const slot = current;
    if (!slot || closed) return fallback;
    slot.inFlight += 1;
    try {
      return await work(slot.delegate);
    } finally {
      slot.inFlight -= 1;
      if (slot.inFlight === 0) slot.idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  };

  const retire = async (slot: Slot | undefined): Promise<string | undefined> => {
    if (!slot) return undefined;
    if (slot.inFlight > 0) await new Promise<void>((resolve) => slot.idleWaiters.push(resolve));
    try {
      await slot.delegate.close();
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  return {
    hasActive: () => current !== undefined && !closed,

    async reconfigure(build): Promise<MemoryReplaceResult> {
      return serialize(async () => {
        if (closed) throw new Error("reloadable memory is closed");
        let releaseGate: () => void = () => {};
        reloadGate = new Promise<void>((resolve) => { releaseGate = resolve; });
        const previous = current;
        try {
          if (previous?.inFlight) await new Promise<void>((resolve) => previous.idleWaiters.push(resolve));
          if (previous?.delegate.flush) await previous.delegate.flush();
          const next = await build();
          if (closed) {
            await next.close().catch(() => undefined);
            throw new Error("reloadable memory is closed");
          }
          current = makeSlot(next);
          const closeError = await retire(previous);
          return { replaced: true, ...(closeError ? { closeError } : {}) };
        } finally {
          reloadGate = undefined;
          releaseGate();
        }
      });
    },

    recall(query: string): Promise<RecalledMemory> {
      return withCurrent({ facts: [], episodes: [] }, (delegate) => delegate.recall(query));
    },

    save(userText, assistantText, opts): Promise<void> {
      return withCurrent(undefined, (delegate) => delegate.save(userText, assistantText, opts));
    },

    compact(req: CompactionRequest): Promise<CompactionResult> {
      return withCurrent({ recap: "", droppedCount: 0 }, (delegate) => delegate.compact(req));
    },

    attachHandoff(blob: HandoffBlob): Promise<void> {
      return withCurrent(undefined, (delegate) => delegate.attachHandoff(blob));
    },

    async close(): Promise<void> {
      if (closed) return mutation;
      closed = true;
      return serialize(async () => {
        const previous = current;
        current = undefined;
        const closeError = await retire(previous);
        if (closeError) throw new Error(closeError);
      });
    },
  };
}

function makeSlot(delegate: ReloadableMemoryDelegate): Slot {
  return { delegate, inFlight: 0, idleWaiters: [] };
}
