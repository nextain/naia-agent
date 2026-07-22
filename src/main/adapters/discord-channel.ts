import type { AgentEmit, AgentRequest, ChatMessage } from "../domain/chat.js";
import { evaluateDiscordIngress } from "../domain/discord-ingress-policy.js";
import { validateSecurityWireRequest } from "../domain/security-wire.js";
import type {
  DiscordGatewayConnection,
  DiscordGatewayMessage,
  DiscordCourseLifecycleDelivery,
  DiscordInboxRecord,
  DiscordRuntimeDeps,
} from "../ports/discord.js";
import type { AgentEgressPort, AgentIngressPort } from "../ports/uc1.js";
import type { ProcessingProfile } from "../domain/processing-policy.js";

export interface DiscordChannelBinding {
  readonly bindingId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly allowedUserIds: readonly string[];
  readonly processingProfileRef: string;
  readonly participation: "mentions" | "all" | "paused";
}

export interface DiscordRuntimeConfig {
  readonly bindings: readonly DiscordChannelBinding[];
  readonly processingProfiles?: Readonly<Record<string, ProcessingProfile>>;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly maxActiveTurns?: number;
  readonly maxSessions?: number;
  readonly maxHistoryMessages?: number;
  readonly maxReplyChars?: number;
}

interface ActiveTurn {
  readonly requestId: string;
  readonly sessionId: string;
  readonly lifecycleEpoch: number;
  readonly outboundSignal: AbortSignal;
  readonly guildId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly bindingId: string;
  readonly userText: string;
  readonly complete: () => void;
  readonly completion: Promise<void>;
  emitTail: Promise<void>;
  text: string;
  readonly toolRecords: string[];
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SNOWFLAKE = /^\d{1,128}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const REQUEST_PREFIX = "discord:";
const REPLY_CHUNK = 2_000;
const MAX_INPUT_CHARS = 4_000;
const TOOL_PROGRESS_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const COURSE_COMMAND = /^\/course\s+(.+)$/s;
const COURSE_STATUS_TEXT: Readonly<Record<DiscordCourseLifecycleDelivery["state"], string>> = {
  received: "수업 작업을 접수했습니다.",
  running: "수업 작업을 진행하고 있습니다.",
  completed: "수업 작업이 완료되었습니다. Shell에서 결과를 확인해 주세요.",
  failed: "수업 작업을 완료하지 못했습니다. Shell에서 작업 상태를 확인해 주세요.",
};
const CONFIG_KEYS = new Set(["version", "generation", "bindings", "processingProfiles"]);
const BINDING_KEYS = new Set([
  "bindingId",
  "guildId",
  "guildName",
  "channelId",
  "channelName",
  "allowedUserIds",
  "processingProfileRef",
  "participation",
]);
type DiscordRuntimeState = "idle" | "connecting" | "ready" | "backoff" | "stopped" | "terminal_error";

function isBounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() === value
    && value.length >= 1 && value.length <= max && !CONTROL.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function parseBinding(value: unknown): DiscordChannelBinding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (!hasOnlyKeys(item, BINDING_KEYS)
    || !ID.test(String(item.bindingId ?? ""))
    || !isBounded(item.guildId, 128) || !SNOWFLAKE.test(item.guildId)
    || !isBounded(item.channelId, 128) || !SNOWFLAKE.test(item.channelId)
    || (item.guildName !== undefined && item.guildName !== null && !isBounded(item.guildName, 100))
    || (item.channelName !== undefined && item.channelName !== null && !isBounded(item.channelName, 100))
    || !ID.test(String(item.processingProfileRef ?? ""))
    || !Array.isArray(item.allowedUserIds)
    || item.allowedUserIds.length < 1 || item.allowedUserIds.length > 256
    || !item.allowedUserIds.every((id) => isBounded(id, 128) && SNOWFLAKE.test(id))) {
    return undefined;
  }
  return {
    bindingId: item.bindingId as string,
    guildId: item.guildId,
    channelId: item.channelId,
    allowedUserIds: [...item.allowedUserIds] as string[],
    processingProfileRef: item.processingProfileRef as string,
    participation: ["mentions", "all", "paused"].includes(String(item.participation))
      ? item.participation as DiscordChannelBinding["participation"]
      : "paused",
  };
}

export function parseDiscordRuntimeConfig(value: unknown): DiscordRuntimeConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (!hasOnlyKeys(input, CONFIG_KEYS) || input.version !== 1) return undefined;
  if (input.generation !== undefined
    && (!Number.isSafeInteger(input.generation) || Number(input.generation) < 1)) return undefined;
  if (!Array.isArray(input.bindings) || input.bindings.length > 256) return undefined;
  const bindings = input.bindings.map(parseBinding);
  if (bindings.some((binding) => !binding)) return undefined;
  const tupleKeys = new Set<string>();
  const bindingIds = new Set<string>();
  for (const binding of bindings as DiscordChannelBinding[]) {
    const key = `${binding.guildId}\u0000${binding.channelId}`;
    if (tupleKeys.has(key) || bindingIds.has(binding.bindingId)) return undefined;
    tupleKeys.add(key);
    bindingIds.add(binding.bindingId);
  }
  if (!input.processingProfiles || typeof input.processingProfiles !== "object"
    || Array.isArray(input.processingProfiles)) return undefined;
  const processingProfiles = input.processingProfiles as Record<string, unknown>;
  const profileEntries = Object.entries(processingProfiles);
  if (profileEntries.length < 1 || profileEntries.length > 256
    || profileEntries.some(([key, profile]) =>
      !ID.test(key) || !["local_only", "cloud_enabled", "ask_before_external"].includes(String(profile)))
    || (bindings as DiscordChannelBinding[]).some((binding) => !(binding.processingProfileRef in processingProfiles))) {
    return undefined;
  }
  return {
    bindings: bindings as DiscordChannelBinding[],
    processingProfiles: processingProfiles as Record<string, ProcessingProfile>,
  };
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function makeSystemDiscordClock(): DiscordRuntimeDeps["clock"] {
  return { now: Date.now, sleep: defaultSleep };
}

function stripSelfMention(content: string, selfUserId: string): string {
  return content.replaceAll(`<@${selfUserId}>`, "").replaceAll(`<@!${selfUserId}>`, "").trim();
}

function safeReplyChunks(text: string, maxReplyChars: number, emptyReply: string): readonly string[] {
  let codePoints = Array.from(text.trim());
  if (!codePoints.length) codePoints = Array.from(emptyReply);
  if (codePoints.length > maxReplyChars) {
    codePoints = [...codePoints.slice(0, Math.max(0, maxReplyChars - 1)), "…"];
  }
  const chunks: string[] = [];
  for (let index = 0; index < codePoints.length; index += REPLY_CHUNK) {
    chunks.push(codePoints.slice(index, index + REPLY_CHUNK).join(""));
  }
  return chunks;
}

function appendCodePoints(current: string, incoming: string, maxChars: number): string {
  const remaining = Math.max(0, maxChars - Array.from(current).length);
  if (!remaining) return current;
  return current + Array.from(incoming).slice(0, remaining).join("");
}

function toolProgressMessage(
  event: Extract<AgentEmit, { kind: "toolUse" | "toolResult" }>,
): string {
  const tool = TOOL_PROGRESS_NAME.test(event.toolName) ? event.toolName : "tool";
  const state = event.kind === "toolUse" ? "running" : event.success ? "succeeded" : "failed";
  return `TOOL_PROGRESS state=${state} tool=${tool}`;
}

function durableToolRecord(event: Extract<AgentEmit, { kind: "toolResult" }>): string {
  const tool = TOOL_PROGRESS_NAME.test(event.toolName) ? event.toolName : "tool";
  const state = event.success ? "succeeded" : "failed";
  if (tool === "get_time" && event.success
    && event.output.length <= 96
    && /^\d{4}-\d{2}-\d{2}(?:T| )[A-Za-z0-9_+:/(). -]+$/.test(event.output)) {
    return `TOOL_RECORD state=${state} tool=${tool} value=${event.output}`;
  }
  return `TOOL_RECORD state=${state} tool=${tool}`;
}

export class DiscordChannelRuntime {
  readonly ingress: AgentIngressPort;
  readonly egress: AgentEgressPort;
  private route?: (request: AgentRequest) => void;
  private readonly abort = new AbortController();
  private lifecycleAbort = new AbortController();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly histories = new Map<string, ChatMessage[]>();
  private connection?: DiscordGatewayConnection;
  private selfUserId: string | null = null;
  private loop?: Promise<void>;
  private stopPromise?: Promise<void>;
  private gracefulStopPromise?: Promise<void>;
  private stopped = false;
  private quiescing = false;
  private reconfigureRequested = false;
  private generation = 0;
  private lifecycleEpoch = 0;
  private state: DiscordRuntimeState = "idle";
  private partialReplies = 0;
  private latestPartialConfirmedChunk?: number;
  private authorityPrepared: boolean;
  private authorityRefresh?: Promise<boolean>;
  private readonly registeredUsers = new Map<string, Set<string>>();
  private readonly sessionTails = new Map<string, Promise<void>>();
  private readonly inFlightTasks = new Set<Promise<unknown>>();
  private admittedMessages = 0;
  private queuedMessages = 0;

  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly maxActiveTurns: number;
  private readonly maxSessions: number;
  private readonly maxHistoryMessages: number;
  private readonly maxReplyChars: number;
  private readonly gracefulStopTimeoutMs: number;

  constructor(
    private readonly deps: DiscordRuntimeDeps,
    private config: DiscordRuntimeConfig,
  ) {
    if (config.bindings.length > 256) throw new Error("DISCORD_BINDINGS_INVALID");
    this.reconnectBaseMs = this.boundedOption(config.reconnectBaseMs, 1_000, 100, 60_000);
    this.reconnectMaxMs = this.boundedOption(config.reconnectMaxMs, 30_000, this.reconnectBaseMs, 300_000);
    this.maxActiveTurns = this.boundedOption(config.maxActiveTurns, 32, 1, 256);
    this.maxSessions = this.boundedOption(config.maxSessions, 128, 1, 256);
    this.maxHistoryMessages = this.boundedOption(config.maxHistoryMessages, 20, 2, 40);
    this.maxReplyChars = this.boundedOption(config.maxReplyChars, 12_000, 1, 12_000);
    this.gracefulStopTimeoutMs = this.boundedOption(
      deps.gracefulStopTimeoutMs,
      20_000,
      1,
      25_000,
    );
    this.authorityPrepared = !deps.authority;
    this.ingress = {
      onRequest: (callback) => {
        if (this.route) throw new Error("DISCORD_INGRESS_ALREADY_SUBSCRIBED");
        this.route = callback;
        return () => { if (this.route === callback) this.route = undefined; };
      },
    };
    this.egress = {
      emit: (requestId, event) => {
        const turn = this.active.get(requestId);
        if (!turn) return;
        const handling = turn.emitTail
          .then(() => this.handleEmit(requestId, event))
          .catch(() => this.diagnostic("egress_handling_failed"));
        turn.emitTail = handling;
        void this.trackTask(handling);
      },
      emitCritical: (requestId, event) => {
        const turn = this.active.get(requestId);
        if (!turn || this.stopped || event.kind !== "processingDisclosure") return false;
        return this.trackTask(this.deliverDisclosure(turn, event));
      },
    };
  }

  start(): void {
    if (this.loop || this.stopped) return;
    this.loop = this.run();
  }

  /**
   * Host-owned lifecycle bridge entry.  The runtime re-checks the configured
   * binding and only emits one of four fixed messages, so job details cannot
   * be reflected into Discord.
   */
  async sendCourseLifecycle(input: DiscordCourseLifecycleDelivery): Promise<void> {
    const binding = this.config.bindings.find((candidate) =>
      candidate.bindingId === input.bindingId
      && candidate.guildId === input.guildId
      && candidate.channelId === input.channelId);
    const connection = this.connection;
    if (!binding || !connection || !this.isLifecycleCurrent(this.lifecycleEpoch)
      || !await this.ensureAuthoritative()) return;
    const content = COURSE_STATUS_TEXT[input.state];
    if (!content) return;
    try {
      const replyMessageId = await connection.sendReply({
        guildId: input.guildId,
        channelId: input.channelId,
        messageId: input.sourceMessageId,
        content,
        signal: this.lifecycleAbort.signal,
      });
      await this.recordInbox({
        recordId: `outgoing_${replyMessageId}`,
        direction: "outgoing",
        bindingId: input.bindingId,
        guildId: input.guildId,
        channelId: input.channelId,
        sourceMessageId: replyMessageId,
        content,
        createdAt: this.deps.clock.now(),
      });
    } catch {
      this.diagnostic("course_status_reply_failed");
    }
  }

  status(): {
    readonly state: DiscordRuntimeState;
    readonly bindingCount: number;
    readonly activeTurns: number;
    readonly partialReplies: number;
    readonly partialReply?: { readonly confirmedChunk: number };
    readonly authoritative: boolean;
    readonly resumeSupported: true;
  } {
    return {
      state: this.state,
      bindingCount: this.config.bindings.length,
      activeTurns: this.active.size,
      partialReplies: this.partialReplies,
      ...(this.latestPartialConfirmedChunk !== undefined
        ? { partialReply: { confirmedChunk: this.latestPartialConfirmedChunk } }
        : {}),
      authoritative: this.isAuthoritative(),
      resumeSupported: true,
    };
  }

  async configure(config: DiscordRuntimeConfig): Promise<void> {
    if (config.bindings.length > 256) throw new Error("DISCORD_BINDINGS_INVALID");
    if (this.stopped || this.quiescing) throw new Error("DISCORD_RUNTIME_STOPPED");
    this.lifecycleAbort.abort();
    this.lifecycleAbort = new AbortController();
    this.generation++;
    this.lifecycleEpoch++;
    this.authorityPrepared = !this.deps.authority;
    this.config = config;
    this.reconfigureRequested = this.loop !== undefined;
    this.selfUserId = null;
    this.registeredUsers.clear();
    this.histories.clear();
    this.connection?.close();
    const staleTasks = [...this.inFlightTasks];
    const staleTurns = [...this.active.values()];
    this.active.clear();
    for (const turn of staleTurns) {
      turn.complete();
      this.route?.({ kind: "cancel", requestId: turn.requestId });
    }
    await Promise.allSettled(staleTurns.map(async (turn) => {
      try {
        if (await this.deps.dedupe.partial({
          bindingId: turn.bindingId,
          messageId: turn.messageId,
          confirmedChunk: 0,
          now: this.deps.clock.now(),
        })) {
          this.partialReplies++;
          this.latestPartialConfirmedChunk = 0;
        }
      } catch { /* fail closed */ }
    }));
    await Promise.allSettled(staleTasks);
  }

  async stop(): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.stopRuntime();
    await this.stopPromise;
  }

  async gracefulStop(): Promise<void> {
    if (!this.gracefulStopPromise) this.gracefulStopPromise = this.gracefulStopRuntime();
    await this.gracefulStopPromise;
  }

  private async gracefulStopRuntime(): Promise<void> {
    // Reject newly delivered Gateway messages while preserving the current
    // lifecycle epoch and outbound signal for work admitted before shutdown.
    this.quiescing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.gracefulStopTimeoutMs);
      timer.unref?.();
    });
    await Promise.race([this.drain().then(() => true as const), timedOut]);
    if (timer) clearTimeout(timer);
    await this.stop();
  }

  private async stopRuntime(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.lifecycleEpoch++;
    this.state = "stopped";
    this.lifecycleAbort.abort();
    this.abort.abort();
    this.connection?.close();
    const staleTasks = [...this.inFlightTasks];
    const staleTurns = [...this.active.values()];
    this.active.clear();
    for (const turn of staleTurns) {
      turn.complete();
      this.route?.({ kind: "cancel", requestId: turn.requestId });
    }
    await Promise.allSettled(staleTurns.map((turn) =>
      this.finishInterruptedReservation(turn.bindingId, turn.messageId)));
    await Promise.allSettled(staleTasks);
    try { await this.loop; } catch { /* stop is no-throw */ }
  }

  async drain(): Promise<void> {
    while ((this.active.size || this.admittedMessages || this.queuedMessages || this.inFlightTasks.size)
      && !this.stopped) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private boundedOption(value: number | undefined, fallback: number, min: number, max: number): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
      throw new Error("DISCORD_RUNTIME_CONFIG_INVALID");
    }
    return resolved;
  }

  private diagnostic(code: string, extra?: Record<string, unknown>): void {
    try { this.deps.diag.log("discord runtime", { code, ...extra }); } catch { /* observer isolation */ }
  }

  private trackTask<T>(task: Promise<T>): Promise<T> {
    this.inFlightTasks.add(task);
    void task.then(
      () => this.inFlightTasks.delete(task),
      () => this.inFlightTasks.delete(task),
    );
    return task;
  }

  private isLifecycleCurrent(lifecycleEpoch: number): boolean {
    return !this.stopped && lifecycleEpoch === this.lifecycleEpoch;
  }

  private isAuthoritative(): boolean {
    if (this.stopped) {
      this.authorityPrepared = false;
      return false;
    }
    try {
      const raw = this.deps.authority?.isActive() ?? true;
      if (!raw) this.authorityPrepared = false;
      else if (!this.authorityPrepared) void this.ensureAuthoritative();
      return raw && this.authorityPrepared;
    }
    catch { return false; }
  }

  private async ensureAuthoritative(): Promise<boolean> {
    if (this.stopped) {
      this.authorityPrepared = false;
      return false;
    }
    let raw = false;
    try { raw = this.deps.authority?.isActive() ?? true; } catch { return false; }
    if (!raw) {
      this.authorityPrepared = false;
      return false;
    }
    if (this.authorityPrepared) return true;
    if (!this.authorityRefresh) {
      const lifecycleEpoch = this.lifecycleEpoch;
      const refresh = (async () => {
        try {
          const [dedupeRefreshed, registrationRefreshed] = await Promise.all([
            this.deps.dedupe.refresh?.() ?? Promise.resolve(true),
            this.deps.registration?.refresh?.() ?? Promise.resolve(true),
          ]);
          let stillActive = false;
          try { stillActive = this.deps.authority?.isActive() ?? true; } catch { /* fail closed */ }
          this.authorityPrepared = dedupeRefreshed
            && registrationRefreshed
            && stillActive
            && this.isLifecycleCurrent(lifecycleEpoch);
          return this.authorityPrepared;
        } catch {
          this.authorityPrepared = false;
          return false;
        }
      })();
      const tracked = refresh.finally(() => {
        if (this.authorityRefresh === tracked) this.authorityRefresh = undefined;
      });
      this.authorityRefresh = tracked;
      this.trackTask(tracked);
    }
    return this.authorityRefresh;
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      this.state = "connecting";
      let token: string | undefined;
      try { token = await this.deps.token.load(); } catch { /* classified below */ }
      if (!token || token.length > 512 || CONTROL.test(token)) {
        this.state = "terminal_error";
        this.diagnostic("token_unavailable");
        return;
      }
      const generation = ++this.generation;
      const lifecycleEpoch = this.lifecycleEpoch;
      const iterationSignal = AbortSignal.any([
        this.abort.signal,
        this.lifecycleAbort.signal,
      ]);
      let becameReady = false;
      try {
        const connection = await this.deps.gateway.connect(token, {
          onReady: (selfUserId) => {
            if (this.stopped || generation !== this.generation || !isBounded(selfUserId, 128)) return;
            becameReady = true;
            this.state = "ready";
            attempt = 0;
            this.selfUserId = selfUserId;
            this.diagnostic("ready", { bindingCount: this.config.bindings.length });
          },
          onMessage: (message) => {
            if (this.stopped || generation !== this.generation) return;
            this.scheduleMessage(message, lifecycleEpoch);
          },
        }, { signal: iterationSignal });
        if (this.stopped || generation !== this.generation) {
          connection.close();
          if (!this.stopped) {
            this.reconfigureRequested = false;
            attempt = 0;
            continue;
          }
          return;
        }
        this.connection = connection;
        const closed = await connection.closed;
        if (this.connection === connection) this.connection = undefined;
        this.selfUserId = null;
        if (this.reconfigureRequested && !this.stopped) {
          this.reconfigureRequested = false;
          attempt = 0;
          continue;
        }
        if (this.stopped || !closed.retryable) {
          if (!this.stopped) {
            this.state = "terminal_error";
            this.diagnostic(closed.code);
          }
          return;
        }
        this.diagnostic(closed.code);
      } catch (error) {
        if (!this.isLifecycleCurrent(lifecycleEpoch)) {
          if (!this.stopped) {
            this.reconfigureRequested = false;
            attempt = 0;
            continue;
          }
          return;
        }
        const code = (error as { code?: unknown }).code;
        if (code === "auth_failed" || code === "intent_missing") {
          this.state = "terminal_error";
          this.diagnostic(String(code));
          return;
        }
        this.diagnostic("connect_failed");
      }
      if (!this.isLifecycleCurrent(lifecycleEpoch)) {
        if (!this.stopped) {
          this.reconfigureRequested = false;
          attempt = 0;
          continue;
        }
        return;
      }
      if (this.stopped) return;
      if (becameReady) attempt = 0;
      this.state = "backoff";
      const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** Math.min(attempt++, 16)));
      try {
        await this.deps.clock.sleep(delay, iterationSignal);
      } catch {
        if (!this.isLifecycleCurrent(lifecycleEpoch) && !this.stopped) {
          this.reconfigureRequested = false;
          attempt = 0;
          continue;
        }
        return;
      }
    }
  }

  private findBinding(message: DiscordGatewayMessage): DiscordChannelBinding | undefined {
    if (message.guildId === null) return undefined;
    return this.config.bindings.find((binding) =>
      binding.guildId === message.guildId && binding.channelId === message.channelId);
  }

  private scheduleMessage(message: DiscordGatewayMessage, lifecycleEpoch: number): void {
    if (this.quiescing || !this.isLifecycleCurrent(lifecycleEpoch)) return;
    const binding = this.findBinding(message);
    if (!binding || message.guildId === null) return;
    if (this.active.size + this.admittedMessages >= this.maxActiveTurns) {
      this.diagnostic("busy", {
        activeCount: this.active.size,
        admittedCount: this.admittedMessages,
        queuedCount: this.queuedMessages,
      });
      return;
    }
    const sessionId = `discord:${binding.bindingId}:${binding.guildId}:${binding.channelId}:${message.authorId}`;
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve();
    let admissionHeld = true;
    const releaseAdmission = () => {
      if (!admissionHeld) return;
      admissionHeld = false;
      this.admittedMessages--;
    };
    this.admittedMessages++;
    this.queuedMessages++;
    const task = previous.then(async () => {
      this.queuedMessages--;
      try {
        if (!this.isLifecycleCurrent(lifecycleEpoch)) return;
        await this.handleMessage(message, binding, lifecycleEpoch, releaseAdmission);
      } catch {
        this.diagnostic("message_handling_failed");
      } finally {
        releaseAdmission();
      }
    });
    this.trackTask(task);
    this.sessionTails.set(sessionId, task);
    void task.then(() => {
      if (this.sessionTails.get(sessionId) === task) this.sessionTails.delete(sessionId);
    });
  }

  private async handleMessage(
    message: DiscordGatewayMessage,
    binding: DiscordChannelBinding | undefined,
    lifecycleEpoch: number,
    releaseAdmission: () => void,
  ): Promise<void> {
    if (!await this.ensureAuthoritative()) {
      this.deps.diag.debug?.("discord ingress rejected", { reason: "generation_not_authoritative" });
      return;
    }
    if (!this.isLifecycleCurrent(lifecycleEpoch)) return;
    const selfUserId = this.selfUserId;
    let registered = binding ? this.registeredUsers.get(binding.bindingId)?.has(message.authorId) === true : false;
    if (!registered && binding && this.deps.registration) {
      try {
        registered = await this.deps.registration.isRegistered({
          bindingId: binding.bindingId,
          userId: message.authorId,
        });
      } catch { /* fail closed */ }
    }
    if (!this.isLifecycleCurrent(lifecycleEpoch)) return;
    const allowedUserIds = binding
      ? [...binding.allowedUserIds, ...(registered ? [message.authorId] : [])]
      : [];
    const decision = evaluateDiscordIngress({
      readySelfUserId: selfUserId,
      messageId: message.messageId,
      guildId: message.guildId ?? "",
      channelId: message.channelId,
      authorId: message.authorId,
      authorIsBot: message.authorIsBot,
      mentionsSelf: selfUserId !== null && message.mentionedUserIds.includes(selfUserId),
      repliesToSelf: selfUserId !== null && message.replyToAuthorId === selfUserId,
      allowedGuildIds: binding ? [binding.guildId] : [],
      allowedChannelIds: binding ? [binding.channelId] : [],
      allowedUserIds,
      participation: binding?.participation ?? "paused",
    });
    if (!decision.accepted || !binding || !selfUserId) {
      if (binding && selfUserId && !message.authorIsBot && message.authorId !== selfUserId
        && message.mentionedUserIds.includes(selfUserId) && this.deps.registration) {
        const code = stripSelfMention(message.content, selfUserId).match(/^register\s+(\S{4,128})$/i)?.[1];
        if (code) {
          if (!await this.ensureAuthoritative() || !this.isLifecycleCurrent(lifecycleEpoch)) return;
          let claimed = false;
          try {
            claimed = await this.deps.registration.claim({
              bindingId: binding.bindingId,
              userId: message.authorId,
              code,
              now: this.deps.clock.now(),
            });
          } catch { /* fail closed */ }
          if (claimed && this.isLifecycleCurrent(lifecycleEpoch)) {
            const users = this.registeredUsers.get(binding.bindingId) ?? new Set<string>();
            users.add(message.authorId);
            this.registeredUsers.set(binding.bindingId, users);
          }
          return;
        }
      }
      this.deps.diag.debug?.("discord ingress rejected", { reason: decision.accepted ? "binding_missing" : decision.reason });
      return;
    }
    const userText = stripSelfMention(message.content, selfUserId);
    if (!userText || userText.length > MAX_INPUT_CHARS) {
      this.deps.diag.debug?.("discord ingress rejected", { reason: "invalid_content" });
      return;
    }
    let reservation: Awaited<ReturnType<DiscordRuntimeDeps["dedupe"]["reserve"]>> = { decision: "duplicate" };
    if (!await this.ensureAuthoritative() || !this.isLifecycleCurrent(lifecycleEpoch)) return;
    try {
      reservation = await this.deps.dedupe.reserve({
        bindingId: binding.bindingId,
        messageId: message.messageId,
        now: this.deps.clock.now(),
      });
    } catch { /* fail closed */ }
    if (!await this.ensureAuthoritative() || !this.isLifecycleCurrent(lifecycleEpoch)) {
      if (reservation.decision === "process") {
        await this.finishInterruptedReservation(binding.bindingId, message.messageId);
      }
      return;
    }
    if (reservation.decision === "resume_reply") {
      await this.sendDurableReply(
        binding.bindingId,
        binding.guildId,
        binding.channelId,
        message.messageId,
        reservation.chunks,
        reservation.nextChunk,
        lifecycleEpoch,
        this.lifecycleAbort.signal,
      );
      return;
    }
    if (reservation.decision !== "process" || !this.isLifecycleCurrent(lifecycleEpoch)) {
      this.deps.diag.debug?.("discord ingress rejected", { reason: "dedupe_rejected" });
      return;
    }
    await this.recordInbox({
      recordId: `incoming_${message.messageId}`,
      direction: "incoming",
      bindingId: binding.bindingId,
      guildId: binding.guildId,
      channelId: binding.channelId,
      sourceMessageId: message.messageId,
      authorId: message.authorId,
      content: message.content,
      createdAt: this.deps.clock.now(),
    });
    if (!await this.ensureAuthoritative() || !this.isLifecycleCurrent(lifecycleEpoch)) {
      await this.finishInterruptedReservation(binding.bindingId, message.messageId);
      return;
    }
    const courseTask = userText.match(COURSE_COMMAND)?.[1]?.trim();
    if (courseTask && this.deps.courseCommand?.start({
      bindingId: binding.bindingId,
      guildId: binding.guildId,
      channelId: binding.channelId,
      sourceMessageId: message.messageId,
      authorId: message.authorId,
      task: courseTask,
    })) {
      try {
        await this.deps.dedupe.complete({
          bindingId: binding.bindingId,
          messageId: message.messageId,
          now: this.deps.clock.now(),
        });
      } catch { this.diagnostic("course_command_state_failed"); }
      return;
    }
    if (!this.route) {
      await this.finishInterruptedReservation(binding.bindingId, message.messageId);
      this.diagnostic("ingress_unavailable");
      return;
    }
    const requestId = `${REQUEST_PREFIX}${binding.bindingId}:${message.messageId}`;
    const sessionId = `discord:${binding.bindingId}:${binding.guildId}:${binding.channelId}:${message.authorId}`;
    const previous = this.touchHistory(sessionId);
    const request = {
      kind: "chat" as const,
      requestId,
      sessionId,
      messages: [...previous, { role: "user" as const, content: userText }],
      channel: {
        kind: "discord" as const,
        bindingId: binding.bindingId,
        guildId: binding.guildId,
        channelId: binding.channelId,
        userId: message.authorId,
      },
      processing: { processingProfileRef: binding.processingProfileRef },
    };
    const checked = validateSecurityWireRequest(request, {
      trustedBinding: { ...binding, allowedUserIds },
    });
    if (!checked.ok) {
      await this.finishInterruptedReservation(binding.bindingId, message.messageId);
      this.diagnostic("security_rejected");
      return;
    }
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => { complete = resolve; });
    releaseAdmission();
    this.active.set(requestId, {
      requestId,
      sessionId,
      lifecycleEpoch,
      outboundSignal: this.lifecycleAbort.signal,
      guildId: binding.guildId,
      channelId: binding.channelId,
      messageId: message.messageId,
      bindingId: binding.bindingId,
      userText,
      complete,
      completion,
      emitTail: Promise.resolve(),
      text: "",
      toolRecords: [],
    });
    this.deps.diag.debug?.("discord dispatch", { activeCount: this.active.size, historyCount: previous.length });
    try {
      this.route(checked.value);
    } catch {
      this.active.delete(requestId);
      complete();
      await this.finishInterruptedReservation(binding.bindingId, message.messageId);
      this.diagnostic("ingress_dispatch_failed");
    }
    await completion;
  }

  private touchHistory(sessionId: string): readonly ChatMessage[] {
    const history = this.histories.get(sessionId) ?? [];
    if (this.histories.has(sessionId)) this.histories.delete(sessionId);
    this.histories.set(sessionId, history);
    while (this.histories.size > this.maxSessions) {
      const oldest = this.histories.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.histories.delete(oldest);
    }
    return history;
  }

  private commitHistory(turn: ActiveTurn): void {
    const history = [...this.touchHistory(turn.sessionId),
      { role: "user" as const, content: turn.userText },
      { role: "assistant" as const, content: turn.text }];
    this.histories.set(turn.sessionId, history.slice(-this.maxHistoryMessages));
  }

  private async handleEmit(requestId: string, event: AgentEmit): Promise<void> {
    const turn = this.active.get(requestId);
    if (!turn || !this.isLifecycleCurrent(turn.lifecycleEpoch)) return;
    if (!await this.ensureAuthoritative()) {
      this.active.delete(requestId);
      turn.complete();
      this.route?.({ kind: "cancel", requestId });
      await this.recordPartial(turn.bindingId, turn.messageId, 0);
      return;
    }
    if (!this.isLifecycleCurrent(turn.lifecycleEpoch)) return;
    if (event.kind === "text") {
      turn.text = appendCodePoints(turn.text, event.text, this.maxReplyChars);
      return;
    }
    if (event.kind === "toolUse" || event.kind === "toolResult") {
      if (event.kind === "toolResult") turn.toolRecords.push(durableToolRecord(event));
      await this.deliverToolProgress(turn, event);
      return;
    }
    if (event.kind === "processingDisclosure") return;
    if (event.kind !== "finish" && event.kind !== "error") return;
    this.active.delete(requestId);
    const replyText = event.kind === "error"
      ? this.deps.text.failureReply()
      : turn.text;
    const reply = turn.toolRecords.length
      ? `${turn.toolRecords.join("\n")}\n\n${replyText}`
      : replyText;
    if (event.kind === "finish") this.commitHistory(turn);
    turn.complete();
    const chunks = safeReplyChunks(reply, this.maxReplyChars, this.deps.text.emptyReply());
    if (!await this.ensureAuthoritative() || !this.isLifecycleCurrent(turn.lifecycleEpoch)) {
      await this.recordPartial(turn.bindingId, turn.messageId, 0);
      return;
    }
    let persisted = false;
    try {
      persisted = await this.deps.dedupe.beginReply({
        bindingId: turn.bindingId,
        messageId: turn.messageId,
        chunks,
        now: this.deps.clock.now(),
      });
    } catch { /* fail closed */ }
    if (!persisted) {
      this.diagnostic("reply_state_failed");
      return;
    }
    if (!this.isLifecycleCurrent(turn.lifecycleEpoch)) {
      await this.recordPartial(turn.bindingId, turn.messageId, 0);
      return;
    }
    await this.sendDurableReply(
      turn.bindingId,
      turn.guildId,
      turn.channelId,
      turn.messageId,
      chunks,
      0,
      turn.lifecycleEpoch,
      turn.outboundSignal,
    );
  }

  private async deliverDisclosure(
    turn: ActiveTurn,
    event: Extract<AgentEmit, { kind: "processingDisclosure" }>,
  ): Promise<boolean> {
    const connection = this.connection;
    if (!connection || !this.isLifecycleCurrent(turn.lifecycleEpoch)
      || !await this.ensureAuthoritative()
      || !this.isLifecycleCurrent(turn.lifecycleEpoch)) return false;
    try {
      if (!await this.ensureAuthoritative() || !this.isLifecycleCurrent(turn.lifecycleEpoch)) return false;
      await connection.sendReply({
        channelId: turn.channelId,
        guildId: turn.guildId,
        messageId: turn.messageId,
        content: this.deps.text.processingDisclosure(event),
        signal: turn.outboundSignal,
      });
      return this.isLifecycleCurrent(turn.lifecycleEpoch);
    } catch {
      this.diagnostic("disclosure_delivery_failed");
      return false;
    }
  }

  private async deliverToolProgress(
    turn: ActiveTurn,
    event: Extract<AgentEmit, { kind: "toolUse" | "toolResult" }>,
  ): Promise<boolean> {
    const connection = this.connection;
    if (!connection || !this.isLifecycleCurrent(turn.lifecycleEpoch)
      || !await this.ensureAuthoritative()
      || !this.isLifecycleCurrent(turn.lifecycleEpoch)) return false;
    try {
      await connection.sendReply({
        channelId: turn.channelId,
        guildId: turn.guildId,
        messageId: turn.messageId,
        content: toolProgressMessage(event),
        signal: turn.outboundSignal,
      });
      return this.isLifecycleCurrent(turn.lifecycleEpoch);
    } catch {
      this.diagnostic("tool_progress_delivery_failed");
      return false;
    }
  }

  private async sendDurableReply(
    bindingId: string,
    guildId: string,
    channelId: string,
    messageId: string,
    chunks: readonly string[],
    startChunk: number,
    lifecycleEpoch?: number,
    outboundSignal: AbortSignal = this.lifecycleAbort.signal,
  ): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      this.diagnostic("reply_connection_unavailable");
      return;
    }
    let sent = startChunk;
    try {
      for (let index = startChunk; index < chunks.length; index++) {
        if ((lifecycleEpoch !== undefined && !this.isLifecycleCurrent(lifecycleEpoch))
          || this.stopped || !await this.ensureAuthoritative()) {
          await this.recordPartial(bindingId, messageId, sent);
          return;
        }
        const claimed = await this.deps.dedupe.claimChunk({
          bindingId,
          messageId,
          nextChunk: index + 1,
          now: this.deps.clock.now(),
        });
        if (!claimed) throw new Error("reply_state_failed");
        if (!await this.ensureAuthoritative()
          || (lifecycleEpoch !== undefined && !this.isLifecycleCurrent(lifecycleEpoch))) {
          await this.recordPartial(bindingId, messageId, sent);
          return;
        }
        const replyMessageId = await connection.sendReply({
          channelId,
          guildId,
          messageId,
          content: chunks[index]!,
          signal: outboundSignal,
        });
        sent = index + 1;
        const recorded = await this.deps.dedupe.confirmChunk({
          bindingId,
          messageId,
          confirmedChunk: sent,
          now: this.deps.clock.now(),
        });
        if (!recorded) throw new Error("reply_state_failed");
        if (lifecycleEpoch !== undefined && !this.isLifecycleCurrent(lifecycleEpoch)) {
          await this.recordPartial(bindingId, messageId, sent);
          return;
        }
        await this.recordInbox({
          recordId: `outgoing_${replyMessageId}`,
          direction: "outgoing",
          bindingId,
          guildId,
          channelId,
          sourceMessageId: replyMessageId,
          content: chunks[index]!,
          createdAt: this.deps.clock.now(),
        });
      }
    } catch (error) {
      await this.recordPartial(bindingId, messageId, sent);
      if (!this.stopped) this.diagnostic((error as { code?: string }).code ?? "reply_failed");
    }
  }

  private async recordInbox(record: DiscordInboxRecord): Promise<void> {
    if (!this.deps.inbox) return;
    try {
      if (!await this.deps.inbox.append(record)) this.diagnostic("inbox_write_rejected");
    } catch {
      this.diagnostic("inbox_write_failed");
    }
  }

  private async recordPartial(bindingId: string, messageId: string, confirmedChunk: number): Promise<void> {
    try {
      if (await this.deps.dedupe.partial({
        bindingId,
        messageId,
        confirmedChunk,
        now: this.deps.clock.now(),
      })) {
        this.partialReplies++;
        this.latestPartialConfirmedChunk = Math.max(
          this.latestPartialConfirmedChunk ?? 0,
          confirmedChunk,
        );
      }
    } catch { /* fail closed */ }
  }

  private async finishInterruptedReservation(bindingId: string, messageId: string): Promise<void> {
    await this.recordPartial(bindingId, messageId, 0);
  }
}
