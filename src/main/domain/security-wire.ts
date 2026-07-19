import type {
  ChatRequest,
  ProcessingDisclosure,
  WireErrorCode,
} from "./chat.js";

export type SecurityWireResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly requestId?: string; readonly error: { readonly code: WireErrorCode; readonly field: string } };

export interface TrustedBinding {
  readonly bindingId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly allowedUserIds: readonly string[];
  readonly processingProfileRef: string;
}

export interface SecurityWireContext {
  readonly trustedBinding?: TrustedBinding;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const OPAQUE = /^[A-Za-z0-9_-]+$/;
const SNOWFLAKE = /^\d+$/;
const DESTINATIONS = new Set(["local_device", "private_managed", "external_cloud"]);
const WORKLOADS = new Set(["main_llm", "sub_llm", "memory_llm", "embedding", "network_tool"]);
const DECISIONS = new Set(["allowed", "blocked", "confirmation_required"]);
const DISCLOSURE_FIELDS = new Set([
  "kind", "workload", "destination", "decision", "processingProfileRef", "provider", "model",
]);

function fail<T>(requestId: unknown, code: WireErrorCode, field: string): SecurityWireResult<T> {
  return bounded(requestId, 128)
    ? { ok: false, requestId, error: { code, field } }
    : { ok: false, error: { code, field } };
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() === value
    && value.length >= 1 && value.length <= max && !CONTROL.test(value);
}

function opaque(value: unknown): value is string {
  return bounded(value, 128) && OPAQUE.test(value);
}

export function validateSecurityWireRequest(
  value: unknown,
  context: SecurityWireContext = {},
): SecurityWireResult<ChatRequest> {
  if (!value || typeof value !== "object") return fail(undefined, "PROCESSING_PROFILE_REQUIRED", "processing.processingProfileRef");
  const request = value as Record<string, unknown>;
  const requestId = request.requestId;
  const processing = request.processing;
  const channel = request.channel;

  if (processing !== undefined) {
    if (!processing || typeof processing !== "object"
      || !opaque((processing as Record<string, unknown>).processingProfileRef)) {
      return fail(requestId, "WIRE_INVALID_ARGUMENT", "processing.processingProfileRef");
    }
    if (request.provider && typeof request.provider === "object") {
      const provider = request.provider as Record<string, unknown>;
      if (provider.apiKey !== undefined || provider.naiaKey !== undefined) {
        return fail(requestId, "WIRE_INVALID_ARGUMENT", "provider");
      }
    }
  }

  if (channel && typeof channel === "object" && (channel as Record<string, unknown>).kind === "discord") {
    const discord = channel as Record<string, unknown>;
    if (!processing || typeof processing !== "object") {
      return fail(requestId, "PROCESSING_PROFILE_REQUIRED", "processing.processingProfileRef");
    }
    const trusted = context.trustedBinding;
    if (!trusted) return fail(requestId, "WIRE_SCOPE_FORBIDDEN", "channel");
    if (!opaque(discord.bindingId)
      || !bounded(discord.guildId, 128) || !SNOWFLAKE.test(discord.guildId)
      || !bounded(discord.channelId, 128) || !SNOWFLAKE.test(discord.channelId)
      || !bounded(discord.userId, 128) || !SNOWFLAKE.test(discord.userId)
      || discord.bindingId !== trusted.bindingId
      || discord.guildId !== trusted.guildId
      || discord.channelId !== trusted.channelId
      || !trusted.allowedUserIds.includes(discord.userId)) {
      return fail(requestId, "WIRE_SCOPE_FORBIDDEN", "channel");
    }
    if ((processing as Record<string, unknown>).processingProfileRef !== trusted.processingProfileRef) {
      return fail(requestId, "WIRE_SCOPE_FORBIDDEN", "processing.processingProfileRef");
    }
  }
  return { ok: true, value: value as ChatRequest };
}

export function validateProcessingDisclosure(
  value: unknown,
): SecurityWireResult<{ readonly kind: "processingDisclosure" } & ProcessingDisclosure> {
  if (!value || typeof value !== "object") return fail(undefined, "WIRE_INVALID_ARGUMENT", "processingDisclosure");
  const event = value as Record<string, unknown>;
  if (Object.keys(event).some((field) => !DISCLOSURE_FIELDS.has(field))) {
    return fail(undefined, "WIRE_INVALID_ARGUMENT", "processingDisclosure");
  }
  if (event.kind !== "processingDisclosure") {
    return fail(undefined, "WIRE_INVALID_ARGUMENT", "processingDisclosure.kind");
  }
  if (!WORKLOADS.has(String(event.workload))
    || !DESTINATIONS.has(String(event.destination))
    || !DECISIONS.has(String(event.decision))) {
    return fail(undefined, "WIRE_UNSUPPORTED_ENUM", "processingDisclosure");
  }
  if (!opaque(event.processingProfileRef)
    || (event.provider !== undefined && !bounded(event.provider, 64))
    || (event.model !== undefined && !bounded(event.model, 256))) {
    return fail(undefined, "WIRE_INVALID_ARGUMENT", "processingDisclosure");
  }
  return { ok: true, value: value as { readonly kind: "processingDisclosure" } & ProcessingDisclosure };
}

export function planProcessingOperation(value: unknown): SecurityWireResult<{
  readonly disclosure: { readonly kind: "processingDisclosure" } & ProcessingDisclosure;
  readonly steps: readonly ["processing_disclosure", "downstream"] | readonly ["processing_disclosure", "error"];
  readonly errorCode?: "EXTERNAL_PROCESSING_FORBIDDEN" | "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED";
}> {
  const checked = validateProcessingDisclosure(value);
  if (!checked.ok) return checked;
  if (checked.value.decision === "allowed") {
    return { ok: true, value: { disclosure: checked.value, steps: ["processing_disclosure", "downstream"] } };
  }
  return {
    ok: true,
    value: {
      disclosure: checked.value,
      steps: ["processing_disclosure", "error"],
      errorCode: checked.value.decision === "blocked"
        ? "EXTERNAL_PROCESSING_FORBIDDEN"
        : "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED",
    },
  };
}

export interface TrustedConsentRecord {
  readonly consentId: string;
  readonly processingProfileRef: string;
  readonly destination: ProcessingDisclosure["destination"];
  readonly workload: ProcessingDisclosure["workload"];
  readonly sessionId: string;
  readonly expiresAt: number;
  readonly consumedAt?: number;
}

export function validateAndClaimConsent(
  disclosure: unknown,
  context: {
    readonly sessionId: string;
    readonly now: number;
    readonly consent?: TrustedConsentRecord;
    /** Trusted store must atomically claim by opaque ID, never by object identity. */
    readonly claim: (consentId: string) => boolean;
  },
): SecurityWireResult<TrustedConsentRecord> {
  const checked = validateProcessingDisclosure(disclosure);
  if (!checked.ok) return checked as SecurityWireResult<TrustedConsentRecord>;
  const consent = context.consent;
  if (!consent || !opaque(consent.consentId) || consent.consumedAt !== undefined
    || !Number.isSafeInteger(context.now) || context.now < 0
    || !Number.isSafeInteger(consent.expiresAt) || consent.expiresAt < 0
    || consent.expiresAt <= context.now
    || consent.processingProfileRef !== checked.value.processingProfileRef
    || consent.destination !== checked.value.destination
    || consent.workload !== checked.value.workload
    || consent.sessionId !== context.sessionId
    || !context.claim(consent.consentId)) {
    return fail(undefined, "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED", "consent");
  }
  return { ok: true, value: consent };
}
