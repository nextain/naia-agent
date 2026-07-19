import type { ProcessingDisclosure, ProcessingWorkload } from "../domain/chat.js";
import {
  classifyProcessingEndpoint,
  decideProcessingPolicy,
  isNonPublicManagedEndpoint,
  type ProcessingProfile,
} from "../domain/processing-policy.js";
import {
  validateProcessingDisclosureEvent,
  validateTrustedConsent,
  type TrustedConsentRecord,
} from "../domain/wire-v1.js";

export interface TrustedEndpointRecord {
  readonly url: string;
  readonly zone: "unverified" | "private_managed";
}
export interface TrustedConsentStore {
  /** Read-only availability probe. The later claimExact remains authoritative. */
  hasExact(input: {
    readonly scope: string;
    readonly processingProfileRef: string;
    readonly destination: ProcessingDisclosure["destination"];
    readonly workload: ProcessingWorkload;
    readonly sessionId: string;
    readonly now: number;
  }): boolean;
  /** Validate the complete binding and persist unused→used as one store operation. */
  claimExact(input: {
    readonly scope: string;
    readonly processingProfileRef: string;
    readonly destination: ProcessingDisclosure["destination"];
    readonly workload: ProcessingWorkload;
    readonly sessionId: string;
    readonly now: number;
  }): TrustedConsentRecord | undefined;
}

/**
 * Policy authority is injected trusted state. A request supplies only opaque
 * profile/session/scope bindings and cannot classify its own destination.
 */
export function makeProcessingGuard(deps: {
  readonly profiles: { get(ref: string): ProcessingProfile | undefined };
  readonly consents?: TrustedConsentStore;
  readonly now?: () => number;
}) {
  return {
    authorize(input: {
      readonly scope: string;
      readonly processingProfileRef: string;
      readonly workload: ProcessingWorkload;
      readonly provider: { readonly provider: string; readonly model: string };
      readonly endpoint: TrustedEndpointRecord;
      readonly sessionId: string;
    }): ProcessingDisclosure & { readonly consentRequired?: boolean } {
      const profile = deps.profiles.get(input.processingProfileRef);
      if (!profile) throw new Error("PROCESSING_PROFILE_NOT_FOUND");
      const endpoint = input.endpoint;
      const classified = classifyProcessingEndpoint(endpoint.url);
      if (!classified.ok) throw new Error(classified.code);
      const destination = endpoint.zone === "private_managed"
        && classified.destination === "external_cloud"
        && isNonPublicManagedEndpoint(endpoint.url)
        ? "private_managed"
        : classified.destination;
      const policy = decideProcessingPolicy({ profile, workload: input.workload, destination });
      const disclosure: ProcessingDisclosure = {
        workload: input.workload,
        destination,
        decision: policy.decision,
        processingProfileRef: input.processingProfileRef,
        provider: input.provider.provider,
        model: input.provider.model,
      };
      const checked = validateProcessingDisclosureEvent({ kind: "processingDisclosure", ...disclosure });
      if (!checked.ok) throw new Error(checked.error.code);
      if (policy.decision === "confirmation_required" && deps.consents) {
        const available = deps.consents.hasExact({
          scope: input.scope,
          processingProfileRef: input.processingProfileRef,
          destination,
          workload: input.workload,
          sessionId: input.sessionId,
          now: (deps.now ?? Date.now)(),
        });
        if (available) return { ...disclosure, decision: "allowed", consentRequired: true };
      }
      return disclosure;
    },
    claimConsent(input: {
      readonly scope: string;
      readonly processingProfileRef: string;
      readonly workload: ProcessingWorkload;
      readonly destination: ProcessingDisclosure["destination"];
      readonly sessionId: string;
    }): boolean {
      const profile = deps.profiles.get(input.processingProfileRef);
      if (profile !== "ask_before_external" || input.destination !== "external_cloud") return true;
      if (!deps.consents) return false;
      const now = (deps.now ?? Date.now)();
      const consent = deps.consents.claimExact({
        scope: input.scope,
        processingProfileRef: input.processingProfileRef,
        destination: input.destination,
        workload: input.workload,
        sessionId: input.sessionId,
        now,
      });
      const claimed = validateTrustedConsent(
        {
          kind: "processingDisclosure",
          workload: input.workload,
          destination: input.destination,
          decision: "confirmation_required",
          processingProfileRef: input.processingProfileRef,
        },
        {
          scope: input.scope,
          sessionId: input.sessionId,
          now,
          consent,
          // claimExact already performed the atomic transition after checking the
          // complete binding. This callback only completes domain shape checks.
          claim: () => consent !== undefined,
        },
      );
      return claimed.ok;
    },
  };
}
