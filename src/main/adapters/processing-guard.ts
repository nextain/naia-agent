import type {
  ProcessingDisclosure,
  ProcessingWorkload,
} from "../domain/chat.js";
import {
  classifyProcessingEndpoint,
  decideProcessingPolicy,
  type ProcessingProfile,
} from "../domain/processing-policy.js";
import {
  validateAndClaimConsent,
  validateProcessingDisclosure,
  type TrustedConsentRecord,
} from "../domain/security-wire.js";
import type { ProcessingGuardPort } from "../ports/uc1.js";

export interface TrustedEndpointRecord {
  readonly url?: string;
  readonly destination?: ProcessingDisclosure["destination"];
  readonly zone: "unverified" | "private_managed";
  readonly provider?: string;
  readonly model?: string;
}

export interface ProcessingProfileStore {
  get(processingProfileRef: string): ProcessingProfile | undefined;
}

export interface TrustedEndpointRegistry {
  resolve(
    provider: { readonly provider: string; readonly model: string },
    workload: ProcessingWorkload,
  ): TrustedEndpointRecord | undefined;
}

export interface TrustedConsentStore {
  find(input: {
    readonly processingProfileRef: string;
    readonly destination: ProcessingDisclosure["destination"];
    readonly workload: ProcessingWorkload;
    readonly sessionId: string;
  }): TrustedConsentRecord | undefined;
  claim(consentId: string): boolean;
}

/**
 * All authority-bearing inputs come from injected trusted stores. Request,
 * message, model output, and raw endpoint text cannot select a profile zone or
 * claim consent.
 */
export function makeProcessingGuard(deps: {
  readonly profiles: ProcessingProfileStore;
  readonly endpoints: TrustedEndpointRegistry;
  readonly consents?: TrustedConsentStore;
  readonly now?: () => number;
}): ProcessingGuardPort {
  return {
    authorize(input) {
      const profile = deps.profiles.get(input.processingProfileRef);
      if (!profile) throw new Error("processing profile not found");
      const endpoint = deps.endpoints.resolve(input.provider, input.workload);
      if (!endpoint) throw new Error("processing endpoint not found");
      const classified = endpoint.destination
        ? { ok: true as const, destination: endpoint.destination }
        : classifyProcessingEndpoint(endpoint.url);
      if (!classified.ok) throw new Error(classified.code);
      const destination = endpoint.zone === "private_managed"
        && classified.destination === "external_cloud"
        ? "private_managed"
        : classified.destination;
      const policy = decideProcessingPolicy({
        profile,
        workload: input.workload,
        destination,
      });
      const base: ProcessingDisclosure = {
        workload: input.workload,
        destination,
        decision: policy.decision,
        processingProfileRef: input.processingProfileRef,
        provider: endpoint.provider ?? input.provider.provider,
        model: endpoint.model ?? input.provider.model,
      };
      const validated = validateProcessingDisclosure({
        kind: "processingDisclosure",
        ...base,
      });
      if (!validated.ok) throw new Error(validated.error.code);
      if (policy.decision !== "confirmation_required" || !deps.consents) return base;
      const consent = deps.consents.find({
        processingProfileRef: input.processingProfileRef,
        destination,
        workload: input.workload,
        sessionId: input.sessionId,
      });
      const claimed = validateAndClaimConsent({ kind: "processingDisclosure", ...base }, {
        sessionId: input.sessionId,
        now: (deps.now ?? Date.now)(),
        consent,
        claim: (consentId) => deps.consents!.claim(consentId),
      });
      return claimed.ok ? { ...base, decision: "allowed" } : base;
    },
  };
}
