import type { DiagnosticLog } from "./uc1.js";
import type { CodingJobCourseLifecycleState } from "../domain/coding-job.js";

export interface DiscordGatewayMessage {
  readonly messageId: string;
  readonly guildId: string | null;
  readonly channelId: string;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly content: string;
  readonly mentionedUserIds: readonly string[];
  readonly replyToAuthorId?: string;
}

/**
 * Trusted metadata copied from an already-authorized Gateway message.  A
 * course command never receives a filesystem path, allowed-file list, prompt
 * history, or model output from Discord.
 */
export interface DiscordCourseCommand {
  readonly bindingId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly authorId: string;
  readonly task: string;
}

/** Host-owned course command handler. Returning true consumes the message. */
export interface DiscordCourseCommandPort {
  start(input: DiscordCourseCommand): boolean;
}

/**
 * Safe status envelope for a course command.  The lifecycle deliberately
 * contains no path, prompt, model output, job diagnostic, or token data.
 */
export interface DiscordCourseLifecycleDelivery {
  readonly bindingId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly state: CodingJobCourseLifecycleState;
}

export interface DiscordCourseStatusPort {
  /** false means delivery remains pending and the bridge must retry/recover. */
  send(input: DiscordCourseLifecycleDelivery): Promise<boolean>;
}

export type DiscordGatewayCloseCode =
  | "closed"
  | "reconnect_requested"
  | "auth_failed"
  | "intent_missing"
  | "intent_invalid"
  | "network_error";

export interface DiscordGatewayClose {
  readonly code: DiscordGatewayCloseCode;
  readonly retryable: boolean;
}

export interface DiscordGatewayConnection {
  readonly closed: Promise<DiscordGatewayClose>;
  sendReply(input: {
    readonly channelId: string;
    readonly guildId: string;
    readonly messageId: string;
    readonly content: string;
    readonly signal?: AbortSignal;
  }): Promise<string>;
  close(): void;
}

export interface DiscordGatewayHandlers {
  onReady(selfUserId: string): void;
  onMessage(message: DiscordGatewayMessage): void;
}

export interface DiscordGatewayPort {
  connect(
    token: string,
    handlers: DiscordGatewayHandlers,
    options?: { readonly signal?: AbortSignal },
  ): Promise<DiscordGatewayConnection>;
}

export interface DiscordBotTokenPort {
  load(): Promise<string | undefined>;
}

export interface DiscordInboxRecord {
  readonly recordId: string;
  readonly direction: "incoming" | "outgoing";
  readonly bindingId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly authorId?: string;
  readonly content: string;
  readonly createdAt: number;
}

export interface DiscordInboxPort {
  append(record: DiscordInboxRecord): Promise<boolean>;
}

export interface DiscordDedupePort {
  /** Reload the durable snapshot after standby becomes authoritative. */
  refresh?(): Promise<boolean>;
  reserve(input: {
    readonly bindingId: string;
    readonly messageId: string;
    readonly now: number;
  }): Promise<
    | { readonly decision: "process" }
    | { readonly decision: "resume_reply"; readonly chunks: readonly string[]; readonly nextChunk: number }
    | { readonly decision: "duplicate" }
  >;
  releaseReservation?(input: {
    readonly bindingId: string;
    readonly messageId: string;
    readonly now: number;
  }): Promise<boolean>;
  beginReply(input: {
    readonly bindingId: string;
    readonly messageId: string;
    readonly chunks: readonly string[];
    readonly now: number;
  }): Promise<boolean>;
  claimChunk(input: {
    readonly bindingId: string;
    readonly messageId: string;
    readonly nextChunk: number;
    readonly now: number;
  }): Promise<boolean>;
  confirmChunk(input: {
    readonly bindingId: string;
    readonly messageId: string;
    readonly confirmedChunk: number;
    readonly now: number;
  }): Promise<boolean>;
  complete(input: { readonly bindingId: string; readonly messageId: string; readonly now: number }): Promise<boolean>;
  partial(input: {
    readonly bindingId: string;
    readonly messageId: string;
    readonly confirmedChunk: number;
    readonly now: number;
  }): Promise<boolean>;
  /**
   * Reclaim an interrupted outbox reply without re-running ingress.  This is
   * intentionally separate from `reserve`: a normal inbound-message partial
   * remains terminal for deduplication, while a host-owned fixed lifecycle
   * message can be retried from its durable confirmed cursor.
   */
  resumePartialReply?(input: {
    readonly bindingId: string;
    readonly messageId: string;
    readonly chunks: readonly string[];
    readonly now: number;
  }): Promise<
    | { readonly decision: "resumed"; readonly nextChunk: number }
    | { readonly decision: "not_partial" }
    | { readonly decision: "failed" }
  >;
}

export interface DiscordFriendRegistrationPort {
  /** Reload claims before a standby generation becomes authoritative. */
  refresh?(): Promise<boolean>;
  isRegistered(input: { readonly bindingId: string; readonly userId: string }): Promise<boolean>;
  claim(input: {
    readonly bindingId: string;
    readonly userId: string;
    readonly code: string;
    readonly now: number;
  }): Promise<boolean>;
}

export interface DiscordRuntimeClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface DiscordRuntimeTextPort {
  emptyReply(): string;
  failureReply(): string;
  processingDisclosure(input: {
    readonly workload: string;
    readonly destination: string;
    readonly decision: string;
  }): string;
}

export interface DiscordIngressAuthorityPort {
  /** Re-read cross-process generation authority. Missing or invalid state is inactive. */
  isActive(): boolean;
}

export interface DiscordRuntimeDeps {
  readonly gateway: DiscordGatewayPort;
  readonly token: DiscordBotTokenPort;
  readonly dedupe: DiscordDedupePort;
  readonly registration?: DiscordFriendRegistrationPort;
  readonly inbox?: DiscordInboxPort;
  readonly authority?: DiscordIngressAuthorityPort;
  readonly clock: DiscordRuntimeClock;
  readonly text: DiscordRuntimeTextPort;
  readonly diag: DiagnosticLog;
  /** Optional explicit /course command route. It is evaluated only after normal Gateway authorization. */
  readonly courseCommand?: DiscordCourseCommandPort;
  readonly gracefulStopTimeoutMs?: number;
}
