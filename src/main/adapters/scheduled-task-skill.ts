import type { ToolCall, ToolSpec } from "../domain/chat.js";
import type { ToolExecutorPort } from "../ports/uc1.js";
import type { ScheduledTaskRuntime } from "./scheduled-task-runtime.js";

const tool: ToolSpec = {
  name: "scheduled_report",
  description: "승인된 Discord 목적지에 보고를 한 번 또는 반복 예약한다. schedule(create), list, pause, resume, cancel을 제공한다.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "list", "pause", "resume", "cancel"] },
      id: { type: "string" },
      prompt: { type: "string" },
      destinationId: { type: "string" },
      scheduleKind: { type: "string", enum: ["at", "every", "cron"] },
      at: { type: "string" }, intervalMs: { type: "number" }, cron: { type: "string" }, timeZone: { type: "string" },
    }, required: ["action"],
  }, tier: "ask",
};
function obj(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0; }

export function makeScheduledTaskExecutor(runtime?: ScheduledTaskRuntime): ToolExecutorPort {
  return {
    specs: () => runtime ? [tool] : [],
    async execute(call: ToolCall): Promise<{ output: string; isError?: boolean }> {
      if (call.name !== tool.name) return { output: `unknown tool: ${call.name}`, isError: true };
      if (!runtime || !obj(call.args) || !text(call.args.action)) return { output: "Scheduled reports are unavailable.", isError: true };
      try {
        if (call.args.action === "list") {
          const tasks = await runtime.list();
          return { output: tasks.length ? tasks.map((task) => `${task.id}: ${task.active ? "active" : "paused"}, next=${new Date(task.nextRunAt).toISOString()}`).join("\n") : "No scheduled reports." };
        }
        if (["pause", "resume", "cancel"].includes(call.args.action)) {
          if (!text(call.args.id)) return { output: "id is required.", isError: true };
          const ok = call.args.action === "cancel" ? await runtime.cancel(call.args.id) : await runtime.pause(call.args.id, call.args.action === "resume");
          return ok ? { output: `Scheduled report ${call.args.action} completed.` } : { output: "Scheduled report not found.", isError: true };
        }
        if (call.args.action !== "create" || !text(call.args.prompt) || !text(call.args.destinationId) || !text(call.args.scheduleKind)) return { output: "prompt, destinationId and schedule are required.", isError: true };
        const schedule = call.args.scheduleKind === "at" && text(call.args.at) ? { kind: "at" as const, at: call.args.at }
          : call.args.scheduleKind === "every" && Number.isSafeInteger(call.args.intervalMs) ? { kind: "every" as const, intervalMs: call.args.intervalMs as number }
          : call.args.scheduleKind === "cron" && text(call.args.cron) && text(call.args.timeZone) ? { kind: "cron" as const, expression: call.args.cron, timeZone: call.args.timeZone }
          : undefined;
        if (!schedule) return { output: "Invalid schedule arguments.", isError: true };
        const task = await runtime.create({ prompt: call.args.prompt, destinationId: call.args.destinationId, schedule });
        return { output: `Scheduled report created (${task.id}); next=${new Date(task.nextRunAt).toISOString()}.` };
      } catch { return { output: "Scheduled report was not created.", isError: true }; }
    },
  };
}
