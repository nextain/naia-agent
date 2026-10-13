// domain — Naia Studio voice profile schema + consent gate (순수, 외부 의존 없음).
//
// alpha-adk #47 / #48 (FE-NS-003/004, REQ-NS-004/005/013).
// 스키마·검증기 코드 소유는 naia-agent. naia-settings / gateway 는 데이터 인스턴스만.
// NVA/VRM 캐릭터 표현 manifest 와 타입을 섞지 않는다. 대용량 음성 bytes 금지.

export type VoiceConsentStatus = "pending" | "granted" | "denied" | "revoked" | "expired";

export type VoiceDerivativePolicy = "keep" | "hide" | "delete";

export type VoiceUsageScope = "singing" | "preview" | "tts" | "research";

export interface VoiceConsent {
  status: VoiceConsentStatus;
  /** 허용 사용 범위. 생성 요청 scope 는 이 집합의 부분집합이어야 한다. */
  scope: VoiceUsageScope[];
  recordedAt: string;
  revokedAt?: string;
  expiresAt?: string;
}

export interface VoiceProfile {
  id: string;
  displayName: string;
  /** opaque 미리듣기 참조 — 포맷/경로를 사용자 필수 지식으로 요구하지 않음. */
  previewRef: string;
  consent: VoiceConsent;
  /** 어디서 왔는지 (예: "gateway-ref-audio-presets", "user-upload"). */
  provenance: string;
  /** 권리 주체 식별자 (계정/인물). */
  subject: string;
  usageScope: VoiceUsageScope[];
  /** opaque storage key — 절대경로·`..` 금지. */
  storageLocator: string;
  derivativePolicy: VoiceDerivativePolicy;
}

export type VoiceGateCode =
  | "ok"
  | "voice_profile_invalid"
  | "voice_consent_required"
  | "voice_consent_revoked"
  | "voice_consent_expired"
  | "voice_scope_mismatch"
  | "voice_type_mismatch";

export interface VoiceGateResult {
  ok: boolean;
  code: VoiceGateCode;
}

const CONSENT_STATUSES = new Set<VoiceConsentStatus>([
  "pending",
  "granted",
  "denied",
  "revoked",
  "expired",
]);

const USAGE_SCOPES = new Set<VoiceUsageScope>(["singing", "preview", "tts", "research"]);

const DERIVATIVE_POLICIES = new Set<VoiceDerivativePolicy>(["keep", "hide", "delete"]);

const NVA_SHAPE_KEYS = ["nva_version", "animations", "canvas"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`missing_or_empty:${field}`);
  }
  return value.trim();
}

function asUsageScopes(value: unknown, field: string): VoiceUsageScope[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`missing_or_empty:${field}`);
  }
  const out: VoiceUsageScope[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !USAGE_SCOPES.has(item as VoiceUsageScope)) {
      throw new Error(`invalid_scope:${field}`);
    }
    out.push(item as VoiceUsageScope);
  }
  return out;
}

/** 절대경로·부모 탈출·빈 locator 거부. 스키마는 opaque key만 허용. */
export function assertSafeStorageLocator(locator: string): void {
  const value = locator.trim();
  if (!value) throw new Error("missing_or_empty:storageLocator");
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error("absolute_storageLocator");
  }
  if (value.split(/[\\/]/).some((part) => part === "..")) {
    throw new Error("traversal_storageLocator");
  }
  if (value.includes("\0")) throw new Error("invalid_storageLocator");
}

/** NVA 캐릭터 manifest 형태면 true. */
export function looksLikeNvaManifest(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return NVA_SHAPE_KEYS.some((key) => key in value);
}

/**
 * 미지/부분 입력을 VoiceProfile 로 정규화. 실패 시 throw (호출자가 VoiceGateCode 로 매핑).
 * audio/bytes/wav/buffer 필드는 명시적으로 거부.
 */
export function normalizeVoiceProfile(value: unknown): VoiceProfile {
  if (looksLikeNvaManifest(value)) {
    throw new Error("nva_manifest_not_voice_profile");
  }
  if (!isPlainObject(value)) {
    throw new Error("not_object");
  }
  for (const banned of ["audio", "bytes", "wav", "buffer", "pcm", "samples"]) {
    if (banned in value) throw new Error(`forbidden_payload_field:${banned}`);
  }

  const consentRaw = value.consent;
  if (!isPlainObject(consentRaw)) throw new Error("missing_or_empty:consent");

  const status = consentRaw.status;
  if (typeof status !== "string" || !CONSENT_STATUSES.has(status as VoiceConsentStatus)) {
    throw new Error("invalid_consent_status");
  }

  const derivativePolicy = value.derivativePolicy;
  if (
    typeof derivativePolicy !== "string" ||
    !DERIVATIVE_POLICIES.has(derivativePolicy as VoiceDerivativePolicy)
  ) {
    throw new Error("invalid_derivative_policy");
  }

  const storageLocator = asNonEmptyString(value.storageLocator, "storageLocator");
  assertSafeStorageLocator(storageLocator);

  const consent: VoiceConsent = {
    status: status as VoiceConsentStatus,
    scope: asUsageScopes(consentRaw.scope, "consent.scope"),
    recordedAt: asNonEmptyString(consentRaw.recordedAt, "consent.recordedAt"),
  };
  if (consentRaw.revokedAt !== undefined) {
    consent.revokedAt = asNonEmptyString(consentRaw.revokedAt, "consent.revokedAt");
  }
  if (consentRaw.expiresAt !== undefined) {
    consent.expiresAt = asNonEmptyString(consentRaw.expiresAt, "consent.expiresAt");
  }

  return {
    id: asNonEmptyString(value.id, "id"),
    displayName: asNonEmptyString(value.displayName, "displayName"),
    previewRef: asNonEmptyString(value.previewRef, "previewRef"),
    consent,
    provenance: asNonEmptyString(value.provenance, "provenance"),
    subject: asNonEmptyString(value.subject, "subject"),
    usageScope: asUsageScopes(value.usageScope, "usageScope"),
    storageLocator,
    derivativePolicy: derivativePolicy as VoiceDerivativePolicy,
  };
}

function isExpired(expiresAt: string | undefined, nowMs: number): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return true;
  return t <= nowMs;
}

/**
 * 생성(또는 singing 사용) 직전 게이트.
 * @param requestedScopes 기본 ["singing"]
 */
export function assertVoiceUsableForGeneration(
  profile: VoiceProfile,
  requestedScopes: VoiceUsageScope[] = ["singing"],
  nowMs: number = Date.now(),
): VoiceGateResult {
  if (profile.consent.revokedAt || profile.consent.status === "revoked") {
    return { ok: false, code: "voice_consent_revoked" };
  }
  if (profile.consent.status === "expired" || isExpired(profile.consent.expiresAt, nowMs)) {
    return { ok: false, code: "voice_consent_expired" };
  }
  if (profile.consent.status !== "granted") {
    return { ok: false, code: "voice_consent_required" };
  }

  const allowed = new Set(profile.consent.scope);
  for (const scope of requestedScopes) {
    if (!allowed.has(scope)) {
      return { ok: false, code: "voice_scope_mismatch" };
    }
  }
  return { ok: true, code: "ok" };
}

/** normalize + gate 를 한 번에. NVA/스키마 오류는 voice_type_mismatch 또는 voice_profile_invalid. */
export function evaluateVoiceForGeneration(
  value: unknown,
  requestedScopes: VoiceUsageScope[] = ["singing"],
  nowMs: number = Date.now(),
): VoiceGateResult {
  try {
    const profile = normalizeVoiceProfile(value);
    return assertVoiceUsableForGeneration(profile, requestedScopes, nowMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "nva_manifest_not_voice_profile") {
      return { ok: false, code: "voice_type_mismatch" };
    }
    return { ok: false, code: "voice_profile_invalid" };
  }
}
