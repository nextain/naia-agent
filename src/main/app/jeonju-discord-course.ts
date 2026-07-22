import type { CodingJobCourseLifecyclePort, CodingJobControlPort } from "../ports/coding-job.js";
import type {
  DiscordCourseCommand,
  DiscordCourseCommandPort,
  DiscordCourseLifecycleDelivery,
  DiscordCourseStatusPort,
} from "../ports/discord.js";
import type { CodingJobCourseLifecycleState } from "../domain/coding-job.js";

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
  readonly #deliveries = new Map<string, Omit<DiscordCourseLifecycleDelivery, "state">>();
  readonly #pending = new Map<string, CodingJobCourseLifecycleState[]>();
  readonly #tails = new Map<string, Promise<void>>();

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
      const job = this.deps.codingJobs.start({
        workspacePath: this.deps.config.workspacePath,
        task: input.task,
        executionMode: "selected_workspace",
        allowedFiles: this.deps.config.allowedFiles,
      });
      this.#deliveries.set(job.jobId, delivery);
      for (const state of this.#pending.get(job.jobId) ?? []) this.#enqueue(job.jobId, delivery, state);
      this.#pending.delete(job.jobId);
    } catch {
      this.#send(delivery, "failed");
    }
    return true;
  }

  report(input: { readonly jobId: string; readonly state: CodingJobCourseLifecycleState }): void {
    const delivery = this.#deliveries.get(input.jobId);
    if (!delivery) {
      const states = this.#pending.get(input.jobId) ?? [];
      states.push(input.state);
      this.#pending.set(input.jobId, states);
      return;
    }
    this.#enqueue(input.jobId, delivery, input.state);
  }

  #enqueue(jobId: string, delivery: Omit<DiscordCourseLifecycleDelivery, "state">, state: CodingJobCourseLifecycleState): void {
    const next = (this.#tails.get(jobId) ?? Promise.resolve())
      .then(() => this.#send(delivery, state))
      .catch(() => undefined);
    this.#tails.set(jobId, next);
    if (state === "completed" || state === "failed") {
      void next.finally(() => {
        if (this.#tails.get(jobId) === next) this.#tails.delete(jobId);
        this.#deliveries.delete(jobId);
        this.#pending.delete(jobId);
      });
    }
  }

  #send(delivery: Omit<DiscordCourseLifecycleDelivery, "state">, state: CodingJobCourseLifecycleState): Promise<void> {
    return this.deps.status.send({ ...delivery, state });
  }
}
