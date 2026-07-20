import type { AgentEmit, AgentRequest, ChatMessage } from "../domain/chat.js";
import { evaluateDiscordIngress } from "../domain/discord-ingress-policy.js";
import { validateSecurityWireRequest } from "../domain/security-wire.js";
import type {
  DiscordGatewayConnection,
  DiscordGatewayMessage,
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
  readonly guildId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly bindingId: string;
  readonly userText: string;
  text: string;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SNOWFLAKE = /^\d{1,128}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const REQUEST_PREFIX = "discord:";
const REPLY_CHUNK = 2_000;
const MAX_INPUT_CHARS = 4_000;
type DiscordRuntimeState = "idle" | "connecting" | "ready" | "backoff" | "stopped" | "terminal_error";

function isBounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() === value
    && value.length >= 1 && value.length <= max && !CONTROL.test(value);
}

function parseBinding(value: unknown): DiscordChannelBinding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (!ID.test(String(item.bindingId ?? ""))
    || !isBounded(item.guildId, 128) || !SNOWFLAKE.test(item.guildId)
    || !isBounded(item.channelId, 128) || !SNOWFLAKE.test(item.channelId)
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
  if (!Array.isArray(input.bindings) || input.bindings.length > 256) return undefined;
  const bindings = input.bindings.map(parseBinding);
  if (bindings.some((binding) => !binding)) return undefined;
  const keys = new Set<string>();
  for (const binding of bindings as DiscordChannelBinding[]) {
    const key = `${binding.guildId}\u0000${binding.channelId}`;
    if (keys.has(key)) return undefined;
    keys.add(key);
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
  let bounded = text.trim();
  if (!bounded) bounded = emptyReply;
  if (bounded.length > maxReplyChars) bounded = `${bounded.slice(0, Math.max(0, maxReplyChars - 1))}…`;
  const chunks: string[] = [];
  while (bounded.length) {
    chunks.push(bounded.slice(0, REPLY_CHUNK));
    bounded = bounded.slice(REPLY_CHUNK);
  }
  return chunks;
}

export class DiscordChannelRuntime {
  readonly ingress: AgentIngressPort;
  readonly egress: AgentEgressPort;
  private route?: (request: AgentRequest) => void;
  private readonly abort = new AbortController();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly histories = new Map<string, ChatMessage[]>();
  private connection?: DiscordGatewayConnection;
  private selfUserId: string | null = null;
  private loop?: Promise<void>;
  private stopped = false;
  private reconfigureRequested = false;
  private generation = 0;
  private state: DiscordRuntimeState = "idle";
  private partialReplies = 0;
  private latestPartialConfirmedChunk?: number;
  private authorityPrepared: boolean;
  private authorityRefresh?: Promise<boolean>;
  private readonly registeredUsers = new Map<string, Set<string>>();

  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly maxActiveTurns: number;
  private readonly maxSessions: number;
  private readonly maxHistoryMessages: number;
  private readonly maxReplyChars: number;

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
    this.authorityPrepared = !deps.authority;
    this.ingress = {
      onRequest: (callback) => {
        if (this.route) throw new Error("DISCORD_INGRESS_ALREADY_SUBSCRIBED");
        this.route = callback;
        return () => { if (this.route === callback) this.route = undefined; };
      },
    };
    this.egress = {
      emit: (requestId, event) => { void this.handleEmit(requestId, event); },
      emitCritical: (requestId, event) => {
        const turn = this.active.get(requestId);
        if (!turn || this.stopped || event.kind !== "processingDisclosure") return false;
        return this.deliverDisclosure(turn, event);
      },
    };
  }

  start(): void {
    if (this.loop || this.stopped) return;
    this.loop = this.run();
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
    const staleTurns = [...this.active.values()];
    this.active.clear();
    for (const turn of staleTurns) {
      this.route?.({ kind: "cancel", requestId: turn.requestId });
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
    }
    this.config = config;
    this.reconfigureRequested = true;
    this.generation++;
    this.selfUserId = null;
    this.connection?.close();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.state = "stopped";
    this.abort.abort();
    this.connection?.close();
    for (const requestId of this.active.keys()) {
      this.route?.({ kind: "cancel", requestId });
    }
    this.active.clear();
    try { await this.loop; } catch { /* stop is no-throw */ }
  }

  async drain(): Promise<void> {
    while (this.active.size && !this.stopped) {
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

  private isAuthoritative(): boolean {
    try {
      const raw = this.deps.authority?.isActive() ?? true;
      if (!raw) this.authorityPrepared = false;
      else if (!this.authorityPrepared) void this.ensureAuthoritative();
      return raw && this.authorityPrepared;
    }
    catch { return false; }
  }

  private async ensureAuthoritative(): Promise<boolean> {
    let raw = false;
    try { raw = this.deps.authority?.isActive() ?? true; } catch { return false; }
    if (!raw) {
      this.authorityPrepared = false;
      return false;
    }
    if (this.authorityPrepared) return true;
    if (!this.authorityRefresh) {
      this.authorityRefresh = (async () => {
        const [dedupeRefreshed, registrationRefreshed] = await Promise.all([
          this.deps.dedupe.refresh?.() ?? Promise.resolve(true),
          this.deps.registration?.refresh?.() ?? Promise.resolve(true),
        ]);
        let stillActive = false;
        try { stillActive = this.deps.authority?.isActive() ?? true; } catch { /* fail closed */ }
        this.authorityPrepared = dedupeRefreshed && registrationRefreshed && stillActive;
        return this.authorityPrepared;
      })().finally(() => { this.authorityRefresh = undefined; });
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
            void this.handleMessage(message);
          },
        });
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
        const code = (error as { code?: unknown }).code;
        if (code === "auth_failed" || code === "intent_missing") {
          this.state = "terminal_error";
          this.diagnostic(String(code));
          return;
        }
        this.diagnostic("connect_failed");
      }
      if (becameReady) attempt = 0;
      this.state = "backoff";
      const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** Math.min(attempt++, 16)));
      try { await this.deps.clock.sleep(delay, this.abort.signal); } catch { return; }
    }
  }

  private findBinding(message: DiscordGatewayMessage): DiscordChannelBinding | undefined {
    if (message.guildId === null) return undefined;
    return this.config.bindings.find((binding) =>
      binding.guildId === message.guildId && binding.channelId === message.channelId);
  }

  private async handleMessage(message: DiscordGatewayMessage): Promise<void> {
    if (!await this.ensureAuthoritative()) {
      this.deps.diag.debug?.("discord ingress rejected", { reason: "generation_not_authoritative" });
      return;
    }
    const selfUserId = this.selfUserId;
    const binding = this.findBinding(message);
    let registered = binding ? this.registeredUsers.get(binding.bindingId)?.has(message.authorId) === true : false;
    if (!registered && binding && this.deps.registration) {
      try {
        registered = await this.deps.registration.isRegistered({
          bindingId: binding.bindingId,
          userId: message.authorId,
        });
      } catch { /* fail closed */ }
    }
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
          if (!await this.ensureAuthoritative()) return;
          let claimed = false;
          try {
            claimed = await this.deps.registration.claim({
              bindingId: binding.bindingId,
              userId: message.authorId,
              code,
              now: this.deps.clock.now(),
            });
          } catch { /* fail closed */ }
          if (claimed && !this.stopped) {
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
    if (!this.route) {
      this.diagnostic("ingress_unavailable");
      return;
    }
    if (this.active.size >= this.maxActiveTurns) {
      this.diagnostic("busy", { activeCount: this.active.size });
      return;
    }
    const userText = stripSelfMention(message.content, selfUserId);
    if (!userText || userText.length > MAX_INPUT_CHARS) {
      this.deps.diag.debug?.("discord ingress rejected", { reason: "invalid_content" });
      return;
    }
    let reservation: Awaited<ReturnType<DiscordRuntimeDeps["dedupe"]["reserve"]>> = { decision: "duplicate" };
    if (!await this.ensureAuthoritative()) return;
    try {
      reservation = await this.deps.dedupe.reserve({
        bindingId: binding.bindingId,
        messageId: message.messageId,
        now: this.deps.clock.now(),
      });
    } catch { /* fail closed */ }
    if (!await this.ensureAuthoritative()) {
      if (reservation.decision === "process") {
        try {
          await this.deps.dedupe.releaseReservation?.({
            bindingId: binding.bindingId,
            messageId: message.messageId,
            now: this.deps.clock.now(),
          });
        } catch { /* fail closed */ }
      }
      return;
    }
    if (reservation.decision === "resume_reply") {
      await this.sendDurableReply(binding.bindingId, binding.guildId, binding.channelId, message.messageId, reservation.chunks, reservation.nextChunk);
      return;
    }
    if (reservation.decision !== "process" || this.stopped) {
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
      this.diagnostic("security_rejected");
      return;
    }
    this.active.set(requestId, {
      requestId,
      sessionId,
      guildId: binding.guildId,
      channelId: binding.channelId,
      messageId: message.messageId,
      bindingId: binding.bindingId,
      userText,
      text: "",
    });
    this.deps.diag.debug?.("discord dispatch", { activeCount: this.active.size, historyCount: previous.length });
    this.route(checked.value);
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
    if (!turn || this.stopped) return;
    if (!await this.ensureAuthoritative()) {
      this.active.delete(requestId);
      this.route?.({ kind: "cancel", requestId });
      await this.recordPartial(turn.bindingId, turn.messageId, 0);
      return;
    }
    if (event.kind === "text") {
      const remaining = Math.max(0, this.maxReplyChars - turn.text.length);
      if (remaining) turn.text += event.text.slice(0, remaining);
      return;
    }
    if (event.kind === "processingDisclosure") return;
    if (event.kind !== "finish" && event.kind !== "error") return;
    this.active.delete(requestId);
    const reply = event.kind === "error"
      ? this.deps.text.failureReply()
      : turn.text;
    if (event.kind === "finish") this.commitHistory(turn);
    const chunks = safeReplyChunks(reply, this.maxReplyChars, this.deps.text.emptyReply());
    if (!await this.ensureAuthoritative()) {
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
    await this.sendDurableReply(turn.bindingId, turn.guildId, turn.channelId, turn.messageId, chunks, 0);
  }

  private async deliverDisclosure(
    turn: ActiveTurn,
    event: Extract<AgentEmit, { kind: "processingDisclosure" }>,
  ): Promise<boolean> {
    const connection = this.connection;
    if (!connection || this.stopped || !await this.ensureAuthoritative()) return false;
    try {
      if (!await this.ensureAuthoritative()) return false;
      await connection.sendReply({
        channelId: turn.channelId,
        guildId: turn.guildId,
        messageId: turn.messageId,
        content: this.deps.text.processingDisclosure(event),
        signal: this.abort.signal,
      });
      return !this.stopped;
    } catch {
      this.diagnostic("disclosure_delivery_failed");
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
  ): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      this.diagnostic("reply_connection_unavailable");
      return;
    }
    let sent = startChunk;
    try {
      for (let index = startChunk; index < chunks.length; index++) {
        if (this.stopped || !await this.ensureAuthoritative()) {
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
        if (!await this.ensureAuthoritative()) {
          await this.recordPartial(bindingId, messageId, sent);
          return;
        }
        await connection.sendReply({
          channelId,
          guildId,
          messageId,
          content: chunks[index]!,
          signal: this.abort.signal,
        });
        sent = index + 1;
        const recorded = await this.deps.dedupe.confirmChunk({
          bindingId,
          messageId,
          confirmedChunk: sent,
          now: this.deps.clock.now(),
        });
        if (!recorded) throw new Error("reply_state_failed");
        await this.recordInbox({
          recordId: `outgoing_${messageId}_${index}`,
          direction: "outgoing",
          bindingId,
          guildId,
          channelId,
          sourceMessageId: messageId,
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
        this.latestPartialConfirmedChunk = confirmedChunk;
      }
    } catch { /* fail closed */ }
  }
}
