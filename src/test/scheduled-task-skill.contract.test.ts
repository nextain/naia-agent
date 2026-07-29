import { describe, expect, it } from "vitest";
import { ScheduledTaskRuntime, makeMemoryScheduledTaskStore } from "../main/adapters/scheduled-task-runtime.js";
import { makeScheduledTaskExecutor } from "../main/adapters/scheduled-task-skill.js";

describe("scheduled_report skill", () => {
  it("is ask-gated and creates provider-neutral periodic reports", async () => {
    const runtime = new ScheduledTaskRuntime({ store: makeMemoryScheduledTaskStore(), ids: () => "report_1", now: () => 1_000_000, runner: { run: async () => "report" }, delivery: { send: async () => ({ messageId: "1" }) } });
    const executor = makeScheduledTaskExecutor(runtime);
    expect(executor.specs()[0]?.tier).toBe("ask");
    const result = await executor.execute({ id: "x", name: "scheduled_report", args: { action: "create", prompt: "report", destinationId: "owner", scheduleKind: "every", intervalMs: 60_000 } }, {});
    expect(result.isError).toBeUndefined();
    expect((await runtime.list())[0]?.kind).toBe("chat-report");
  });
});
