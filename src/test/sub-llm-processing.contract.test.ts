import { describe, expect, it, vi } from "vitest";
import { buildSubLlmProvider } from "../main/adapters/sub-llm-provider.js";
import { runWithProcessingRequestContext } from "../main/adapters/processing-operation-decorators.js";
import { makeProcessingRequestContext } from "../main/adapters/processing-request-context.js";

describe("direct sub-LLM processing boundary", () => {
  it("authorizes sub_llm immediately before fetch and blocks background calls", async () => {
    const fetch = vi.fn(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
    }));
    const sub = buildSubLlmProvider({
      provider: "vllm", baseUrl: "https://sub.example.com/v1", model: "small",
    }, { fetch })!;
    await expect(sub.complete("background")).rejects.toThrow("PROCESSING_REQUEST_CONTEXT_REQUIRED");
    expect(fetch).not.toHaveBeenCalled();
    const authorize = vi.fn(async (operation) => {
      expect(operation).toMatchObject({
        workload: "sub_llm", provider: "vllm", model: "small",
        endpointUrl: "https://sub.example.com/v1",
      });
    });
    await expect(runWithProcessingRequestContext(makeProcessingRequestContext(authorize), () =>
      sub.complete("request"))).resolves.toBe("ok");
    expect(authorize).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
