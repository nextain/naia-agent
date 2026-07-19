import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { chatRequestToDomain, emitToProto } from "../main/adapters/grpc/grpc-codec.js";
import { decodeRequest, encodeEmit } from "../main/adapters/protocol.js";
import { makeStdioIngress, type LineIO } from "../main/adapters/stdio.js";
import {
  planProcessingOperation,
  validateAndClaimConsent,
  validateProcessingDisclosure,
  validateSecurityWireRequest,
  type TrustedBinding,
  type TrustedConsentRecord,
} from "../main/domain/security-wire.js";

const binding: TrustedBinding = {
  bindingId: "binding_1",
  guildId: "100",
  channelId: "200",
  allowedUserIds: ["300"],
  processingProfileRef: "profile_1",
};

const disclosure = {
  kind: "processingDisclosure" as const,
  workload: "embedding" as const,
  destination: "external_cloud" as const,
  decision: "confirmation_required" as const,
  processingProfileRef: "profile_1",
  provider: "openai",
  model: "text-embedding-3-small",
};

function discordRequest(overrides: Record<string, unknown> = {}) {
  return {
    kind: "chat",
    requestId: "req_1",
    messages: [{ role: "user", content: "hello" }],
    channel: { kind: "discord", bindingId: "binding_1", guildId: "100", channelId: "200", userId: "300" },
    processing: { processingProfileRef: "profile_1" },
    ...overrides,
  };
}

function errorCode(result: ReturnType<typeof validateSecurityWireRequest>): string | undefined {
  return result.ok ? undefined : result.error.code;
}

describe("T-SEC-WIRE-01/02 — compatibility and caller-claim non-promotion", () => {
  it("accepts a legacy text chat without processing metadata", () => {
    expect(validateSecurityWireRequest({
      kind: "chat",
      requestId: "legacy_1",
      messages: [{ role: "user", content: "hello" }],
    }).ok).toBe(true);
  });

  it("stdio decode retains only processingProfileRef and drops actualDestination", () => {
    const decoded = decodeRequest(JSON.stringify({
      type: "chat_request",
      requestId: "req_1",
      messages: [],
      processing: { processingProfileRef: "profile_1", actualDestination: "local_device" },
    }));
    expect(decoded).toMatchObject({ processing: { processingProfileRef: "profile_1" } });
    expect((decoded as { processing?: Record<string, unknown> }).processing).not.toHaveProperty("actualDestination");
  });

  it("gRPC decode retains only processingProfileRef and drops actualDestination", () => {
    const decoded = chatRequestToDomain({
      requestId: "req_1",
      messages: [],
      processing: { processingProfileRef: "profile_1", actualDestination: "local_device" },
    });
    expect(decoded.processing).toEqual({ processingProfileRef: "profile_1" });
    expect(decoded.processing).not.toHaveProperty("actualDestination");
  });
});

describe("T-SEC-WIRE-03/04 — fail-closed Discord and zero-transit", () => {
  it("requires a processing profile for Discord", () => {
    expect(errorCode(validateSecurityWireRequest(discordRequest({ processing: undefined }), { trustedBinding: binding })))
      .toBe("PROCESSING_PROFILE_REQUIRED");
  });

  it("rejects absent trust and mismatched destination/session binding fields", () => {
    expect(errorCode(validateSecurityWireRequest(discordRequest()))).toBe("WIRE_SCOPE_FORBIDDEN");
    expect(errorCode(validateSecurityWireRequest(discordRequest({
      channel: { kind: "discord", bindingId: "binding_1", guildId: "100", channelId: "999", userId: "300" },
    }), { trustedBinding: binding }))).toBe("WIRE_SCOPE_FORBIDDEN");
    expect(errorCode(validateSecurityWireRequest(discordRequest({
      processing: { processingProfileRef: "profile_other" },
    }), { trustedBinding: binding }))).toBe("WIRE_SCOPE_FORBIDDEN");
    expect(validateSecurityWireRequest(discordRequest(), { trustedBinding: binding }).ok).toBe(true);
  });

  it.each([
    ["apiKey", "sk-inline-secret"],
    ["naiaKey", "nk-inline-secret"],
  ])("rejects inline %s without reflecting its value", (key, secret) => {
    const result = validateSecurityWireRequest({
      kind: "chat",
      requestId: "req_secret",
      messages: [],
      processing: { processingProfileRef: "profile_1" },
      provider: { provider: "openai", model: "m", [key]: secret },
    });
    expect(errorCode(result)).toBe("WIRE_INVALID_ARGUMENT");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects unknown enums, extra fields, controls, and unbounded labels", () => {
    const invalid = [
      { ...disclosure, workload: "prompt" },
      { ...disclosure, destination: "caller_claim" },
      { ...disclosure, decision: "maybe" },
      { ...disclosure, endpoint: "https://secret.example" },
      { ...disclosure, processingProfileRef: "profile\n1" },
      { ...disclosure, provider: "bad\nprovider" },
      { ...disclosure, model: "m".repeat(257) },
    ];
    for (const value of invalid) {
      const result = validateProcessingDisclosure(value);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("secret.example");
    }
  });

  it("stdio ingress emits one bounded coded error and never dispatches an inline secret", () => {
    let listener: ((line: string) => void) | undefined;
    const written: string[] = [];
    const io: LineIO = {
      writeLine: (line) => written.push(line),
      onLine: (cb) => { listener = cb; return () => {}; },
    };
    const dispatched = vi.fn();
    makeStdioIngress(io).onRequest(dispatched);
    listener?.(JSON.stringify({
      type: "chat_request",
      requestId: "req_secret",
      messages: [],
      processing: { processingProfileRef: "profile_1" },
      provider: { provider: "openai", model: "m", apiKey: "never-reflect-me" },
    }));
    expect(dispatched).not.toHaveBeenCalled();
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!)).toMatchObject({
      type: "error",
      requestId: "req_secret",
      code: "WIRE_INVALID_ARGUMENT",
    });
    expect(written[0]).not.toContain("never-reflect-me");
  });
});

describe("T-SEC-WIRE-05 — disclosure-first ordering", () => {
  it("plans disclosure before allowed downstream work", () => {
    const result = planProcessingOperation({ ...disclosure, decision: "allowed" });
    expect(result.ok && result.value.steps).toEqual(["processing_disclosure", "downstream"]);
  });

  it.each([
    ["blocked", "EXTERNAL_PROCESSING_FORBIDDEN"],
    ["confirmation_required", "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED"],
  ] as const)("plans disclosure before %s error", (decision, code) => {
    const result = planProcessingOperation({ ...disclosure, decision });
    expect(result.ok && result.value.steps).toEqual(["processing_disclosure", "error"]);
    expect(result.ok && result.value.errorCode).toBe(code);
  });
});

describe("T-SEC-WIRE-06 — opaque one-shot consent binding", () => {
  const baseConsent: TrustedConsentRecord = {
    consentId: "consent_opaque_1",
    processingProfileRef: "profile_1",
    destination: "external_cloud",
    workload: "embedding",
    sessionId: "session_1",
    expiresAt: 1_001,
  };

  it("atomically rejects a reconstructed record with the same consentId", () => {
    const claimed = new Set<string>();
    const claim = (consentId: string) => {
      if (claimed.has(consentId)) return false;
      claimed.add(consentId);
      return true;
    };
    expect(validateAndClaimConsent(disclosure, {
      sessionId: "session_1", now: 1_000, consent: baseConsent, claim,
    }).ok).toBe(true);
    expect(validateAndClaimConsent(disclosure, {
      sessionId: "session_1", now: 1_000, consent: { ...baseConsent }, claim,
    }).ok).toBe(false);
  });

  it("rejects expiresAt <= now before claim", () => {
    const claim = vi.fn(() => true);
    expect(validateAndClaimConsent(disclosure, {
      sessionId: "session_1", now: 1_001, consent: baseConsent, claim,
    }).ok).toBe(false);
    expect(claim).not.toHaveBeenCalled();
  });

  it.each([
    ["now", Number.NaN],
    ["now", Number.POSITIVE_INFINITY],
    ["now", -1],
    ["expiresAt", Number.NaN],
    ["expiresAt", Number.POSITIVE_INFINITY],
    ["expiresAt", -1],
  ] as const)("rejects non-finite or negative %s before claim", (field, value) => {
    const claim = vi.fn(() => true);
    const context = {
      sessionId: "session_1",
      now: field === "now" ? value : 1_000,
      consent: field === "expiresAt" ? { ...baseConsent, expiresAt: value } : baseConsent,
      claim,
    };
    expect(validateAndClaimConsent(disclosure, context).ok).toBe(false);
    expect(claim).not.toHaveBeenCalled();
  });

  it.each([
    ["processingProfileRef", "profile_other"],
    ["destination", "private_managed"],
    ["workload", "main_llm"],
    ["sessionId", "session_other"],
    ["consentId", "not opaque!"],
  ] as const)("rejects mismatched or invalid %s before claim", (field, value) => {
    const claim = vi.fn(() => true);
    const consent = { ...baseConsent, [field]: value } as TrustedConsentRecord;
    const sessionId = field === "sessionId" ? "session_1" : baseConsent.sessionId;
    expect(validateAndClaimConsent(disclosure, { sessionId, now: 1_000, consent, claim }).ok).toBe(false);
    expect(claim).not.toHaveBeenCalled();
  });
});

describe("T-SEC-WIRE-07 — fixed proto and paired codecs", () => {
  it("locks additive field numbers, disclosure fields, and sparse error codes", () => {
    const proto = readFileSync(new URL("../main/adapters/grpc/naia_agent.proto", import.meta.url), "utf8");
    expect(proto).toMatch(/optional ProcessingRequest processing = 14;/);
    expect(proto).toMatch(/ProcessingDisclosureEvent processing_disclosure = 20;/);
    expect(proto).toMatch(/ProcessingWorkload workload = 1;/);
    expect(proto).toMatch(/ProcessingDestination destination = 2;/);
    expect(proto).toMatch(/ProcessingDecision decision = 3;/);
    expect(proto).toMatch(/string processing_profile_ref = 4;/);
    expect(proto).toMatch(/optional string provider = 5;/);
    expect(proto).toMatch(/optional string model = 6;/);
    expect(proto).toMatch(/WIRE_INVALID_ARGUMENT = 15;/);
    expect(proto).toMatch(/WIRE_UNSUPPORTED_ENUM = 16;/);
    expect(proto).toMatch(/WIRE_SCOPE_FORBIDDEN = 17;/);
    expect(proto).toMatch(/PROCESSING_PROFILE_REQUIRED = 21;/);
    expect(proto).toMatch(/EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED = 24;/);
  });

  it("encodes the same disclosure in stdio and gRPC forms", () => {
    const event = { ...disclosure };
    expect(encodeEmit("req_1", event)).toMatchObject({
      type: "processing_disclosure",
      requestId: "req_1",
      workload: "embedding",
      destination: "external_cloud",
      decision: "confirmation_required",
      processingProfileRef: "profile_1",
    });
    expect(emitToProto("req_1", event)).toMatchObject({
      requestId: "req_1",
      processingDisclosure: {
        workload: "EMBEDDING",
        destination: "EXTERNAL_CLOUD",
        decision: "CONFIRMATION_REQUIRED",
        processingProfileRef: "profile_1",
      },
    });
  });
});
