import { describe, expect, it, vi } from "vitest";
import { makeProcessingGuard } from "../main/adapters/processing-guard.js";
import type { TrustedConsentRecord } from "../main/domain/security-wire.js";

const provider = { provider: "openai", model: "gpt" };

describe("trusted processing guard", () => {
  it("unverified private-looking endpoint is external and cannot skip confirmation", () => {
    const guard = makeProcessingGuard({
      profiles: { get: () => "ask_before_external" },
      endpoints: { resolve: () => ({ url: "http://10.0.0.2:8000", zone: "unverified" }) },
    });
    expect(guard.authorize({
      processingProfileRef: "profile_1",
      workload: "embedding",
      provider,
      sessionId: "session_1",
    })).toMatchObject({
      destination: "external_cloud",
      decision: "confirmation_required",
    });
  });

  it("trusted endpoint registry alone can classify a private managed endpoint", () => {
    const guard = makeProcessingGuard({
      profiles: { get: () => "ask_before_external" },
      endpoints: { resolve: () => ({ url: "http://10.0.0.2:8000", zone: "private_managed" }) },
    });
    expect(guard.authorize({
      processingProfileRef: "profile_1",
      workload: "main_llm",
      provider,
      sessionId: "session_1",
    })).toMatchObject({ destination: "private_managed", decision: "allowed" });
  });

  it("external consent is accepted only through bound record lookup and atomic ID claim", () => {
    const claim = vi.fn(() => true);
    const consent: TrustedConsentRecord = {
      consentId: "consent_1",
      processingProfileRef: "profile_1",
      destination: "external_cloud",
      workload: "embedding",
      sessionId: "session_1",
      expiresAt: 2_000,
    };
    const guard = makeProcessingGuard({
      profiles: { get: () => "ask_before_external" },
      endpoints: { resolve: () => ({ url: "https://api.example.com", zone: "unverified" }) },
      consents: { find: () => consent, claim },
      now: () => 1_000,
    });
    expect(guard.authorize({
      processingProfileRef: "profile_1",
      workload: "embedding",
      provider,
      sessionId: "session_1",
    }).decision).toBe("allowed");
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith("consent_1");
  });

  it.each([
    { destination: "private_managed" as const },
    { workload: "main_llm" as const },
    { sessionId: "other_session" },
    { expiresAt: 1_000 },
  ])("mismatched or expired consent cannot authorize: %o", (patch) => {
    const claim = vi.fn(() => true);
    const consent: TrustedConsentRecord = {
      consentId: "consent_1",
      processingProfileRef: "profile_1",
      destination: "external_cloud",
      workload: "embedding",
      sessionId: "session_1",
      expiresAt: 2_000,
      ...patch,
    };
    const guard = makeProcessingGuard({
      profiles: { get: () => "ask_before_external" },
      endpoints: { resolve: () => ({ url: "https://api.example.com", zone: "unverified" }) },
      consents: { find: () => consent, claim },
      now: () => 1_000,
    });
    expect(guard.authorize({
      processingProfileRef: "profile_1",
      workload: "embedding",
      provider,
      sessionId: "session_1",
    }).decision).toBe("confirmation_required");
    expect(claim).not.toHaveBeenCalled();
  });

  it("missing profile or endpoint fails closed", () => {
    const missingProfile = makeProcessingGuard({
      profiles: { get: () => undefined },
      endpoints: { resolve: () => ({ url: "http://localhost:8000", zone: "unverified" }) },
    });
    expect(() => missingProfile.authorize({
      processingProfileRef: "missing",
      workload: "main_llm",
      provider,
      sessionId: "session_1",
    })).toThrow();
  });

  it.each([
    { provider: " openai ", model: "gpt" },
    { provider: "openai", model: "m".repeat(257) },
    { provider: "open\nai", model: "gpt" },
  ])("invalid effective provider labels fail closed: %o", (invalidProvider) => {
    const guard = makeProcessingGuard({
      profiles: { get: () => "cloud_enabled" },
      endpoints: { resolve: () => ({ url: "https://api.example.com", zone: "unverified" }) },
    });
    expect(() => guard.authorize({
      processingProfileRef: "profile_1",
      workload: "main_llm",
      provider: invalidProvider,
      sessionId: "session_1",
    })).toThrow();
  });
});
