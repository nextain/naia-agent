import type {
  ProcessingOperation,
  ProcessingRequestContext,
} from "../ports/processing.js";

function fingerprint(operation: ProcessingOperation): string {
  return JSON.stringify([
    operation.workload,
    operation.provider,
    operation.model,
    operation.endpointUrl,
    operation.endpointZone,
    operation.requiresConsent,
  ]);
}

/**
 * Deduplicates concurrent attempts for the same actual operation. Rejections
 * remain cached: retrying a blocked key inside the request cannot bypass policy.
 */
export function makeProcessingRequestContext(
  authorize: (operation: ProcessingOperation) => Promise<void>,
): ProcessingRequestContext {
  const operations = new Map<string, {
    readonly fingerprint: string;
    readonly result: Promise<void>;
  }>();
  return {
    ensureAuthorized(operation) {
      if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(operation.operationKey)) {
        return Promise.reject(new Error("PROCESSING_OPERATION_INVALID"));
      }
      const mark = fingerprint(operation);
      const prior = operations.get(operation.operationKey);
      if (prior) {
        return prior.fingerprint === mark
          ? prior.result
          : Promise.reject(new Error("PROCESSING_OPERATION_KEY_COLLISION"));
      }
      const result = Promise.resolve().then(() => authorize(operation));
      operations.set(operation.operationKey, { fingerprint: mark, result });
      return result;
    },
  };
}
