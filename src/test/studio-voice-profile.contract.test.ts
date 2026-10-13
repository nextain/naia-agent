// UC-STUDIO-VOICE contract — alpha-adk #48 / FR-STUDIO-VOICE-1~6
import { describe, it, expect } from "vitest";
import {
  normalizeVoiceProfile,
  assertVoiceUsableForGeneration,
  evaluateVoiceForGeneration,
  looksLikeNvaManifest,
  assertSafeStorageLocator,
  type VoiceProfile,
} from "../main/domain/studio-voice-profile.ts";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");

function validProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "vp-alpha-1",
    displayName: "Alpha",
    previewRef: "preview:vp-alpha-1",
    consent: {
      status: "granted",
      scope: ["singing", "preview"],
      recordedAt: "2026-09-01T00:00:00.000Z",
    },
    provenance: "gateway-ref-audio-presets",
    subject: "user:luke",
    usageScope: ["singing", "preview"],
    storageLocator: "voices/vp-alpha-1",
    derivativePolicy: "keep",
    ...overrides,
  };
}

describe("TEST-STUDIO-VOICE-01 normalizeVoiceProfile", () => {
  it("accepts a complete granted profile", () => {
    const profile = normalizeVoiceProfile(validProfile());
    expect(profile.id).toBe("vp-alpha-1");
    expect(profile.consent.status).toBe("granted");
    expect(profile.provenance).toBe("gateway-ref-audio-presets");
    expect(profile.subject).toBe("user:luke");
    expect(profile.derivativePolicy).toBe("keep");
  });

  it("rejects missing required fields", () => {
    expect(() => normalizeVoiceProfile(validProfile({ id: "" }))).toThrow(/missing_or_empty:id/);
    expect(() => normalizeVoiceProfile(validProfile({ consent: { status: "granted" } }))).toThrow();
  });

  it("rejects forbidden audio payload fields", () => {
    expect(() => normalizeVoiceProfile(validProfile({ bytes: new Uint8Array([1]) }))).toThrow(
      /forbidden_payload_field:bytes/,
    );
  });
});

describe("TEST-STUDIO-VOICE-02 assertVoiceUsableForGeneration", () => {
  it("allows granted in-scope voice", () => {
    const profile = normalizeVoiceProfile(validProfile()) as VoiceProfile;
    expect(assertVoiceUsableForGeneration(profile, ["singing"], NOW)).toEqual({
      ok: true,
      code: "ok",
    });
  });

  it("rejects pending/denied", () => {
    for (const status of ["pending", "denied"] as const) {
      const profile = normalizeVoiceProfile(
        validProfile({ consent: { status, scope: ["singing"], recordedAt: "2026-09-01T00:00:00.000Z" } }),
      );
      expect(assertVoiceUsableForGeneration(profile, ["singing"], NOW).code).toBe(
        "voice_consent_required",
      );
    }
  });

  it("rejects revoked via status or revokedAt", () => {
    const byStatus = normalizeVoiceProfile(
      validProfile({
        consent: {
          status: "revoked",
          scope: ["singing"],
          recordedAt: "2026-09-01T00:00:00.000Z",
          revokedAt: "2026-09-10T00:00:00.000Z",
        },
      }),
    );
    expect(assertVoiceUsableForGeneration(byStatus, ["singing"], NOW).code).toBe(
      "voice_consent_revoked",
    );

    const byStamp = normalizeVoiceProfile(
      validProfile({
        consent: {
          status: "granted",
          scope: ["singing"],
          recordedAt: "2026-09-01T00:00:00.000Z",
          revokedAt: "2026-09-10T00:00:00.000Z",
        },
      }),
    );
    expect(assertVoiceUsableForGeneration(byStamp, ["singing"], NOW).code).toBe(
      "voice_consent_revoked",
    );
  });

  it("rejects expired", () => {
    const profile = normalizeVoiceProfile(
      validProfile({
        consent: {
          status: "granted",
          scope: ["singing"],
          recordedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-09-01T00:00:00.000Z",
        },
      }),
    );
    expect(assertVoiceUsableForGeneration(profile, ["singing"], NOW).code).toBe(
      "voice_consent_expired",
    );
  });

  it("rejects scope mismatch", () => {
    const profile = normalizeVoiceProfile(
      validProfile({
        consent: {
          status: "granted",
          scope: ["preview"],
          recordedAt: "2026-09-01T00:00:00.000Z",
        },
      }),
    );
    expect(assertVoiceUsableForGeneration(profile, ["singing"], NOW).code).toBe(
      "voice_scope_mismatch",
    );
  });
});

describe("TEST-STUDIO-VOICE-03 NVA manifest separation", () => {
  const nvaShaped = {
    nva_version: "0.2",
    meta: { name: "Naia" },
    canvas: { width: 720, height: 1280 },
    animations: { idle: { clip: "clips/idle.webm" } },
  };

  it("detects NVA shape", () => {
    expect(looksLikeNvaManifest(nvaShaped)).toBe(true);
    expect(looksLikeNvaManifest(validProfile())).toBe(false);
  });

  it("rejects NVA shape as voice profile", () => {
    expect(evaluateVoiceForGeneration(nvaShaped, ["singing"], NOW)).toEqual({
      ok: false,
      code: "voice_type_mismatch",
    });
  });
});

describe("TEST-STUDIO-VOICE-04 storageLocator safety", () => {
  it("rejects absolute paths and traversal", () => {
    expect(() => assertSafeStorageLocator("/etc/passwd")).toThrow(/absolute/);
    expect(() => assertSafeStorageLocator("C:\\voices\\a")).toThrow(/absolute/);
    expect(() => assertSafeStorageLocator("voices/../../secret")).toThrow(/traversal/);
  });

  it("rejects absolute locator during normalize", () => {
    expect(() =>
      normalizeVoiceProfile(validProfile({ storageLocator: "/var/voices/a" })),
    ).toThrow(/absolute/);
  });

  it("evaluate maps schema errors to voice_profile_invalid", () => {
    expect(evaluateVoiceForGeneration(validProfile({ storageLocator: "../x" }), ["singing"], NOW)).toEqual({
      ok: false,
      code: "voice_profile_invalid",
    });
  });
});
