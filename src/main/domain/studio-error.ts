// domain — UserFacingError for Studio (FE-NS-012 / REQ-NS-010)

export type StudioErrorCode =
  | "voice_consent_required"
  | "voice_consent_revoked"
  | "voice_consent_expired"
  | "voice_scope_mismatch"
  | "voice_type_mismatch"
  | "voice_profile_invalid"
  | "capability_denied"
  | "preview_unsupported"
  | "segment_edit_unsupported"
  | "job_failed"
  | "job_cancelled"
  | "unsupported_change"
  | "internal_error";

const I18N_KEYS: Record<StudioErrorCode, string> = {
  voice_consent_required: "studio.error.voice_consent_required",
  voice_consent_revoked: "studio.error.voice_consent_revoked",
  voice_consent_expired: "studio.error.voice_consent_expired",
  voice_scope_mismatch: "studio.error.voice_scope_mismatch",
  voice_type_mismatch: "studio.error.voice_type_mismatch",
  voice_profile_invalid: "studio.error.voice_profile_invalid",
  capability_denied: "studio.error.capability_denied",
  preview_unsupported: "studio.error.preview_unsupported",
  segment_edit_unsupported: "studio.error.segment_edit_unsupported",
  job_failed: "studio.error.job_failed",
  job_cancelled: "studio.error.job_cancelled",
  unsupported_change: "studio.error.unsupported_change",
  internal_error: "studio.error.internal_error",
};

export interface UserFacingError {
  code: StudioErrorCode;
  i18nKey: string;
  alternatives: string[];
  retryable: boolean;
  correlationId: string;
}

const MODEL_SLUG_RE = /tcsinger|dskr|rvc|diffsinger|sovits|soulx/i;

export function toUserFacingError(
  code: StudioErrorCode,
  correlationId: string,
  alternatives: string[] = [],
  retryable = false,
): UserFacingError {
  if (!correlationId) throw new Error("correlationId_required");
  return {
    code,
    i18nKey: I18N_KEYS[code],
    alternatives,
    retryable,
    correlationId,
  };
}

/** Strip model/algorithm names from an internal message when mapping errors. */
export function sanitizeInternalMessage(message: string): string {
  return message.replace(MODEL_SLUG_RE, "[engine]");
}

export function mapVoiceGateCode(
  code: string,
  correlationId: string,
): UserFacingError {
  const known: StudioErrorCode[] = [
    "voice_consent_required",
    "voice_consent_revoked",
    "voice_consent_expired",
    "voice_scope_mismatch",
    "voice_type_mismatch",
    "voice_profile_invalid",
  ];
  if ((known as string[]).includes(code)) {
    const retryable =
      code !== "voice_type_mismatch" &&
      code !== "voice_consent_revoked" &&
      code !== "voice_consent_expired";
    return toUserFacingError(code as StudioErrorCode, correlationId, [], retryable);
  }
  return toUserFacingError("internal_error", correlationId, [], true);
}
