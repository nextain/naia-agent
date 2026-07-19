// UC-WIRE-V1 TDD RED — one fail-closed validator shared by stdio and gRPC.
import { describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT,
  DISCORD_CHANNEL,
  EFFECTIVE_LLM_CONFIGS,
  GROUNDING_REQUIRED,
  LEGACY_DOMAIN_CHAT,
  MiB,
  PROVIDER_SESSION_RESUME,
  PROCESSING_DISCLOSURE_EVENT,
  PROCESSING_REQUEST,
  TRUSTED_DISCORD_BINDING,
} from "./wire-v1-fixtures.js";

type ValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; requestId?: string; error: { code: string; field: string } };
type WireValidator = (value: unknown, context?: unknown) => ValidationResult;
type EffectiveConfigValidator = (value: unknown) => ValidationResult;

async function loadValidators(): Promise<{
  validateWireChatRequest: WireValidator;
  validateEffectiveLlmConfigs: EffectiveConfigValidator;
}> {
  // Variable import keeps the RED suite runnable before the production module exists.
  const modulePath = "../main/domain/wire-v1.js";
  const loaded = await import(/* @vite-ignore */ modulePath) as Record<string, unknown>;
  expect(loaded.validateWireChatRequest).toBeTypeOf("function");
  expect(loaded.validateEffectiveLlmConfigs).toBeTypeOf("function");
  return loaded as {
    validateWireChatRequest: WireValidator;
    validateEffectiveLlmConfigs: EffectiveConfigValidator;
  };
}

function validDiscordRequest(): Record<string, unknown> {
  return {
    ...LEGACY_DOMAIN_CHAT,
    sessionId: "session001",
    messages: [{ role: "user", content: "inspect", attachments: [ATTACHMENT] }],
    channel: DISCORD_CHANNEL,
    grounding: GROUNDING_REQUIRED,
    providerSession: PROVIDER_SESSION_RESUME,
    processing: PROCESSING_REQUEST,
  };
}

function expectFailure(result: ValidationResult, code: string, field: string): void {
  expect(result).toMatchObject({ ok: false, error: { code, field } });
  expect(JSON.stringify(result)).not.toContain("sessionref001");
  expect(JSON.stringify(result)).not.toContain("binding001");
}

describe("UC-WIRE-V1 validator success/compatibility (T-WIRE-01~04,07,18)", () => {
  it("T-WIRE-01: a text-only legacy domain request remains valid and byte-shape-equivalent", async () => {
    const { validateWireChatRequest } = await loadValidators();
    expect(validateWireChatRequest(LEGACY_DOMAIN_CHAT)).toEqual({ ok: true, value: LEGACY_DOMAIN_CHAT });
  });

  it("T-WIRE-02~04: valid attachments/channel/grounding/provider-session survive validation", async () => {
    const { validateWireChatRequest } = await loadValidators();
    expect(validateWireChatRequest(validDiscordRequest(), {
      trustedBinding: TRUSTED_DISCORD_BINDING,
      workspace: "workshop",
      provider: "codex",
      model: "gpt-5",
      credentialGeneration: 1,
      providerSessionRecord: {
        providerSessionRef: PROVIDER_SESSION_RESUME.providerSessionRef,
        workspace: "workshop",
        sessionId: "session001",
        channel: DISCORD_CHANNEL,
        provider: "codex",
        model: "gpt-5",
        credentialGeneration: 1,
        lastSuccessfulUseAt: Date.now(),
        closed: false,
      },
    })).toEqual({ ok: true, value: validDiscordRequest() });
  });

  it("T-WIRE-07: effective configs require exactly unique main/sub/memory in order", async () => {
    const { validateEffectiveLlmConfigs } = await loadValidators();
    expect(validateEffectiveLlmConfigs(EFFECTIVE_LLM_CONFIGS)).toEqual({
      ok: true,
      value: EFFECTIVE_LLM_CONFIGS,
    });
    expectFailure(validateEffectiveLlmConfigs(EFFECTIVE_LLM_CONFIGS.slice(0, 2)), "WIRE_INVALID_ARGUMENT", "effectiveLlmConfigs");
    expectFailure(validateEffectiveLlmConfigs([
      EFFECTIVE_LLM_CONFIGS[0],
      EFFECTIVE_LLM_CONFIGS[0],
      EFFECTIVE_LLM_CONFIGS[2],
    ]), "WIRE_INVALID_ARGUMENT", "effectiveLlmConfigs");
  });
});

describe("UC-WIRE-V1 validator fail-closed matrix (T-WIRE-08~11,13,16)", () => {
  it.each([
    ["unknown grounding policy", { grounding: { ...GROUNDING_REQUIRED, policy: "sometimes" } }, "WIRE_UNSUPPORTED_ENUM", "grounding.policy"],
    ["missing channel for grounding", { channel: undefined }, "WIRE_INVALID_ARGUMENT", "channel"],
    ["missing sessionId for provider session", { sessionId: undefined }, "WIRE_INVALID_ARGUMENT", "sessionId"],
    ["unsupported attachment MIME", { messages: [{ role: "user", content: "", attachments: [{ ...ATTACHMENT, mimeType: "image/gif" }] }] }, "ATTACHMENT_UNSUPPORTED_TYPE", "messages[0].attachments[0].mimeType"],
    ["zero attachment size", { messages: [{ role: "user", content: "", attachments: [{ ...ATTACHMENT, sizeBytes: 0 }] }] }, "WIRE_INVALID_ARGUMENT", "messages[0].attachments[0].sizeBytes"],
    ["oversized attachment", { messages: [{ role: "user", content: "", attachments: [{ ...ATTACHMENT, sizeBytes: 20 * MiB + 1 }] }] }, "ATTACHMENT_TOO_LARGE", "messages[0].attachments[0].sizeBytes"],
    ["path-shaped localRef", { messages: [{ role: "user", content: "", attachments: [{ ...ATTACHMENT, localRef: "../secret.png" }] }] }, "ATTACHMENT_INVALID_REF", "messages[0].attachments[0].localRef"],
    ["non-snowflake guild", { channel: { ...DISCORD_CHANNEL, guildId: "guild-one" } }, "WIRE_INVALID_ARGUMENT", "channel.guildId"],
    ["empty knowledge scope", { grounding: { ...GROUNDING_REQUIRED, knowledgeScope: " " } }, "WIRE_INVALID_ARGUMENT", "grounding.knowledgeScope"],
    ["null channel", { channel: null }, "WIRE_INVALID_ARGUMENT", "channel"],
    ["null grounding", { grounding: null }, "WIRE_INVALID_ARGUMENT", "grounding"],
    ["null provider session", { providerSession: null }, "WIRE_INVALID_ARGUMENT", "providerSession"],
  ] as const)("T-WIRE-08: rejects %s", async (_name, patch, code, field) => {
    const { validateWireChatRequest } = await loadValidators();
    expectFailure(validateWireChatRequest({ ...validDiscordRequest(), ...patch }, {
      trustedBinding: TRUSTED_DISCORD_BINDING,
    }), code, field);
  });

  it.each([
    ["binding", { bindingId: "binding999" }],
    ["guild", { guildId: "423456789012345678" }],
    ["channel", { channelId: "523456789012345678" }],
    ["user", { userId: "623456789012345678" }],
  ] as const)("T-WIRE-09: forged/cross-context %s fails before downstream calls", async (_name, channelPatch) => {
    const { validateWireChatRequest } = await loadValidators();
    const result = validateWireChatRequest({
      ...validDiscordRequest(),
      channel: { ...DISCORD_CHANNEL, ...channelPatch },
    }, {
      trustedBinding: TRUSTED_DISCORD_BINDING,
    });
    expectFailure(result, "WIRE_SCOPE_FORBIDDEN", "channel");
  });

  it.each([
    ["base64 payload", "iVBORw0KGgoAAAANSUhEUgAAAAE"],
    ["data URI", "data:image/png;base64,AAAA"],
    ["path", "/home/user/secret.png"],
    ["raw provider-shaped ref", "thread:raw-provider-id"],
  ])("T-WIRE-10: rejects %s and does not echo the offending value", async (_name, localRef) => {
    const { validateWireChatRequest } = await loadValidators();
    const result = validateWireChatRequest({
      ...validDiscordRequest(),
      messages: [{ role: "user", content: "", attachments: [{ ...ATTACHMENT, localRef }] }],
    }, { trustedBinding: TRUSTED_DISCORD_BINDING });
    expectFailure(result, "ATTACHMENT_INVALID_REF", "messages[0].attachments[0].localRef");
    expect(JSON.stringify(result)).not.toContain(localRef);
  });

  it.each([
    ["grounded without sources", { status: "grounded", sources: [] }],
    ["no_evidence with sources", { status: "no_evidence", sources: [{ title: "x", sourceUris: ["kb://scope/x"] }] }],
    ["credential query", { status: "grounded", sources: [{ title: "x", sourceUris: ["https://example.test/x?token=secret"] }] }],
    ["javascript URI", { status: "grounded", sources: [{ title: "x", sourceUris: ["javascript:alert(1)"] }] }],
    ["null source", { status: "grounded", sources: [null] }],
    ["non-object source", { status: "grounded", sources: ["kb://scope/x"] }],
  ])("T-WIRE-11: rejects invalid source/status case: %s", async (_name, groundingResult) => {
    const modulePath = "../main/domain/wire-v1.js";
    const loaded = await import(/* @vite-ignore */ modulePath) as Record<string, unknown>;
    expect(loaded.validateGroundingEvent).toBeTypeOf("function");
    const result = (loaded.validateGroundingEvent as (value: unknown, channel: unknown) => ValidationResult)(
      groundingResult,
      DISCORD_CHANNEL,
    );
    expect(result.ok).toBe(false);
  });

  it.each([
    ["mixed overlong URI", `https://example.test/${"x".repeat(2049)}`],
    ["mixed control URI", "https://example.test/ok\u0000hidden"],
  ])("T-WIRE-11: one invalid URI invalidates the complete source/event: %s", async (_name, invalidUri) => {
    const loaded = await import("../main/domain/wire-v1.js");
    const result = loaded.validateGroundingEvent({
      status: "grounded",
      sources: [{ title: "mixed", sourceUris: ["kb://workshop/valid", invalidUri] }],
    }, { kind: "shell" });
    expectFailure(result, "WIRE_INVALID_ARGUMENT", "grounding");
    expect(JSON.stringify(result)).not.toContain(invalidUri);
  });

  it("T-WIRE-13: correlated failures have one stable code; invalid requestId is uncorrelated", async () => {
    const { validateWireChatRequest } = await loadValidators();
    expectFailure(validateWireChatRequest({
      ...validDiscordRequest(),
      grounding: { ...GROUNDING_REQUIRED, policy: "unknown" },
    }), "WIRE_UNSUPPORTED_ENUM", "grounding.policy");
    const uncorrelated = validateWireChatRequest({ ...validDiscordRequest(), requestId: "" });
    expect(uncorrelated).toMatchObject({ ok: false, error: { code: "WIRE_INVALID_ARGUMENT", field: "requestId" } });
    expect(uncorrelated).not.toHaveProperty("requestId");
  });

  it("T-WIRE-09: shell grounding scope is authorized by trusted workspace context", async () => {
    const { validateWireChatRequest } = await loadValidators();
    const request = {
      ...LEGACY_DOMAIN_CHAT,
      channel: { kind: "shell" },
      grounding: GROUNDING_REQUIRED,
    };
    expect(validateWireChatRequest(request, { allowedKnowledgeScopes: ["workshop"] }).ok).toBe(true);
    expectFailure(validateWireChatRequest(request, { allowedKnowledgeScopes: ["other"] }), "WIRE_SCOPE_FORBIDDEN", "grounding.knowledgeScope");
    expectFailure(validateWireChatRequest(request), "WIRE_SCOPE_FORBIDDEN", "grounding.knowledgeScope");
  });

  it("plain Discord chat does not require an unused grounding claim", async () => {
    const { validateWireChatRequest } = await loadValidators();
    const request = {
      ...LEGACY_DOMAIN_CHAT,
      channel: DISCORD_CHANNEL,
      processing: PROCESSING_REQUEST,
    };
    expect(validateWireChatRequest(request, { trustedBinding: TRUSTED_DISCORD_BINDING })).toEqual({
      ok: true, value: request,
    });
  });

  it("T-WIRE-12: expired, closed, or cross-binding provider-session handles fail closed", async () => {
    const { validateWireChatRequest } = await loadValidators();
    const request = validDiscordRequest();
    const matchingRecord = {
      providerSessionRef: PROVIDER_SESSION_RESUME.providerSessionRef,
      workspace: "workshop",
      sessionId: "session001",
      channel: DISCORD_CHANNEL,
      provider: "codex",
      model: "gpt-5",
      credentialGeneration: 1,
      lastSuccessfulUseAt: 1_000,
      closed: false,
    };
    const context = {
      trustedBinding: TRUSTED_DISCORD_BINDING,
      workspace: "workshop",
      provider: "codex",
      model: "gpt-5",
      credentialGeneration: 1,
      now: 1_000 + 24 * 60 * 60 * 1000,
      providerSessionRecord: matchingRecord,
    };
    expect(validateWireChatRequest(request, context).ok).toBe(true);
    expect(validateWireChatRequest(request, {
      ...context,
      providerSessionRecord: {
        ...matchingRecord,
        channel: {
          userId: DISCORD_CHANNEL.userId,
          channelId: DISCORD_CHANNEL.channelId,
          guildId: DISCORD_CHANNEL.guildId,
          bindingId: DISCORD_CHANNEL.bindingId,
          kind: "discord",
        },
      },
    }).ok).toBe(true);
    expectFailure(validateWireChatRequest(request, {
      ...context,
      now: context.now + 1,
    }), "PROVIDER_SESSION_EXPIRED", "providerSession.providerSessionRef");
    expectFailure(validateWireChatRequest(request, {
      ...context,
      providerSessionRecord: { ...matchingRecord, closed: true },
    }), "PROVIDER_SESSION_CLOSED", "providerSession.providerSessionRef");
    expectFailure(validateWireChatRequest(request, {
      ...context,
      workspace: "other-workspace",
    }), "PROVIDER_SESSION_MISMATCH", "providerSession.providerSessionRef");
    expectFailure(validateWireChatRequest(request, {
      ...context,
      credentialGeneration: 2,
    }), "PROVIDER_SESSION_MISMATCH", "providerSession.providerSessionRef");
  });

  it("T-WIRE-16: accepts exact collection/string/size bounds and rejects the first excess", async () => {
    const { validateWireChatRequest } = await loadValidators();
    const attachments = Array.from({ length: 8 }, (_, i) => ({
      ...ATTACHMENT,
      id: `att${i}`,
      sizeBytes: 20 * MiB,
      localRef: `imgref${i}`,
    }));
    const atBoundary = {
      ...LEGACY_DOMAIN_CHAT,
      requestId: "r".repeat(128),
      messages: [{ role: "user", content: "", attachments }],
      channel: { kind: "shell" },
    };
    expect(validateWireChatRequest(atBoundary).ok).toBe(true);
    expectFailure(validateWireChatRequest({
      ...atBoundary,
      messages: [{ role: "user", content: "", attachments: [...attachments, { ...ATTACHMENT, id: "att9" }] }],
    }), "WIRE_INVALID_ARGUMENT", "messages[0].attachments");
    expectFailure(validateWireChatRequest({ ...atBoundary, requestId: "r".repeat(129) }), "WIRE_INVALID_ARGUMENT", "requestId");
  });

  it("T-WIRE-16: enforces the 2 MiB UTF-8 serialized request boundary exactly", async () => {
    const { validateWireChatRequest } = await loadValidators();
    const template = {
      ...LEGACY_DOMAIN_CHAT,
      requestId: "size-boundary",
      messages: [{ role: "user", content: "" }],
    };
    const maxBytes = 2 * MiB;
    const emptyBytes = new TextEncoder().encode(JSON.stringify(template)).byteLength;
    const exact = {
      ...template,
      messages: [{ role: "user", content: "x".repeat(maxBytes - emptyBytes) }],
    };
    expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(maxBytes);
    expect(validateWireChatRequest(exact).ok).toBe(true);
    expectFailure(validateWireChatRequest({
      ...exact,
      messages: [{ role: "user", content: `${exact.messages[0]!.content}x` }],
    }), "WIRE_INVALID_ARGUMENT", "$");
  });
});

describe("UC-WIRE-V1 provider session store", () => {
  it("issues opaque refs and enforces full binding, 24h TTL, and closed state", async () => {
    const { makeInMemoryProviderSessionStore } = await import("../main/domain/wire-v1.js");
    let now = 1_000;
    const store = makeInMemoryProviderSessionStore({ now: () => now, randomRef: () => "ps_random001" });
    const binding = {
      workspace: "workshop", sessionId: "session001", channel: { kind: "shell" },
      provider: "codex", model: "gpt-5", credentialGeneration: 1,
    };
    const created = store.start(binding);
    expect(created.providerSessionRef).toBe("ps_random001");
    expect(created.providerSessionRef).not.toContain("session001");
    store.markSuccessful(created.providerSessionRef);
    now += 24 * 60 * 60 * 1000;
    expect(store.resume(created.providerSessionRef, binding).ok).toBe(true);
    expectFailure(store.resume(created.providerSessionRef, { ...binding, workspace: "other" }), "PROVIDER_SESSION_MISMATCH", "providerSession.providerSessionRef");
    now += 1;
    expectFailure(store.resume(created.providerSessionRef, binding), "PROVIDER_SESSION_EXPIRED", "providerSession.providerSessionRef");
    expect(store.get(created.providerSessionRef)).toBeUndefined();
    expect(store.resume(created.providerSessionRef, {
      ...binding,
      channel: { userId: "3", channelId: "2", guildId: "1", bindingId: "b", kind: "discord" },
    }).ok).toBe(false);
    store.close(created.providerSessionRef);
    expect(store.get(created.providerSessionRef)).toBeUndefined();
    expectFailure(store.resume(created.providerSessionRef, binding), "PROVIDER_SESSION_CLOSED", "providerSession.providerSessionRef");
  });

  it("compares provider-session Discord channels structurally, independent of object key order", async () => {
    const { makeInMemoryProviderSessionStore } = await import("../main/domain/wire-v1.js");
    const store = makeInMemoryProviderSessionStore({ randomRef: () => "ps_order001" });
    const binding = {
      workspace: "workshop", sessionId: "session001",
      channel: { kind: "discord", bindingId: "b", guildId: "1", channelId: "2", userId: "3" },
      provider: "codex", model: "gpt-5", credentialGeneration: 1,
    };
    const created = store.start(binding);
    store.markSuccessful(created.providerSessionRef);
    expect(store.resume(created.providerSessionRef, {
      ...binding,
      channel: { userId: "3", channelId: "2", guildId: "1", bindingId: "b", kind: "discord" },
    }).ok).toBe(true);
  });

  it("physically cleans expired/closed records and evicts the oldest record at the configured bound", async () => {
    const { makeInMemoryProviderSessionStore } = await import("../main/domain/wire-v1.js");
    let now = 1_000;
    let sequence = 0;
    const store = makeInMemoryProviderSessionStore({
      now: () => now,
      maxRecords: 2,
      randomRef: () => `boundedref${++sequence}`,
    });
    const binding = {
      workspace: "workshop", sessionId: "session001", channel: { kind: "shell" },
      provider: "codex", model: "gpt-5", credentialGeneration: 1,
    };
    const first = store.start(binding);
    store.markSuccessful(first.providerSessionRef);
    const second = store.start(binding);
    store.markSuccessful(second.providerSessionRef);
    const third = store.start(binding);
    store.markSuccessful(third.providerSessionRef);

    expectFailure(store.resume(first.providerSessionRef, binding), "PROVIDER_SESSION_MISMATCH", "providerSession.providerSessionRef");
    expect(store.resume(second.providerSessionRef, binding).ok).toBe(true);
    expect(store.resume(third.providerSessionRef, binding).ok).toBe(true);

    store.close(second.providerSessionRef);
    expect(store.get(second.providerSessionRef)).toBeUndefined();
    expectFailure(store.resume(second.providerSessionRef, binding), "PROVIDER_SESSION_CLOSED", "providerSession.providerSessionRef");

    now += 24 * 60 * 60 * 1000 + 1;
    expect(store.get(third.providerSessionRef)).toBeUndefined();
    expectFailure(store.resume(third.providerSessionRef, binding), "PROVIDER_SESSION_EXPIRED", "providerSession.providerSessionRef");
  });
});

describe("UC-WIRE-V1 processing security delta (T-WIRE-20~23)", () => {
  it("T-WIRE-20: Discord requires the trusted processing profile and rejects mismatch", async () => {
    const { validateWireChatRequest } = await loadValidators();
    const request = validDiscordRequest();
    expectFailure(validateWireChatRequest({ ...request, processing: undefined }, {
      trustedBinding: TRUSTED_DISCORD_BINDING,
    }), "PROCESSING_PROFILE_REQUIRED", "processing.processingProfileRef");
    expectFailure(validateWireChatRequest({ ...request, processing: { processingProfileRef: "profile999" } }, {
      trustedBinding: TRUSTED_DISCORD_BINDING,
    }), "WIRE_SCOPE_FORBIDDEN", "processing.processingProfileRef");
    expectFailure(validateWireChatRequest(request), "WIRE_SCOPE_FORBIDDEN", "channel");
  });

  it("guardian: processing request is an exact closed shape and hostile proxies fail closed without echo", async () => {
    const { validateWireChatRequest } = await loadValidators();
    const canary = "PROCESSING-SECRET-CANARY";
    const extra = validateWireChatRequest({
      ...LEGACY_DOMAIN_CHAT,
      processing: { processingProfileRef: "profile001", secret: canary },
    });
    expectFailure(extra, "WIRE_INVALID_ARGUMENT", "processing.processingProfileRef");
    expect(JSON.stringify(extra)).not.toContain(canary);

    const hostile = new Proxy({ processingProfileRef: "profile001" }, {
      ownKeys: () => { throw new Error(canary); },
    });
    const hostileResult = validateWireChatRequest({
      ...LEGACY_DOMAIN_CHAT,
      processing: hostile,
    });
    expectFailure(hostileResult, "WIRE_INVALID_ARGUMENT", "$");
    expect(JSON.stringify(hostileResult)).not.toContain(canary);
  });

  it("T-WIRE-21: disclosure is closed, bounded, and does not echo rejected values", async () => {
    const loaded = await import("../main/domain/wire-v1.js");
    expect(loaded.validateProcessingDisclosureEvent(PROCESSING_DISCLOSURE_EVENT).ok).toBe(true);
    const secret = "https://secret.test/?token=abc";
    const result = loaded.validateProcessingDisclosureEvent({ ...PROCESSING_DISCLOSURE_EVENT, endpoint: secret });
    expectFailure(result, "WIRE_INVALID_ARGUMENT", "processingDisclosure");
    expect(JSON.stringify(result)).not.toContain(secret);
    expectFailure(loaded.validateProcessingDisclosureEvent({
      ...PROCESSING_DISCLOSURE_EVENT, destination: "unknown",
    }), "WIRE_UNSUPPORTED_ENUM", "processingDisclosure.destination");
    expect(loaded.validateProcessingDisclosureEvent({
      ...PROCESSING_DISCLOSURE_EVENT, provider: "openai-compatible", model: "org/model-v2:latest",
    }).ok).toBe(true);
  });

  it.each([
    ["provider endpoint", "provider", "https://api.example.test/v1?token=CANARY"],
    ["provider credential", "provider", "sk-CANARY"],
    ["model endpoint", "model", "https://api.example.test/models/gpt"],
    ["model query token", "model", "gpt-5?token=CANARY"],
    ["model prompt/content", "model", "ignore previous instructions"],
  ] as const)("guardian: disclosure rejects raw %s in %s and redacts it", async (_name, field, hostile) => {
    const loaded = await import("../main/domain/wire-v1.js");
    const result = loaded.validateProcessingDisclosureEvent({
      ...PROCESSING_DISCLOSURE_EVENT,
      [field]: hostile,
    });
    expectFailure(result, "WIRE_INVALID_ARGUMENT", `processingDisclosure.${field}`);
    expect(JSON.stringify(result)).not.toContain(hostile);
  });

  it("T-WIRE-22: disclosure is deterministically planned before downstream or error", async () => {
    const loaded = await import("../main/domain/wire-v1.js");
    expect(loaded.planProcessingOperation(PROCESSING_DISCLOSURE_EVENT)).toMatchObject({
      ok: true, value: { steps: ["processing_disclosure", "downstream"] },
    });
    expect(loaded.planProcessingOperation({ ...PROCESSING_DISCLOSURE_EVENT, decision: "blocked" })).toMatchObject({
      ok: true,
      value: { steps: ["processing_disclosure", "error"], errorCode: "EXTERNAL_PROCESSING_FORBIDDEN" },
    });
  });

  it("T-WIRE-23: consent is expiring, one-shot, and fully scope-bound", async () => {
    const loaded = await import("../main/domain/wire-v1.js");
    const consent = {
      consentId: "consent001", scope: "workshop", processingProfileRef: "profile001", destination: "external_cloud" as const,
      workload: "main_llm" as const, sessionId: "session001", expiresAt: 2_000,
    };
    expect(loaded.validateTrustedConsent(PROCESSING_DISCLOSURE_EVENT, {
      scope: "workshop", sessionId: "session001", now: 1_999, consent, claim: () => true,
    }).ok).toBe(true);
    expectFailure(loaded.validateTrustedConsent(PROCESSING_DISCLOSURE_EVENT, {
      scope: "workshop", sessionId: "session001", now: 2_000, consent, claim: () => true,
    }), "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED", "consent");
    expectFailure(loaded.validateTrustedConsent(PROCESSING_DISCLOSURE_EVENT, {
      scope: "workshop", sessionId: "other", now: 1_999, consent, claim: () => true,
    }), "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED", "consent");
    expectFailure(loaded.validateTrustedConsent(PROCESSING_DISCLOSURE_EVENT, {
      scope: "workshop", sessionId: "session001", now: 1_999, consent, claim: () => false,
    }), "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED", "consent");
  });

  it("guardian: consent validates finite bound fields before atomic consentId CAS and consumes reconstructed ID once", async () => {
    const loaded = await import("../main/domain/wire-v1.js");
    const consumed = new Set<string>();
    const claim = vi.fn((consentId: string) => {
      if (consumed.has(consentId)) return false;
      consumed.add(consentId);
      return true;
    });
    const consent = {
      consentId: "consentCAS001", scope: "workshop", processingProfileRef: "profile001",
      destination: "external_cloud" as const, workload: "main_llm" as const,
      sessionId: "session001", expiresAt: 2_000,
    };
    const context = { scope: "workshop", sessionId: "session001", now: 1_000, claim };
    expect(loaded.validateTrustedConsent(PROCESSING_DISCLOSURE_EVENT, { ...context, consent }).ok).toBe(true);
    expectFailure(loaded.validateTrustedConsent(PROCESSING_DISCLOSURE_EVENT, {
      ...context, consent: { ...consent },
    }), "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED", "consent");
    expect(claim).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenNthCalledWith(1, "consentCAS001");
    expect(claim).toHaveBeenNthCalledWith(2, "consentCAS001");

    for (const invalid of [
      { ...consent, expiresAt: Number.NaN },
      { ...consent, scope: "other" },
      { ...consent, processingProfileRef: "other" },
      { ...consent, destination: "local_device" as const },
      { ...consent, workload: "sub_llm" as const },
      { ...consent, sessionId: "other" },
    ]) {
      const guardedClaim = vi.fn(() => true);
      expectFailure(loaded.validateTrustedConsent(PROCESSING_DISCLOSURE_EVENT, {
        ...context, consent: invalid, claim: guardedClaim,
      }), "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED", "consent");
      expect(guardedClaim).not.toHaveBeenCalled();
    }
  });
});
