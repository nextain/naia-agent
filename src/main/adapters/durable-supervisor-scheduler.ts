import type { DurableSupervisorScheduler } from "../ports/durable-supervisor.js";

export function makeDurableSupervisorScheduler(): DurableSupervisorScheduler {
  return {
    every(intervalMs, callback) {
      const timer = setInterval(callback, intervalMs);
      timer.unref?.();
      return { cancel: () => clearInterval(timer) };
    },
  };
}
