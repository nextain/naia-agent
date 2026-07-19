import { describe, expect, it, vi } from "vitest";
import { makeProcessingRequestContext } from "../main/adapters/processing-request-context.js";
import type { ProcessingOperation } from "../main/ports/processing.js";

const operation: ProcessingOperation = {
  operationKey: "main-llm:round-1",
  workload: "main_llm",
  provider: "openai",
  model: "gpt-5",
  endpointUrl: "https://api.openai.com/v1",
  endpointZone: "unverified",
  requiresConsent: true,
};

describe("request-bound processing context", () => {
  it("shares one authorization promise across concurrent duplicate calls", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const authorize = vi.fn(() => pending);
    const context = makeProcessingRequestContext(authorize);
    const first = context.ensureAuthorized(operation);
    const second = context.ensureAuthorized({ ...operation });
    await Promise.resolve();
    expect(authorize).toHaveBeenCalledOnce();
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("caches rejection so the same key cannot consume another consent", async () => {
    const authorize = vi.fn(async () => { throw new Error("blocked"); });
    const context = makeProcessingRequestContext(authorize);
    await expect(context.ensureAuthorized(operation)).rejects.toThrow("blocked");
    await expect(context.ensureAuthorized(operation)).rejects.toThrow("blocked");
    expect(authorize).toHaveBeenCalledOnce();
  });

  it("rejects operation-key collisions with changed trusted metadata", async () => {
    const authorize = vi.fn(async () => {});
    const context = makeProcessingRequestContext(authorize);
    await context.ensureAuthorized(operation);
    await expect(context.ensureAuthorized({
      ...operation,
      workload: "embedding",
    })).rejects.toThrow("PROCESSING_OPERATION_KEY_COLLISION");
    expect(authorize).toHaveBeenCalledOnce();
  });
});
