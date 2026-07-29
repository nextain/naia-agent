import { makeDurableSupervisorScheduler } from "../adapters/durable-supervisor-scheduler.js";
import { SqliteDurableSupervisorStore } from "../adapters/sqlite-durable-supervisor-store.js";
import { DurableSupervisor, DurableSupervisorRuntime } from "../app/durable-supervisor.js";
import type { DurableCommandDispatcher, DurableSupervisorScheduler } from "../ports/durable-supervisor.js";

export interface DurableSupervisorRuntimeOptions {
  readonly databasePath: string;
  readonly dispatcher: DurableCommandDispatcher;
  readonly scheduler?: DurableSupervisorScheduler;
  readonly pumpIntervalMs?: number;
  readonly leaseMs?: number;
  readonly baseRetryMs?: number;
  readonly reportIntervalMs?: number;
  readonly now?: () => number;
}

/** Production composition seam. The owning Agent host must start and stop this runtime. */
export function wireDurableSupervisorRuntime(options: DurableSupervisorRuntimeOptions): {
  readonly runtime: DurableSupervisorRuntime;
  readonly store: SqliteDurableSupervisorStore;
  close(): void;
} {
  const store = new SqliteDurableSupervisorStore(options.databasePath, {
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
    ...(options.baseRetryMs !== undefined ? { baseRetryMs: options.baseRetryMs } : {}),
    ...(options.reportIntervalMs !== undefined ? { reportIntervalMs: options.reportIntervalMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const supervisor = new DurableSupervisor(store, options.dispatcher);
  const runtime = new DurableSupervisorRuntime(
    supervisor,
    options.scheduler ?? makeDurableSupervisorScheduler(),
    options.pumpIntervalMs,
  );
  return {
    runtime,
    store,
    close() { runtime.stop(); store.close(); },
  };
}
