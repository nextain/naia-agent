import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeFileConsentStore } from "../main/adapters/file-consent-store.js";
import { makeProcessingGuard } from "../main/adapters/processing-guard.js";
import { makeWireProcessingRequestContext } from "../main/composition/index.js";
import {
  classifyProcessingEndpoint,
  decideProcessingPolicy,
} from "../main/domain/processing-policy.js";
import type { TrustedConsentRecord } from "../main/domain/wire-v1.js";

const provider = { provider: "openai", model: "gpt-5" };

describe("trusted processing policy", () => {
  it("rejects consent records with untrusted extra fields", () => {
    const path = join(mkdtempSync(join(tmpdir(), "naia-consent-")), "consumed.json");
    const record = {
      consentId: "consent_1", scope: "scope_1", processingProfileRef: "profile_1",
      destination: "external_cloud", workload: "embedding", sessionId: "session_1",
      expiresAt: 2_000, attackerControlled: true,
    } as unknown as TrustedConsentRecord;
    expect(() => makeFileConsentStore({ path, records: [record] }))
      .toThrow("PROCESSING_CONSENT_CONFIG_INVALID");
  });

  it.each([
    ["http://localhost:11434", "local_device"],
    ["http://127.0.0.1:8000", "local_device"],
    ["http://[::1]:8000", "local_device"],
    ["unix:///run/naia/model.sock", "local_device"],
    ["http://10.0.0.2:8000", "external_cloud"],
    ["https://api.openai.com/v1", "external_cloud"],
  ] as const)("classifies %s as %s without promoting private-looking text", (url, destination) => {
    expect(classifyProcessingEndpoint(url)).toEqual({ ok: true, destination });
  });

  it("blocks every non-local workload under local_only", () => {
    for (const workload of ["main_llm", "sub_llm", "memory_llm", "embedding", "network_tool"] as const) {
      expect(decideProcessingPolicy({
        profile: "local_only", workload, destination: "external_cloud",
      }).decision).toBe("blocked");
    }
  });

  it("trusted registry can promote a private endpoint and invalid labels fail closed", () => {
    const guard = makeProcessingGuard({
      profiles: { get: () => "ask_before_external" },
    });
    expect(guard.authorize({
      scope: "scope_1", processingProfileRef: "profile_1", workload: "embedding",
      provider, endpoint: { url: "http://10.0.0.2:8000", zone: "private_managed" }, sessionId: "session_1",
    })).toMatchObject({ destination: "private_managed", decision: "allowed" });
    expect(() => guard.authorize({
      scope: "scope_1", processingProfileRef: "profile_1", workload: "embedding",
      provider: { provider: " openai ", model: "gpt-5" },
      endpoint: { url: "http://10.0.0.2:8000", zone: "private_managed" }, sessionId: "session_1",
    })).toThrow();
  });

  it("claims bound external consent exactly once and persists consumption", () => {
    const path = join(mkdtempSync(join(tmpdir(), "naia-consent-")), "consumed.json");
    const record: TrustedConsentRecord = {
      consentId: "consent_1", scope: "scope_1", processingProfileRef: "profile_1",
      destination: "external_cloud", workload: "embedding", sessionId: "session_1",
      expiresAt: 2_000,
    };
    const consents = makeFileConsentStore({ path, records: [record], now: () => 1_000 });
    const guard = makeProcessingGuard({
      profiles: { get: () => "ask_before_external" },
      consents,
      now: () => 1_000,
    });
    const request = {
      scope: "scope_1", processingProfileRef: "profile_1", workload: "embedding" as const,
      provider, endpoint: { url: "https://api.example.com", zone: "unverified" as const }, sessionId: "session_1",
    };
    expect(guard.authorize(request).decision).toBe("allowed");
    expect(() => readFileSync(path, "utf8")).toThrow();
    expect(guard.claimConsent({
      scope: request.scope, processingProfileRef: request.processingProfileRef,
      workload: request.workload, destination: "external_cloud", sessionId: request.sessionId,
    })).toBe(true);
    expect(guard.authorize(request).decision).toBe("confirmation_required");
    expect(guard.claimConsent({
      scope: request.scope, processingProfileRef: request.processingProfileRef,
      workload: request.workload, destination: "external_cloud", sessionId: request.sessionId,
    })).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, consumed: ["consent_1"] });
  });

  it("never promotes a public RunPod URL from trusted-label text alone", () => {
    const guard = makeProcessingGuard({ profiles: { get: () => "ask_before_external" } });
    expect(guard.authorize({
      scope: "scope_1", processingProfileRef: "profile_1", workload: "main_llm",
      provider, endpoint: { url: "https://abc123-8000.proxy.runpod.net", zone: "private_managed" },
      sessionId: "session_1",
    })).toMatchObject({ destination: "external_cloud", decision: "confirmation_required" });
  });

  it("does not consume consent when the critical disclosure is not acknowledged", async () => {
    const claimConsent = vi.fn(() => true);
    const context = makeWireProcessingRequestContext({
      kind: "chat", requestId: "request_1", messages: [{ role: "user", content: "hello" }],
      channel: { kind: "shell" }, processing: { processingProfileRef: "profile_1" },
    }, {
      resolve: () => ({
        kind: "processingDisclosure", processingProfileRef: "profile_1",
        workload: "main_llm", destination: "external_cloud",
        decision: "confirmation_required", provider: "openai", model: "gpt-5",
      }),
      claimConsent,
    }, {
      emit: () => {},
      emitCritical: async () => false,
    });
    await expect(context.ensureAuthorized({
      operationKey: "main:1", workload: "main_llm", provider: "openai", model: "gpt-5",
      endpointUrl: "https://api.openai.com", endpointZone: "unverified", requiresConsent: true,
    })).rejects.toMatchObject({ code: "PROCESSING_DESTINATION_UNKNOWN" });
    expect(claimConsent).not.toHaveBeenCalled();
  });

  it("fails closed when an allowed disclosure is acked but the consent CAS loses a race", async () => {
    const claimConsent = vi.fn(() => false);
    const context = makeWireProcessingRequestContext({
      kind: "chat", requestId: "request_2", messages: [{ role: "user", content: "hello" }],
      channel: { kind: "shell" }, processing: { processingProfileRef: "profile_1" },
    }, {
      resolve: () => ({
        kind: "processingDisclosure", processingProfileRef: "profile_1",
        workload: "main_llm", destination: "external_cloud",
        decision: "allowed", provider: "openai", model: "gpt-5", consentRequired: true,
      }),
      claimConsent,
    }, {
      emit: () => {},
      emitCritical: async () => true,
    });
    await expect(context.ensureAuthorized({
      operationKey: "main:2", workload: "main_llm", provider: "openai", model: "gpt-5",
      endpointUrl: "https://api.openai.com", endpointZone: "unverified", requiresConsent: true,
    })).rejects.toMatchObject({ code: "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED" });
    expect(claimConsent).toHaveBeenCalledOnce();
  });

  it.each([
    ["local_device", false],
    ["private_managed", true],
    ["external_cloud", true],
  ] as const)("does not claim consent for ordinary allowed %s processing", async (destination, requiresConsent) => {
    const claimConsent = vi.fn(() => false);
    const context = makeWireProcessingRequestContext({
      kind: "chat", requestId: `ordinary_${destination}`, messages: [{ role: "user", content: "hello" }],
      channel: { kind: "shell" }, processing: { processingProfileRef: "profile_1" },
    }, {
      resolve: () => ({
        kind: "processingDisclosure", processingProfileRef: "profile_1",
        workload: "main_llm", destination, decision: "allowed",
        provider: "openai", model: "gpt-5",
      }),
      claimConsent,
    }, { emit: () => {}, emitCritical: async () => true });
    await expect(context.ensureAuthorized({
      operationKey: `ordinary:${destination}`, workload: "main_llm", provider: "openai", model: "gpt-5",
      endpointUrl: destination === "local_device" ? "http://127.0.0.1" : "https://example.com",
      endpointZone: "unverified", requiresConsent,
    })).resolves.toBeUndefined();
    expect(claimConsent).not.toHaveBeenCalled();
  });

  it("normalizes unknown profile/endpoint failures without reflecting raw values", async () => {
    const canary = "RAW-ENDPOINT-SECRET";
    const context = makeWireProcessingRequestContext({
      kind: "chat", requestId: "request_3", messages: [{ role: "user", content: "hello" }],
      channel: { kind: "shell" }, processing: { processingProfileRef: "unknown_profile" },
    }, {
      resolve: () => { throw new Error(canary); },
    }, { emit: () => {}, emitCritical: async () => true });
    const error = await context.ensureAuthorized({
      operationKey: "main:3", workload: "main_llm", provider: "openai", model: "gpt-5",
      endpointUrl: `https://${canary}.example`, endpointZone: "unverified", requiresConsent: true,
    }).catch((value: unknown) => value as { code?: string; message?: string });
    expect(error).toMatchObject({ code: "PROCESSING_DESTINATION_UNKNOWN" });
    expect(JSON.stringify(error)).not.toContain(canary);
  });

  it("binds one immutable policy generation for every operation in a request", async () => {
    let generation = "old";
    const seen: string[] = [];
    const policy = {
      bind: () => {
        const captured = generation;
        return {
          resolve: (_req: unknown, operation: { workload: string; provider: string; model: string }) => {
            seen.push(captured);
            return {
              kind: "processingDisclosure" as const, processingProfileRef: "profile_1",
              workload: operation.workload as "main_llm", destination: "local_device" as const,
              decision: "allowed" as const, provider: operation.provider, model: operation.model,
            };
          },
        };
      },
      resolve: () => undefined,
    };
    const request = {
      kind: "chat" as const, requestId: "snapshot_1", messages: [{ role: "user" as const, content: "x" }],
      processing: { processingProfileRef: "profile_1" },
    };
    const first = makeWireProcessingRequestContext(request, policy, {
      emit: () => {}, emitCritical: async () => true,
    });
    generation = "new";
    for (const suffix of ["1", "2"]) {
      await first.ensureAuthorized({
        operationKey: `main:${suffix}`, workload: "main_llm", provider: "openai", model: "gpt-5",
        endpointUrl: "http://127.0.0.1", endpointZone: "unverified", requiresConsent: false,
      });
    }
    const second = makeWireProcessingRequestContext({ ...request, requestId: "snapshot_2" }, policy, {
      emit: () => {}, emitCritical: async () => true,
    });
    await second.ensureAuthorized({
      operationKey: "main:3", workload: "main_llm", provider: "openai", model: "gpt-5",
      endpointUrl: "http://127.0.0.1", endpointZone: "unverified", requiresConsent: false,
    });
    expect(seen).toEqual(["old", "old", "new"]);
  });

  it("does not claim a shell consent from another workspace scope", () => {
    const path = join(mkdtempSync(join(tmpdir(), "naia-consent-scope-")), "consumed.json");
    const record: TrustedConsentRecord = {
      consentId: "consent_1", scope: "ws_alpha", processingProfileRef: "profile_1",
      destination: "external_cloud", workload: "main_llm", sessionId: "session_1",
      expiresAt: 2_000,
    };
    const store = makeFileConsentStore({ path, records: [record] });
    expect(store.claimExact({
      scope: "ws_beta", processingProfileRef: "profile_1", destination: "external_cloud",
      workload: "main_llm", sessionId: "session_1", now: 1_000,
    })).toBeUndefined();
    expect(store.claimExact({
      scope: "ws_alpha", processingProfileRef: "profile_1", destination: "external_cloud",
      workload: "main_llm", sessionId: "session_1", now: 1_000,
    })).toEqual(record);
  });

  it("allows exactly one claim across two stale stores sharing a state path", () => {
    const path = join(mkdtempSync(join(tmpdir(), "naia-consent-cas-")), "consumed.json");
    const record: TrustedConsentRecord = {
      consentId: "consent_1", scope: "scope_1", processingProfileRef: "profile_1",
      destination: "external_cloud", workload: "main_llm", sessionId: "session_1",
      expiresAt: 2_000,
    };
    const a = makeFileConsentStore({ path, records: [record] });
    const b = makeFileConsentStore({ path, records: [record] });
    const query = {
      scope: "scope_1", processingProfileRef: "profile_1", destination: "external_cloud" as const,
      workload: "main_llm" as const, sessionId: "session_1", now: 1_000,
    };
    expect([a.claimExact(query), b.claimExact(query)].filter(Boolean)).toHaveLength(1);
  });

  it.each([
    { scope: "other_scope" },
    { sessionId: "other_session" },
    { processingProfileRef: "other_profile" },
    { workload: "main_llm" as const },
    { destination: "private_managed" as const },
    { expiresAt: 1_000 },
  ])("rejects mismatched or expired consent before claim: %o", (patch) => {
    const record: TrustedConsentRecord = {
      consentId: "consent_1", scope: "scope_1", processingProfileRef: "profile_1",
      destination: "external_cloud", workload: "embedding", sessionId: "session_1",
      expiresAt: 2_000, ...patch,
    };
    const claimExact = vi.fn((query: {
      scope: string; processingProfileRef: string; destination: string;
      workload: string; sessionId: string; now: number;
    }) => record.scope === query.scope && record.processingProfileRef === query.processingProfileRef
      && record.destination === query.destination && record.workload === query.workload
      && record.sessionId === query.sessionId && record.expiresAt > query.now
      ? record : undefined);
    const guard = makeProcessingGuard({
      profiles: { get: () => "ask_before_external" },
      consents: { hasExact: () => true, claimExact },
      now: () => 1_000,
    });
    const request = {
      scope: "scope_1", processingProfileRef: "profile_1", workload: "embedding",
      provider, endpoint: { url: "https://api.example.com", zone: "unverified" }, sessionId: "session_1",
    } as const;
    expect(guard.authorize(request).decision).toBe("allowed");
    expect(guard.claimConsent({
      scope: request.scope, processingProfileRef: request.processingProfileRef,
      workload: request.workload, destination: "external_cloud", sessionId: request.sessionId,
    })).toBe(false);
    expect(claimExact).toHaveBeenCalledOnce();
  });
});
