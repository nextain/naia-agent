import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OutboundDeliveryPort } from "../ports/outbound-delivery.js";

export type ScheduledTaskSchedule =
  | { readonly kind: "at"; readonly at: string }
  | { readonly kind: "every"; readonly intervalMs: number }
  | { readonly kind: "cron"; readonly expression: string; readonly timeZone: string };

export interface ScheduledTask {
  readonly id: string;
  readonly kind: "chat-report";
  readonly prompt: string;
  readonly destinationId: string;
  readonly schedule: ScheduledTaskSchedule;
  readonly active: boolean;
  readonly nextRunAt: number;
  readonly occurrence: number;
}

export interface ScheduledTaskRun {
  readonly taskId: string;
  readonly occurrence: number;
  readonly state: "delivered" | "failed" | "skipped" | "unknown";
  readonly at: number;
  readonly errorCode?: string;
}

interface Document { readonly version: 1; readonly tasks: readonly ScheduledTask[]; readonly runs: readonly ScheduledTaskRun[]; }
export interface ScheduledTaskStore { load(): Promise<Document | undefined>; save(document: Document): Promise<void>; }
export interface ScheduledTaskRunner { run(input: { readonly taskId: string; readonly occurrence: number; readonly prompt: string }): Promise<string>; }

const MAX_TASKS = 128;
const MAX_RUNS = 512;
const MIN_INTERVAL = 60_000;
const MAX_INTERVAL = 366 * 24 * 60 * 60_000;
const MAX_PROMPT = 8_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function validDate(value: string): number | undefined {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function scheduleValid(schedule: ScheduledTaskSchedule): boolean {
  if (schedule.kind === "at") return validDate(schedule.at) !== undefined;
  if (schedule.kind === "every") return Number.isSafeInteger(schedule.intervalMs) && schedule.intervalMs >= MIN_INTERVAL && schedule.intervalMs <= MAX_INTERVAL;
  if (schedule.kind !== "cron" || !validCron(schedule.expression) || !validTimeZone(schedule.timeZone)) return false;
  return true;
}

function validTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return true; } catch { return false; }
}

// Strict five-field cron subset: `*`, `*/n`, a bounded number, or comma lists.
function fieldValid(field: string, min: number, max: number): boolean {
  return field.split(",").every((part) => {
    if (part === "*") return true;
    if (/^\*\/\d+$/u.test(part)) { const n = Number(part.slice(2)); return n >= 1 && n <= max - min + 1; }
    if (!/^\d+$/u.test(part)) return false;
    const n = Number(part); return n >= min && n <= max;
  });
}
export function validCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/u);
  return fields.length === 5 && fieldValid(fields[0]!, 0, 59) && fieldValid(fields[1]!, 0, 23)
    && fieldValid(fields[2]!, 1, 31) && fieldValid(fields[3]!, 1, 12) && fieldValid(fields[4]!, 0, 6);
}

function fieldMatches(field: string, value: number): boolean {
  return field.split(",").some((part) => part === "*" || (part.startsWith("*/") && value % Number(part.slice(2)) === 0) || Number(part) === value);
}
function zonedFields(at: number, timeZone: string): [number, number, number, number, number] {
  const values = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", minute: "2-digit", hour: "2-digit", day: "2-digit", month: "2-digit", weekday: "short" }).formatToParts(new Date(at));
  const get = (kind: Intl.DateTimeFormatPartTypes) => Number(values.find((part) => part.type === kind)?.value);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.find((part) => part.type === "weekday")?.value ?? "");
  return [get("minute"), get("hour"), get("day"), get("month"), weekday];
}

export function nextCronAt(expression: string, timeZone: string, after: number): number | undefined {
  if (!validCron(expression) || !validTimeZone(timeZone)) return undefined;
  const fields = expression.trim().split(/\s+/u);
  let candidate = Math.floor(after / 60_000) * 60_000 + 60_000;
  const limit = candidate + 366 * 24 * 60 * 60_000;
  while (candidate <= limit) {
    const [minute, hour, day, month, weekday] = zonedFields(candidate, timeZone);
    if (fieldMatches(fields[0]!, minute) && fieldMatches(fields[1]!, hour) && fieldMatches(fields[2]!, day)
      && fieldMatches(fields[3]!, month) && fieldMatches(fields[4]!, weekday)) return candidate;
    candidate += 60_000;
  }
  return undefined;
}

function next(schedule: ScheduledTaskSchedule, from: number): number | undefined {
  if (schedule.kind === "at") return validDate(schedule.at);
  if (schedule.kind === "every") return from + schedule.intervalMs;
  return nextCronAt(schedule.expression, schedule.timeZone, from);
}

function clean(value: unknown): Document | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<Document>;
  if (input.version !== 1 || !Array.isArray(input.tasks) || !Array.isArray(input.runs) || input.tasks.length > MAX_TASKS || input.runs.length > MAX_RUNS) return undefined;
  const tasks = input.tasks.filter((task): task is ScheduledTask => !!task && typeof task === "object" && ID.test(String(task.id)) && task.kind === "chat-report" && typeof task.prompt === "string" && task.prompt.length > 0 && task.prompt.length <= MAX_PROMPT && ID.test(String(task.destinationId)) && typeof task.active === "boolean" && Number.isSafeInteger(task.nextRunAt) && task.nextRunAt > 0 && Number.isSafeInteger(task.occurrence) && task.occurrence >= 0 && !!task.schedule && scheduleValid(task.schedule));
  const ids = new Set<string>();
  if (tasks.length !== input.tasks.length || tasks.some((task) => ids.has(task.id) || (ids.add(task.id), false))) return undefined;
  const runs = input.runs.filter((run): run is ScheduledTaskRun => !!run && typeof run === "object" && ID.test(String(run.taskId)) && Number.isSafeInteger(run.occurrence) && run.occurrence >= 1 && ["delivered", "failed", "skipped", "unknown"].includes(String(run.state)) && Number.isSafeInteger(run.at));
  return runs.length === input.runs.length ? { version: 1, tasks, runs } : undefined;
}

export function makeFileScheduledTaskStore(path: string): ScheduledTaskStore {
  return {
    async load() { try { return clean(JSON.parse(await readFile(path, "utf8"))); } catch { return undefined; } },
    async save(document) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(document)}\n`, "utf8");
      await rename(temporary, path);
    },
  };
}

export function makeMemoryScheduledTaskStore(): ScheduledTaskStore {
  let current: Document | undefined;
  return { load: async () => current && structuredClone(current), save: async (document) => { current = structuredClone(document); } };
}

export class ScheduledTaskRuntime {
  private document: Document = { version: 1, tasks: [], runs: [] };
  private loaded?: Promise<void>;
  constructor(private readonly deps: { store: ScheduledTaskStore; runner: ScheduledTaskRunner; delivery: OutboundDeliveryPort; ids: () => string; now?: () => number }) {}
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private async ready(): Promise<void> { this.loaded ??= this.deps.store.load().then((doc) => { this.document = doc ?? this.document; }); return this.loaded; }
  private async commit(): Promise<void> { await this.deps.store.save(this.document); }
  async list(): Promise<readonly ScheduledTask[]> { await this.ready(); return this.document.tasks; }
  async create(input: { prompt: string; destinationId: string; schedule: ScheduledTaskSchedule }): Promise<ScheduledTask> {
    await this.ready();
    if (this.document.tasks.length >= MAX_TASKS || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > MAX_PROMPT || !ID.test(input.destinationId) || !scheduleValid(input.schedule)) throw new Error("invalid scheduled task");
    const now = this.now(); const nextRunAt = next(input.schedule, now);
    if (!nextRunAt || nextRunAt <= 0) throw new Error("schedule has no next run");
    const task: ScheduledTask = { id: this.deps.ids(), kind: "chat-report", prompt: input.prompt.trim(), destinationId: input.destinationId, schedule: input.schedule, active: true, nextRunAt, occurrence: 0 };
    if (!ID.test(task.id) || this.document.tasks.some((candidate) => candidate.id === task.id)) throw new Error("task id unavailable");
    this.document = { ...this.document, tasks: [...this.document.tasks, task] }; await this.commit(); return task;
  }
  async pause(id: string, active: boolean): Promise<boolean> { await this.ready(); const index = this.document.tasks.findIndex((task) => task.id === id); if (index < 0) return false; const tasks = [...this.document.tasks]; tasks[index] = { ...tasks[index]!, active }; this.document = { ...this.document, tasks }; await this.commit(); return true; }
  async cancel(id: string): Promise<boolean> { await this.ready(); const tasks = this.document.tasks.filter((task) => task.id !== id); if (tasks.length === this.document.tasks.length) return false; this.document = { ...this.document, tasks }; await this.commit(); return true; }
  async runDue(): Promise<void> {
    await this.ready(); const now = this.now();
    for (const task of [...this.document.tasks]) {
      if (!task.active || task.nextRunAt > now) continue;
      const occurrence = task.occurrence + 1;
      // Persist the occurrence before any provider/network action. A restart after this point is unknown, never silently replayed.
      const pending: ScheduledTask = { ...task, occurrence, active: false };
      this.document = { ...this.document, tasks: this.document.tasks.map((candidate) => candidate.id === task.id ? pending : candidate) }; await this.commit();
      let run: ScheduledTaskRun;
      try {
        const content = await this.deps.runner.run({ taskId: task.id, occurrence, prompt: task.prompt });
        await this.deps.delivery.send({ destinationId: task.destinationId, content });
        run = { taskId: task.id, occurrence, state: "delivered", at: now };
      } catch { run = { taskId: task.id, occurrence, state: "unknown", at: now, errorCode: "execution_or_delivery_failed" }; }
      const nextRun = next(task.schedule, now);
      const resumed = task.schedule.kind === "at" ? { ...pending, active: false } : { ...pending, active: run.state === "delivered" && !!nextRun, nextRunAt: nextRun ?? pending.nextRunAt };
      this.document = { ...this.document, tasks: this.document.tasks.map((candidate) => candidate.id === task.id ? resumed : candidate), runs: [...this.document.runs, run].slice(-MAX_RUNS) }; await this.commit();
    }
  }
}
