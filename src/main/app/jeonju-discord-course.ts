import type { CodingJobCourseLifecyclePort, CodingJobControlPort } from "../ports/coding-job.js";
import type {
  DiscordCourseCommand,
  DiscordCourseCommandPort,
  DiscordCourseLifecycleDelivery,
  DiscordCourseStatusPort,
} from "../ports/discord.js";
import { codingJobCourseLifecycleState, type CodingJobCourseLifecycleState, type CodingJobCourseReply } from "../domain/coding-job.js";

const COURSE_FILES = ["index.html", "hero.svg"] as const;
const MAX_TASK_CHARS = 4_000;
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface JeonjuDiscordCourseConfig {
  readonly workspacePath: string;
  readonly allowedFiles: readonly (typeof COURSE_FILES)[number][];
}

/**
 * Strict host configuration for the Discord workshop route.  This is separate
 * from a chat message so neither the model nor a Discord user can select a
 * target directory or broaden the file authority.
 */
export function parseJeonjuDiscordCourseConfig(value: unknown): JeonjuDiscordCourseConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 3 || input.version !== 1
    || typeof input.workspacePath !== "string"
    || !input.workspacePath.trim()
    || input.workspacePath.length > 4_096
    || CONTROL.test(input.workspacePath)
    || !Array.isArray(input.allowedFiles)
    || input.allowedFiles.some((file) => typeof file !== "string")
    || input.allowedFiles.length !== COURSE_FILES.length
    || new Set(input.allowedFiles).size !== COURSE_FILES.length
    || !COURSE_FILES.every((file) => (input.allowedFiles as readonly string[]).includes(file))) return undefined;
  return { workspacePath: input.workspacePath, allowedFiles: [...COURSE_FILES] };
}

function isSafeTask(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TASK_CHARS && !CONTROL.test(value);
}

/**
 * Bridges the explicit, already-authorized Discord command to a selected
 * workspace coding job.  Lifecycle callbacks can occur synchronously while a
 * job is allocated, so they are buffered until the job id is bound to the
 * original Discord message.
 */
export class JeonjuDiscordCourseService implements DiscordCourseCommandPort, CodingJobCourseLifecyclePort {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, { readonly delivery: CodingJobCourseReply; readonly state: CodingJobCourseLifecycleState }>();

  constructor(
    private readonly deps: {
      readonly codingJobs: CodingJobControlPort;
      readonly config: JeonjuDiscordCourseConfig;
      readonly status: DiscordCourseStatusPort;
    },
  ) {}

  start(input: DiscordCourseCommand): boolean {
    if (!isSafeTask(input.task)) return false;
    const delivery = {
      bindingId: input.bindingId,
      guildId: input.guildId,
      channelId: input.channelId,
      sourceMessageId: input.sourceMessageId,
    } as const;
    try {
      this.deps.codingJobs.start({
        workspacePath: this.deps.config.workspacePath,
        task: input.task,
        executionMode: "selected_workspace",
        allowedFiles: this.deps.config.allowedFiles,
        courseReply: delivery,
      });
    } catch {
      this.#queueExternalFailure(delivery);
    }
    return true;
  }

  report(input: { readonly jobId: string; readonly state: CodingJobCourseLifecycleState }): void {
    const delivery = this.#courseReply(input.jobId);
    if (!delivery) return;
    this.#enqueue(input.jobId, delivery, input.state);
  }

  /** Rehydrates unsent course state after a process restart or Gateway reconnect. */
  restore(): void {
    for (const job of this.deps.codingJobs.list()) {
      if (!job.courseReply) continue;
      const state = codingJobCourseLifecycleState(job.state);
      if (state) this.#enqueue(job.jobId, job.courseReply, state);
    }
  }

  #enqueue(jobId: string, delivery: Omit<DiscordCourseLifecycleDelivery, "state">, state: CodingJobCourseLifecycleState): void {
    const next = (this.#tails.get(jobId) ?? Promise.resolve())
      .then(async () => {
        if (await this.#send(delivery, state)) {
          this.#pending.delete(jobId);
          return;
        }
        this.#pending.set(jobId, { delivery, state });
        this.#scheduleRetry(jobId);
      })
      .catch(() => {
        this.#pending.set(jobId, { delivery, state });
        this.#scheduleRetry(jobId);
    });
    this.#tails.set(jobId, next);
    if (state === "completed" || state === "failed") {
      void next.then(() => {
        if (!this.#pending.has(jobId) && this.#tails.get(jobId) === next) this.#tails.delete(jobId);
      });
    }
  }

  #courseReply(jobId: string): CodingJobCourseReply | undefined {
    try { return this.deps.codingJobs.get(jobId).courseReply; } catch { return undefined; }
  }

  #queueExternalFailure(delivery: CodingJobCourseReply): void {
    const jobId = `failed_${delivery.sourceMessageId}`;
    this.#enqueue(jobId, delivery, "failed");
  }

  #scheduleRetry(jobId: string): void {
    const pending = this.#pending.get(jobId);
    if (!pending) return;
    const timer = setTimeout(() => {
      this.#tails.delete(jobId);
      const latest = this.#pending.get(jobId);
      if (latest) this.#enqueue(jobId, latest.delivery, latest.state);
    }, 1_000);
    timer.unref?.();
  }

  #send(delivery: Omit<DiscordCourseLifecycleDelivery, "state">, state: CodingJobCourseLifecycleState): Promise<boolean> {
    return this.deps.status.send({ ...delivery, state });
  }
}
