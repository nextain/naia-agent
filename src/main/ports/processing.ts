import type { ProcessingWorkload } from "../domain/chat.js";

/** Trusted metadata supplied by the adapter that owns the real operation. */
export interface ProcessingOperation {
  readonly operationKey: string;
  readonly workload: ProcessingWorkload;
  readonly provider: string;
  readonly model: string;
  readonly endpointUrl: string;
  readonly endpointZone: "unverified" | "private_managed";
  readonly requiresConsent: boolean;
}

/**
 * Request-bound capability handed to driven ports. App code does not choose a
 * workload; the adapter immediately before the real operation supplies it.
 */
export interface ProcessingRequestContext {
  ensureAuthorized(operation: ProcessingOperation): Promise<void>;
}
