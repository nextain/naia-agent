import type {
  DurableDispatchCommand,
  DurableRunRequest,
  DurableSupervisorSnapshot,
  DurableWorkerEvent,
} from "../domain/durable-supervisor.js";

export interface DurableCommandDispatcher {
  /** Must deduplicate by idempotencyKey. Resolving is the worker acknowledgement. */
  dispatch(command: DurableDispatchCommand): Promise<void>;
}

export interface DurableSupervisorScheduler {
  every(intervalMs: number, callback: () => void): { cancel(): void };
}

export interface DurableSupervisorStore {
  startRun(request: DurableRunRequest): void;
  recover(): void;
  advanceTime(): void;
  claimCommand(): DurableDispatchCommand | null;
  acknowledgeCommand(commandId: string): void;
  deferCommand(commandId: string): void;
  heartbeat(event: DurableWorkerEvent): boolean;
  complete(event: DurableWorkerEvent & { readonly ok: boolean; readonly summary?: string }): boolean;
  snapshot(runId: string): DurableSupervisorSnapshot;
  close(): void;
}
