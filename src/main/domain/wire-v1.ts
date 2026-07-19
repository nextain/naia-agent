import type {
  ChatRequest, EffectiveLlmConfig, GroundingSource, ImageArtifact, ProcessingDisclosure, WireErrorCode,
} from "./chat.js";

export type WireValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly requestId?: string; readonly error: { readonly code: WireErrorCode; readonly field: string } };

export interface TrustedBinding {
  readonly bindingId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly allowedUserIds: readonly string[];
  readonly knowledgeScope: string;
  readonly processingProfileRef: string;
}
export interface ProviderSessionRecord {
  readonly providerSessionRef: string;
  readonly workspace: string;
  readonly sessionId: string;
  readonly channel: unknown;
  readonly provider: string;
  readonly model: string;
  readonly credentialGeneration: number;
  readonly lastSuccessfulUseAt: number;
  readonly closed: boolean;
}
export interface WireValidationContext {
  readonly trustedBinding?: TrustedBinding;
  readonly allowedKnowledgeScopes?: readonly string[];
  readonly workspace?: string;
  readonly provider?: string | (() => void);
  readonly model?: string;
  readonly credentialGeneration?: number;
  readonly now?: number;
  readonly providerSessionRecord?: ProviderSessionRecord;
  readonly providerSessionLookup?: ProviderSessionLookup;
}

const PROVIDER_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function canonicalChannel(channel: unknown): string | undefined {
  if (channel === undefined) return "none";
  if (!channel || typeof channel !== "object") return undefined;
  const value = channel as Record<string, unknown>;
  if (value.kind === "shell") return "shell";
  if (value.kind === "discord"
    && typeof value.bindingId === "string" && typeof value.guildId === "string"
    && typeof value.channelId === "string" && typeof value.userId === "string") {
    return `discord\0${value.bindingId}\0${value.guildId}\0${value.channelId}\0${value.userId}`;
  }
  return undefined;
}

export interface ProviderSessionBinding {
  readonly workspace: string;
  readonly sessionId: string;
  readonly channel: unknown;
  readonly provider: string;
  readonly model: string;
  readonly credentialGeneration: number;
}
export type ProviderSessionLookup =
  | { readonly state: "active"; readonly record: ProviderSessionRecord }
  | { readonly state: "expired" | "closed" | "missing" };
export interface ProviderSessionStorePort {
  start(binding: ProviderSessionBinding): ProviderSessionRecord;
  get(providerSessionRef: string): ProviderSessionRecord | undefined;
  lookup(providerSessionRef: string, now?: number): ProviderSessionLookup;
  resume(providerSessionRef: string, binding: ProviderSessionBinding, now?: number): WireValidationResult<ProviderSessionRecord>;
  markSuccessful(providerSessionRef: string, now?: number): void;
  abandon(providerSessionRef: string): void;
  close(providerSessionRef: string): void;
}

export function makeInMemoryProviderSessionStore(opts: {
  readonly now?: () => number;
  readonly randomRef?: () => string;
  readonly maxRecords?: number;
} = {}): ProviderSessionStorePort {
  const records = new Map<string, ProviderSessionRecord>();
  const activated = new Set<string>();
  const tombstones = new Map<string, "closed" | "expired">();
  const now = opts.now ?? (() => Date.now());
  const randomRef = opts.randomRef ?? (() => `ps_${globalThis.crypto.randomUUID().replaceAll("-", "")}`);
  const maxRecords = Math.max(1, Math.floor(opts.maxRecords ?? 1024));
  const rememberTombstone = (providerSessionRef: string, state: "closed" | "expired") => {
    tombstones.delete(providerSessionRef);
    tombstones.set(providerSessionRef, state);
    while (tombstones.size > maxRecords) tombstones.delete(tombstones.keys().next().value!);
  };
  const removeRecord = (providerSessionRef: string, tombstone?: "closed" | "expired") => {
    records.delete(providerSessionRef);
    activated.delete(providerSessionRef);
    if (tombstone) rememberTombstone(providerSessionRef, tombstone);
  };
  const expired = (record: ProviderSessionRecord, at: number) =>
    at - record.lastSuccessfulUseAt > PROVIDER_SESSION_TTL_MS;
  const sweep = (at: number) => {
    for (const [providerSessionRef, record] of records) {
      if (record.closed) removeRecord(providerSessionRef, "closed");
      else if (expired(record, at)) removeRecord(providerSessionRef, "expired");
    }
  };
  const makeRoom = () => {
    while (records.size >= maxRecords) {
      const oldest = records.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      removeRecord(oldest);
    }
  };
  const matches = (record: ProviderSessionRecord, binding: ProviderSessionBinding) =>
    record.workspace === binding.workspace
    && record.sessionId === binding.sessionId
    && canonicalChannel(record.channel) !== undefined
    && canonicalChannel(record.channel) === canonicalChannel(binding.channel)
    && record.provider === binding.provider
    && record.model === binding.model
    && record.credentialGeneration === binding.credentialGeneration;
  return {
    start(binding) {
      sweep(now());
      makeRoom();
      let providerSessionRef = randomRef();
      while (!opaque(providerSessionRef) || records.has(providerSessionRef)) providerSessionRef = randomRef();
      tombstones.delete(providerSessionRef);
      const record: ProviderSessionRecord = {
        providerSessionRef, ...binding, lastSuccessfulUseAt: now(), closed: false,
      };
      records.set(providerSessionRef, record);
      return record;
    },
    get(providerSessionRef) {
      const record = records.get(providerSessionRef);
      if (!record || !activated.has(providerSessionRef)) return undefined;
      if (expired(record, now())) { removeRecord(providerSessionRef, "expired"); return undefined; }
      return record;
    },
    lookup(providerSessionRef, at = now()) {
      const record = records.get(providerSessionRef);
      if (record && activated.has(providerSessionRef)) {
        if (record.closed) { removeRecord(providerSessionRef, "closed"); return { state: "closed" }; }
        if (expired(record, at)) { removeRecord(providerSessionRef, "expired"); return { state: "expired" }; }
        return { state: "active", record };
      }
      const tombstone = tombstones.get(providerSessionRef);
      return { state: tombstone ?? "missing" };
    },
    resume(providerSessionRef, binding, at = now()) {
      const record = records.get(providerSessionRef);
      if (!record || !activated.has(providerSessionRef)) {
        const tombstone = tombstones.get(providerSessionRef);
        return fail(undefined, tombstone === "closed" ? "PROVIDER_SESSION_CLOSED"
          : tombstone === "expired" ? "PROVIDER_SESSION_EXPIRED" : "PROVIDER_SESSION_MISMATCH", "providerSession.providerSessionRef");
      }
      if (record.closed) { removeRecord(providerSessionRef, "closed"); return fail(undefined, "PROVIDER_SESSION_CLOSED", "providerSession.providerSessionRef"); }
      if (expired(record, at)) { removeRecord(providerSessionRef, "expired"); return fail(undefined, "PROVIDER_SESSION_EXPIRED", "providerSession.providerSessionRef"); }
      if (!matches(record, binding)) return fail(undefined, "PROVIDER_SESSION_MISMATCH", "providerSession.providerSessionRef");
      return { ok: true, value: record };
    },
    markSuccessful(providerSessionRef, at = now()) {
      const record = records.get(providerSessionRef);
      if (record && !record.closed) {
        if (expired(record, at)) { removeRecord(providerSessionRef, "expired"); return; }
        records.set(providerSessionRef, { ...record, lastSuccessfulUseAt: at });
        activated.add(providerSessionRef);
      }
    },
    abandon(providerSessionRef) {
      removeRecord(providerSessionRef);
      tombstones.delete(providerSessionRef);
    },
    close(providerSessionRef) {
      removeRecord(providerSessionRef, "closed");
    },
  };
}

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;
const OPAQUE = /^[A-Za-z0-9_-]+$/;
const SNOWFLAKE = /^\d+$/;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const ROLES = ["main", "sub", "memory"] as const;
const PROVENANCE = new Set(["explicit", "inherit", "legacy-inherit", "default"]);
const PROCESSING_DESTINATIONS = new Set(["local_device", "private_managed", "external_cloud"]);
const PROCESSING_WORKLOADS = new Set(["main_llm", "sub_llm", "memory_llm", "embedding", "network_tool"]);
const PROCESSING_DECISIONS = new Set(["allowed", "blocked", "confirmation_required"]);

function fail<T>(requestId: unknown, code: WireErrorCode, field: string): WireValidationResult<T> {
  return typeof requestId === "string" && requestId.length > 0 && requestId.length <= 128 && !CONTROL.test(requestId)
    ? { ok: false, requestId, error: { code, field } }
    : { ok: false, error: { code, field } };
}
function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length >= 1 && value.length <= max && !CONTROL.test(value);
}
function opaque(value: unknown, max = 128): value is string {
  return boundedString(value, max) && OPAQUE.test(value) && !/^(?:iVBOR|UklGR|base64)/i.test(value);
}
function validateAttachment(value: unknown, field: string, requestId?: string): WireValidationResult<unknown> {
  if (!value || typeof value !== "object") return fail(requestId, "WIRE_INVALID_ARGUMENT", field);
  const a = value as Record<string, unknown>;
  if (a.kind !== "image") return fail(requestId, "WIRE_INVALID_ARGUMENT", `${field}.kind`);
  if (!IMAGE_MIMES.has(String(a.mimeType))) return fail(requestId, "ATTACHMENT_UNSUPPORTED_TYPE", `${field}.mimeType`);
  if (!Number.isInteger(a.sizeBytes) || Number(a.sizeBytes) < 1) return fail(requestId, "WIRE_INVALID_ARGUMENT", `${field}.sizeBytes`);
  if (Number(a.sizeBytes) > MAX_IMAGE_BYTES) return fail(requestId, "ATTACHMENT_TOO_LARGE", `${field}.sizeBytes`);
  if (!opaque(a.id) || !opaque(a.localRef)) return fail(requestId, "ATTACHMENT_INVALID_REF", !opaque(a.id) ? `${field}.id` : `${field}.localRef`);
  return { ok: true, value };
}

function validateWireChatRequestUnsafe(value: unknown, context: WireValidationContext): WireValidationResult<ChatRequest> {
  if (!value || typeof value !== "object") return fail(undefined, "WIRE_INVALID_ARGUMENT", "$");
  const r = value as Record<string, unknown>;
  const requestId = r.requestId;
  if (!boundedString(requestId, 128)) return fail(undefined, "WIRE_INVALID_ARGUMENT", "requestId");
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_REQUEST_BYTES) return fail(requestId, "WIRE_INVALID_ARGUMENT", "$");
  if (!Array.isArray(r.messages)) return fail(requestId, "WIRE_INVALID_ARGUMENT", "messages");
  const hasWireV1Fields = r.channel !== undefined || r.grounding !== undefined || r.providerSession !== undefined
    || r.processing !== undefined
    || r.messages.some((message) => !!message && typeof message === "object" && (message as Record<string, unknown>).attachments !== undefined);
  if (hasWireV1Fields && r.provider && typeof r.provider === "object") {
    const provider = r.provider as Record<string, unknown>;
    if (provider.apiKey !== undefined || provider.naiaKey !== undefined) return fail(requestId, "WIRE_INVALID_ARGUMENT", "provider");
  }
  const attachmentIds = new Set<string>();
  let attachmentCount = 0;
  for (let i = 0; i < r.messages.length; i++) {
    const msg = r.messages[i] as Record<string, unknown>;
    if (!msg || typeof msg !== "object") return fail(requestId, "WIRE_INVALID_ARGUMENT", `messages[${i}]`);
    if (msg.attachments !== undefined) {
      if (msg.role !== "user" || !Array.isArray(msg.attachments)) return fail(requestId, "WIRE_INVALID_ARGUMENT", `messages[${i}].attachments`);
      attachmentCount += msg.attachments.length;
      if (attachmentCount > 8) return fail(requestId, "WIRE_INVALID_ARGUMENT", `messages[${i}].attachments`);
      for (let j = 0; j < msg.attachments.length; j++) {
        const checked = validateAttachment(msg.attachments[j], `messages[${i}].attachments[${j}]`, requestId);
        if (!checked.ok) return checked as WireValidationResult<ChatRequest>;
        const id = (msg.attachments[j] as { id: string }).id;
        if (attachmentIds.has(id)) return fail(requestId, "WIRE_INVALID_ARGUMENT", `messages[${i}].attachments[${j}].id`);
        attachmentIds.add(id);
      }
    }
  }
  const channel = r.channel === undefined ? undefined : r.channel;
  const grounding = r.grounding === undefined ? undefined : r.grounding;
  const processing = r.processing === undefined ? undefined : r.processing;
  if (processing !== undefined) {
    if (!processing || typeof processing !== "object") {
      return fail(requestId, "WIRE_INVALID_ARGUMENT", "processing");
    }
    const processingKeys = Reflect.ownKeys(processing);
    if (processingKeys.length !== 1 || processingKeys[0] !== "processingProfileRef"
      || !opaque((processing as Record<string, unknown>).processingProfileRef)) {
      return fail(requestId, "WIRE_INVALID_ARGUMENT", "processing.processingProfileRef");
    }
  }
  if (grounding !== undefined) {
    if (!grounding || typeof grounding !== "object") return fail(requestId, "WIRE_INVALID_ARGUMENT", "grounding");
    const groundingRecord = grounding as Record<string, unknown>;
    if (!channel) return fail(requestId, "WIRE_INVALID_ARGUMENT", "channel");
    if (!new Set(["off", "available", "required"]).has(String(groundingRecord.policy))) return fail(requestId, "WIRE_UNSUPPORTED_ENUM", "grounding.policy");
    if (!boundedString(groundingRecord.knowledgeScope, 128)) return fail(requestId, "WIRE_INVALID_ARGUMENT", "grounding.knowledgeScope");
  }
  if (channel !== undefined) {
    if (!channel || typeof channel !== "object") return fail(requestId, "WIRE_INVALID_ARGUMENT", "channel");
    const channelRecord = channel as Record<string, unknown>;
    if (channelRecord.kind !== "shell" && channelRecord.kind !== "discord") return fail(requestId, "WIRE_UNSUPPORTED_ENUM", "channel.kind");
    if (channelRecord.kind === "discord") {
      if (!opaque(channelRecord.bindingId)) return fail(requestId, "WIRE_INVALID_ARGUMENT", "channel.bindingId");
      for (const field of ["guildId", "channelId", "userId"] as const) {
        if (!boundedString(channelRecord[field], 128) || !SNOWFLAKE.test(String(channelRecord[field]))) return fail(requestId, "WIRE_INVALID_ARGUMENT", `channel.${field}`);
      }
      const trusted = context.trustedBinding;
      if (processing === undefined) return fail(requestId, "PROCESSING_PROFILE_REQUIRED", "processing.processingProfileRef");
      if (!trusted) return fail(requestId, "WIRE_SCOPE_FORBIDDEN", "channel");
      if ((processing as Record<string, unknown>).processingProfileRef !== trusted.processingProfileRef) {
        return fail(requestId, "WIRE_SCOPE_FORBIDDEN", "processing.processingProfileRef");
      }
      if (
        channelRecord.bindingId !== trusted.bindingId || channelRecord.guildId !== trusted.guildId
        || channelRecord.channelId !== trusted.channelId || !trusted.allowedUserIds.includes(String(channelRecord.userId))
        || (grounding !== undefined && (grounding as Record<string, unknown>).knowledgeScope !== trusted.knowledgeScope)
      ) return fail(requestId, "WIRE_SCOPE_FORBIDDEN", "channel");
    } else if (grounding !== undefined) {
      const scope = String((grounding as Record<string, unknown>).knowledgeScope);
      if (!context.allowedKnowledgeScopes?.includes(scope)) return fail(requestId, "WIRE_SCOPE_FORBIDDEN", "grounding.knowledgeScope");
    }
  }
  const providerSession = r.providerSession === undefined ? undefined : r.providerSession;
  if (providerSession !== undefined) {
    if (!providerSession || typeof providerSession !== "object") return fail(requestId, "WIRE_INVALID_ARGUMENT", "providerSession");
    const providerSessionRecord = providerSession as Record<string, unknown>;
    if (!boundedString(r.sessionId, 128)) return fail(requestId, "WIRE_INVALID_ARGUMENT", "sessionId");
    if (providerSessionRecord.mode !== "new" && providerSessionRecord.mode !== "resume") return fail(requestId, "WIRE_UNSUPPORTED_ENUM", "providerSession.mode");
    if (providerSessionRecord.mode === "resume" && !opaque(providerSessionRecord.providerSessionRef)) return fail(requestId, "PROVIDER_SESSION_MISMATCH", "providerSession.providerSessionRef");
    const lookup = context.providerSessionLookup;
    if (lookup?.state === "expired") return fail(requestId, "PROVIDER_SESSION_EXPIRED", "providerSession.providerSessionRef");
    if (lookup?.state === "closed") return fail(requestId, "PROVIDER_SESSION_CLOSED", "providerSession.providerSessionRef");
    if (lookup?.state === "missing") return fail(requestId, "PROVIDER_SESSION_MISMATCH", "providerSession.providerSessionRef");
    const record = lookup?.state === "active" ? lookup.record : context.providerSessionRecord;
    if (providerSessionRecord.mode === "resume" && !record) return fail(requestId, "PROVIDER_SESSION_MISMATCH", "providerSession.providerSessionRef");
    if (providerSessionRecord.mode === "resume" && record) {
      if (record.closed) return fail(requestId, "PROVIDER_SESSION_CLOSED", "providerSession.providerSessionRef");
      if (!lookup && (context.now ?? Date.now()) - record.lastSuccessfulUseAt > PROVIDER_SESSION_TTL_MS) return fail(requestId, "PROVIDER_SESSION_EXPIRED", "providerSession.providerSessionRef");
      const provider = typeof context.provider === "string" ? context.provider : undefined;
      if (record.providerSessionRef !== providerSessionRecord.providerSessionRef || record.workspace !== context.workspace
        || record.sessionId !== r.sessionId || canonicalChannel(record.channel) === undefined
        || canonicalChannel(record.channel) !== canonicalChannel(channel)
        || (provider !== undefined && record.provider !== provider) || record.model !== context.model
        || record.credentialGeneration !== context.credentialGeneration) {
        return fail(requestId, "PROVIDER_SESSION_MISMATCH", "providerSession.providerSessionRef");
      }
    }
  }
  return { ok: true, value: value as ChatRequest };
}

export function validateWireChatRequest(value: unknown, context: WireValidationContext = {}): WireValidationResult<ChatRequest> {
  try { return validateWireChatRequestUnsafe(value, context); }
  catch { return fail(undefined, "WIRE_INVALID_ARGUMENT", "$"); }
}

const PROCESSING_DISCLOSURE_FIELDS = new Set([
  "kind", "workload", "destination", "decision", "processingProfileRef", "provider", "model",
]);

function validEffectiveLabel(value: unknown, kind: "provider" | "model"): value is string {
  const max = kind === "provider" ? 64 : 256;
  if (!boundedString(value, max)) return false;
  const label = value;
  const syntax = kind === "provider"
    ? /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
    : /^[A-Za-z0-9][A-Za-z0-9._+:/-]*$/;
  if (!syntax.test(label) || label.includes("://") || label.includes("//") || label.includes("..")) return false;
  return !/^(?:sk|pk|api[_-]?key|token|bearer|secret|password)[._:+/-]/i.test(label);
}

function validateProcessingDisclosureEventUnsafe(
  value: unknown,
): WireValidationResult<{ readonly kind: "processingDisclosure" } & ProcessingDisclosure> {
  if (!value || typeof value !== "object") return fail(undefined, "WIRE_INVALID_ARGUMENT", "processingDisclosure");
  const event = value as Record<string, unknown>;
  if (Reflect.ownKeys(event).some((field) => typeof field !== "string" || !PROCESSING_DISCLOSURE_FIELDS.has(field))) return fail(undefined, "WIRE_INVALID_ARGUMENT", "processingDisclosure");
  if (event.kind !== "processingDisclosure") return fail(undefined, "WIRE_INVALID_ARGUMENT", "processingDisclosure.kind");
  if (!PROCESSING_WORKLOADS.has(String(event.workload))) return fail(undefined, "WIRE_UNSUPPORTED_ENUM", "processingDisclosure.workload");
  if (!PROCESSING_DESTINATIONS.has(String(event.destination))) return fail(undefined, "WIRE_UNSUPPORTED_ENUM", "processingDisclosure.destination");
  if (!PROCESSING_DECISIONS.has(String(event.decision))) return fail(undefined, "WIRE_UNSUPPORTED_ENUM", "processingDisclosure.decision");
  if (!opaque(event.processingProfileRef)) return fail(undefined, "WIRE_INVALID_ARGUMENT", "processingDisclosure.processingProfileRef");
  if (event.provider !== undefined && !validEffectiveLabel(event.provider, "provider")) return fail(undefined, "WIRE_INVALID_ARGUMENT", "processingDisclosure.provider");
  if (event.model !== undefined && !validEffectiveLabel(event.model, "model")) return fail(undefined, "WIRE_INVALID_ARGUMENT", "processingDisclosure.model");
  return { ok: true, value: value as { readonly kind: "processingDisclosure" } & ProcessingDisclosure };
}

export function validateProcessingDisclosureEvent(
  value: unknown,
): WireValidationResult<{ readonly kind: "processingDisclosure" } & ProcessingDisclosure> {
  try { return validateProcessingDisclosureEventUnsafe(value); }
  catch { return fail(undefined, "WIRE_INVALID_ARGUMENT", "processingDisclosure"); }
}

export type ProcessingOperationPlan = {
  readonly disclosure: { readonly kind: "processingDisclosure" } & ProcessingDisclosure;
  readonly steps: readonly ["processing_disclosure", "downstream"] | readonly ["processing_disclosure", "error"];
  readonly errorCode?: "EXTERNAL_PROCESSING_FORBIDDEN" | "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED";
};

export function planProcessingOperation(value: unknown): WireValidationResult<ProcessingOperationPlan> {
  const checked = validateProcessingDisclosureEvent(value);
  if (!checked.ok) return checked;
  if (checked.value.decision === "allowed") return { ok: true, value: { disclosure: checked.value, steps: ["processing_disclosure", "downstream"] } };
  return {
    ok: true,
    value: {
      disclosure: checked.value,
      steps: ["processing_disclosure", "error"],
      errorCode: checked.value.decision === "blocked" ? "EXTERNAL_PROCESSING_FORBIDDEN" : "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED",
    },
  };
}

export interface TrustedConsentRecord {
  readonly consentId: string;
  readonly scope: string;
  readonly processingProfileRef: string;
  readonly destination: ProcessingDisclosure["destination"];
  readonly workload: ProcessingDisclosure["workload"];
  readonly sessionId: string;
  readonly expiresAt: number;
  readonly consumedAt?: number;
}
export interface TrustedConsentContext {
  readonly scope: string;
  readonly sessionId: string;
  readonly now: number;
  readonly consent?: TrustedConsentRecord;
  /** consentId를 원자적으로 미소비→소비 전환하는 compare-and-set. 동일 ID는 정확히 한 번만 true. */
  readonly claim: (consentId: string) => boolean;
}
export function validateTrustedConsent(disclosure: unknown, context: TrustedConsentContext): WireValidationResult<TrustedConsentRecord> {
  const checked = validateProcessingDisclosureEvent(disclosure);
  if (!checked.ok) return checked as WireValidationResult<TrustedConsentRecord>;
  const consent = context.consent;
  if (!consent || !opaque(consent.consentId) || !opaque(consent.scope)
    || !Number.isFinite(context.now) || !Number.isFinite(consent.expiresAt)
    || consent.consumedAt !== undefined || consent.expiresAt <= context.now
    || consent.scope !== context.scope
    || consent.sessionId !== context.sessionId || consent.processingProfileRef !== checked.value.processingProfileRef
    || consent.destination !== checked.value.destination || consent.workload !== checked.value.workload
    || !context.claim(consent.consentId)) {
    return fail(undefined, "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED", "consent");
  }
  return { ok: true, value: consent };
}

function validResolved(value: unknown, roleField: string): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const validValue = roleField === "credentialRef" ? opaque(v.value) : boundedString(v.value, roleField === "model" ? 256 : 64);
  if (!validValue || !PROVENANCE.has(String(v.provenance))) return false;
  const inherited = v.provenance === "inherit" || v.provenance === "legacy-inherit";
  return inherited ? ROLES.includes(v.inheritedFromRole as typeof ROLES[number]) : v.inheritedFromRole === undefined;
}
export function validateEffectiveLlmConfigs(value: unknown): WireValidationResult<readonly EffectiveLlmConfig[]> {
  if (!Array.isArray(value) || value.length !== 3 || value.some((v, i) => !v || typeof v !== "object" || (v as { role?: unknown }).role !== ROLES[i])) {
    return fail(undefined, "WIRE_INVALID_ARGUMENT", "effectiveLlmConfigs");
  }
  for (const config of value as unknown as Record<string, unknown>[]) {
    if (!validResolved(config.provider, "provider") || !validResolved(config.model, "model")
      || (config.credentialRef !== undefined && !validResolved(config.credentialRef, "credentialRef"))) {
      return fail(undefined, "WIRE_INVALID_ARGUMENT", "effectiveLlmConfigs");
    }
  }
  return { ok: true, value: value as unknown as readonly EffectiveLlmConfig[] };
}

function validSource(source: unknown, channel: unknown): source is GroundingSource {
  if (!source || typeof source !== "object") return false;
  const candidate = source as { title?: unknown; sourceUris?: unknown };
  if (!boundedString(candidate.title, 256) || !Array.isArray(candidate.sourceUris)
    || candidate.sourceUris.length < 1 || candidate.sourceUris.length > 8) return false;
  const seen = new Set<string>();
  for (const raw of candidate.sourceUris) {
    if (!boundedString(raw, 2048)) return false;
    if (seen.has(raw)) continue;
    seen.add(raw);
    let url: URL;
    try { url = new URL(raw); } catch { return false; }
    const scheme = url.protocol.slice(0, -1);
    if (!["https", "http", "kb", "naia", "file"].includes(scheme) || (scheme === "file" && (channel as { kind?: string } | undefined)?.kind !== "shell")) return false;
    if (url.username || url.password || ["data", "javascript"].includes(scheme)) return false;
    for (const key of url.searchParams.keys()) if (/token|key|signature|auth/i.test(key)) return false;
  }
  return seen.size > 0;
}
export function validateGroundingEvent(value: unknown, channel?: unknown): WireValidationResult<unknown> {
  if (!value || typeof value !== "object") return fail(undefined, "WIRE_INVALID_ARGUMENT", "grounding");
  const e = value as { status?: unknown; sources?: unknown };
  if (!new Set(["grounded", "no_evidence", "uncompiled", "unavailable"]).has(String(e.status)) || !Array.isArray(e.sources) || e.sources.length > 16) return fail(undefined, "WIRE_INVALID_ARGUMENT", "grounding");
  if ((e.status === "grounded") !== (e.sources.length > 0) || e.sources.some((source) => !validSource(source as GroundingSource, channel))) return fail(undefined, "WIRE_INVALID_ARGUMENT", "grounding");
  return {
    ok: true,
    value: {
      ...(value as Record<string, unknown>),
      sources: (e.sources as GroundingSource[]).map((source) => ({
        ...source,
        sourceUris: [...new Set(source.sourceUris)],
      })),
    },
  };
}

export function validateImageArtifact(value: ImageArtifact): WireValidationResult<ImageArtifact> {
  const checked = validateAttachment(value, "artifact");
  if (!checked.ok) return checked as WireValidationResult<ImageArtifact>;
  if (value.name !== undefined && !boundedString(value.name, 256)) return fail(undefined, "WIRE_INVALID_ARGUMENT", "artifact.name");
  return { ok: true, value };
}

export function validateProviderSessionEvent(value: unknown): WireValidationResult<unknown> {
  if (!value || typeof value !== "object") return fail(undefined, "WIRE_INVALID_ARGUMENT", "providerSession");
  const e = value as Record<string, unknown>;
  if (e.kind !== "providerSession" || !boundedString(e.sessionId, 128) || !opaque(e.providerSessionRef)
    || !new Set(["started", "resumed", "closed"]).has(String(e.state))) {
    return fail(undefined, "WIRE_INVALID_ARGUMENT", "providerSession");
  }
  return { ok: true, value };
}
