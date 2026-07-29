import type { DurableRunRequest, DurableWorkerEvent } from "../domain/durable-supervisor.js";
import type {
  DurableCommandDispatcher,
  DurableSupervisorScheduler,
  DurableSupervisorStore,
} from "../ports/durable-supervisor.js";

export class DurableSupervisor {
  constructor(
    private readonly store: DurableSupervisorStore,
    private readonly dispatcher: DurableCommandDispatcher,
  ) {}

  startRun(request: DurableRunRequest): void {
    this.store.startRun(request);
  }

  async recover(): Promise<void> {
    this.store.recover();
    await this.pump();
  }

  async pump(): Promise<void> {
    this.store.advanceTime();
    for (;;) {
      const command = this.store.claimCommand();
      if (!command) return;
      try {
        await this.dispatcher.dispatch(command);
        this.store.acknowledgeCommand(command.commandId);
      } catch {
        this.store.deferCommand(command.commandId);
      }
    }
  }

  heartbeat(event: DurableWorkerEvent): boolean {
    return this.store.heartbeat(event);
  }

  complete(event: DurableWorkerEvent & { readonly ok: boolean; readonly summary?: string }): boolean {
    return this.store.complete(event);
  }
}

export class DurableSupervisorRuntime {
  private timer: { cancel(): void } | undefined;
  private pumping = false;

  constructor(
    private readonly supervisor: DurableSupervisor,
    private readonly scheduler: DurableSupervisorScheduler,
    private readonly pumpIntervalMs = 1_000,
  ) {}

  async start(): Promise<void> {
    if (this.timer) return;
    await this.supervisor.recover();
    this.timer = this.scheduler.every(this.pumpIntervalMs, () => { void this.safePump(); });
  }

  stop(): void {
    this.timer?.cancel();
    this.timer = undefined;
  }

  startRun(request: DurableRunRequest): void {
    this.supervisor.startRun(request);
    void this.safePump();
  }

  heartbeat(event: DurableWorkerEvent): boolean {
    return this.supervisor.heartbeat(event);
  }

  complete(event: DurableWorkerEvent & { readonly ok: boolean; readonly summary?: string }): boolean {
    return this.supervisor.complete(event);
  }

  private async safePump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try { await this.supervisor.pump(); } catch { /* durable state is retried by the next tick */ }
    finally { this.pumping = false; }
  }
}
