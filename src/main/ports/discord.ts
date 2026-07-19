import type { DiagnosticLog } from "./uc1.js";

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
  }): Promise<void>;
  close(): void;
}

export interface DiscordGatewayHandlers {
  onReady(selfUserId: string): void;
  onMessage(message: DiscordGatewayMessage): void;
}

export interface DiscordGatewayPort {
  connect(token: string, handlers: DiscordGatewayHandlers): Promise<DiscordGatewayConnection>;
}

export interface DiscordBotTokenPort {
  load(): Promise<string | undefined>;
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
  readonly authority?: DiscordIngressAuthorityPort;
  readonly clock: DiscordRuntimeClock;
  readonly text: DiscordRuntimeTextPort;
  readonly diag: DiagnosticLog;
}
