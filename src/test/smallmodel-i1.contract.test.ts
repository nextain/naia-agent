import { describe, expect, it } from "vitest";
import { resolveLlmRoles } from "../main/domain/llm-roles.js";
import { buildSubLlmProvider, withMainFallback } from "../main/adapters/sub-llm-provider.js";
import { resolveMemoryRoleEndpoint } from "../main/adapters/llm-role-runtime.js";

describe("small model role", () => {
  it("classifies only an actual configured memory or main endpoint", () => {
    const roles = resolveLlmRoles({ roles: {
      main: { provider: "nextain", model: "main", baseUrl: "https://main.invalid/v1" },
      sub: { provider: "nextain", model: "small", baseUrl: "https://small.invalid/v1" },
    }});
    const secret = () => "fake-key";
    expect(resolveMemoryRoleEndpoint(roles, { provider: "nextain", model: "small" }, secret)).toBe("https://small.invalid/v1");
    expect(resolveMemoryRoleEndpoint(roles, { provider: "nextain", model: "main" }, secret)).toBe("https://main.invalid/v1");
    expect(resolveMemoryRoleEndpoint(roles, { provider: "nextain", model: "unknown" }, secret)).toBeUndefined();
  });
  it("preserves the low thinking setting into the sub request", async () => {
    const result = resolveLlmRoles({ roles: { main: { provider: "nextain", model: "main" }, sub: { provider: "nextain", model: "small", thinkingLevel: "low" } } });
    expect(result.ok && result.configs[1].thinkingLevel?.value).toBe("low");
    const bodies: Array<Record<string, unknown>> = [];
    const port = buildSubLlmProvider({ provider: "nextain", model: "small", baseUrl: "https://example.invalid", thinkingLevel: "low" }, { fetch: async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"ok"}}]}' }; } })!;
    await port.complete("x", { authorizeAndDisclose: async () => true });
    expect(bodies[0].reasoning_effort).toBe("low");
  });
  it("a legacy memory choice fills an empty sub role", () => {
    const result = resolveLlmRoles({ legacy: {
      main: { provider: "nextain", model: "main" },
      memory: { provider: "ollama", model: "memory" },
    }});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.configs[1].model.value).toBe("memory");
      expect(result.configs[2].model.value).toBe("memory");
    }
  });
  it("an incomplete sub role inherits main", () => {
    const result = resolveLlmRoles({ roles: {
      main: { provider: "nextain", model: "main" },
      sub: { provider: "ollama" },
    }});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.configs[1].model.value).toBe("main");
  });
  it("an incomplete structured sub does not revive a stale legacy sub", () => {
    const result = resolveLlmRoles({
      roles: { main: { provider: "nextain", model: "main" }, sub: { provider: "ollama" } },
      legacy: { sub: { provider: "nextain", model: "old" } },
    });
    expect(result.ok && result.configs[1].model.value).toBe("main");
  });
});

describe("small model failure fallback", () => {
  const authorizeAndDisclose = async () => true;
  const config = (model: string, provider = "nextain") => ({ provider, model, baseUrl: "https://example.invalid/v1" });
  for (const failure of ["429", "503", "timeout", "format"]) {
    it(`${failure} retries main once`, async () => {
      const models: string[] = [];
      const fetch = async (_url: string, init: { body: string }) => {
        const model = JSON.parse(init.body).model as string;
        models.push(model);
        if (model === "small") {
          if (failure === "timeout") throw new Error("timeout");
          return { ok: failure === "format", status: Number(failure), text: async () => failure === "format" ? "bad JSON" : "failure" };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
      };
      const small = buildSubLlmProvider(config("small"), { fetch, strictResponse: true })!;
      const main = buildSubLlmProvider(config("main"), { fetch })!;
      const port = withMainFallback(small, main, () => {});
      await expect(port.complete("hello", { authorizeAndDisclose })).resolves.toBe("ok");
      expect(models).toEqual(["small", "main"]);
    });
  }
  it("does not call main for a local model or when authorization is denied", async () => {
    const models: string[] = [];
    const fetch = async (_url: string, init: { body: string }) => {
      models.push(JSON.parse(init.body).model);
      return { ok: false, status: 503, text: async () => "error" };
    };
    const small = buildSubLlmProvider(config("small", "ollama"), { fetch })!;
    const main = buildSubLlmProvider(config("main"), { fetch })!;
    await expect(withMainFallback(small, main, () => {}).complete("x", { authorizeAndDisclose })).rejects.toThrow();
    expect(models).toEqual(["small"]);
    const cloud = buildSubLlmProvider(config("small"), { fetch })!;
    await expect(withMainFallback(cloud, main, () => {}).complete("x", { authorizeAndDisclose: async () => false })).rejects.toThrow("SUB_LLM_PROCESSING_NOT_AUTHORIZED");
    expect(models).toEqual(["small"]);
  });
  it("preserves the original error when main also fails and emits no response body", async () => {
    const first = new Error("private response");
    const log: unknown[] = [];
    const sub = { provider: "nextain", model: "small", complete: async () => { throw first; }, completeMessages: async () => { throw first; } };
    const main = { provider: "nextain", model: "main", complete: async () => { throw new Error("other"); }, completeMessages: async () => { throw new Error("other"); } };
    await expect(withMainFallback(sub, main, (event) => log.push(event)).complete("x", { authorizeAndDisclose })).rejects.toBe(first);
    expect(JSON.stringify(log)).not.toContain("private response");
  });
});

it("UT-SM-AGENT-03 각 대상 승인과 한 번 폴백 및 최초 오류를 지킨다: 로컬 OpenAI 호환 주소", async () => {
  const calls: string[] = [];
  const fetch = async (_url: string, init: { body: string }) => { calls.push(JSON.parse(init.body).model); return { ok: false, status: 503, text: async () => "failure" }; };
  const local = buildSubLlmProvider({ provider: "openai-compat", model: "qwen", baseUrl: "http://localhost:8000/v1" }, { fetch })!;
  const main = buildSubLlmProvider({ provider: "nextain", model: "main", baseUrl: "https://example.invalid/v1" }, { fetch })!;
  await expect(withMainFallback(local, main, () => {}).complete("x", { authorizeAndDisclose: async () => true })).rejects.toThrow();
  expect(calls).toEqual(["qwen"]);
});

it("same provider and model at different endpoints remains a distinct approved fallback", async () => {
  const urls: string[] = [];
  const fetch = async (url: string) => { urls.push(url); return url.includes("first") ? { ok: false, status: 503, text: async () => "" } : { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"ok"}}]}' }; };
  const first = buildSubLlmProvider({ provider: "nextain", model: "same", baseUrl: "https://first.invalid" }, { fetch })!;
  const second = buildSubLlmProvider({ provider: "nextain", model: "same", baseUrl: "https://second.invalid" }, { fetch })!;
  await expect(withMainFallback(first, second, () => {}).complete("x", { authorizeAndDisclose: async () => true })).resolves.toBe("ok");
  expect(urls).toEqual(["https://first.invalid/chat/completions", "https://second.invalid/chat/completions"]);
});

it("main endpoint classification uses the real provider route and rejects ambiguity", () => {
  const roles = resolveLlmRoles({ roles: { main: { provider: "anthropic", model: "main" }, sub: { provider: "nextain", model: "small" } } });
  expect(resolveMemoryRoleEndpoint(roles, { provider: "anthropic", model: "main" }, () => "fake", { provider: "anthropic", model: "main" })).toBe("https://api.anthropic.com");
});

it("a delayed approval after cancellation never reaches transport", async () => {
  const controller = new AbortController();
  let resolve!: (value: boolean) => void;
  const approval = new Promise<boolean>((done) => { resolve = done; });
  let calls = 0;
  const sub = buildSubLlmProvider({ provider: "nextain", model: "small", baseUrl: "https://example.invalid" }, { fetch: async () => { calls++; return { ok: true, status: 200, text: async () => "ok" }; } })!;
  const pending = sub.complete("x", { signal: controller.signal, authorizeAndDisclose: async () => approval });
  controller.abort(); resolve(true);
  await expect(pending).rejects.toThrow("SUB_LLM_ABORTED"); expect(calls).toBe(0);
});

it("configuration changes while waiting for approval block the old transport", async () => {
  const { bindMemoryAuthorization } = await import("../main/adapters/llm-role-runtime.js");
  let current = "https://old.invalid";
  let respond!: (value: boolean) => void;
  const decision = new Promise<boolean>((resolve) => { respond = resolve; });
  const authorize = bindMemoryAuthorization(() => current, async () => decision);
  let calls = 0;
  const port = buildSubLlmProvider({ provider: "nextain", model: "small", baseUrl: current }, { fetch: async () => { calls++; return { ok: true, status: 200, text: async () => "ok" }; } })!;
  const pending = port.complete("x", { authorizeAndDisclose: authorize });
  current = "https://new.invalid"; respond(true);
  await expect(pending).rejects.toThrow("SUB_LLM_PROCESSING_NOT_AUTHORIZED");
  expect(calls).toBe(0);
});

it("a role swap during approval cannot authorize the old memory destination as main", async () => {
  const { bindMemoryAuthorization } = await import("../main/adapters/llm-role-runtime.js");
  let memoryUrl = "https://first.invalid";
  let mainUrl = "https://second.invalid";
  const current = () => resolveLlmRoles({ roles: { main: { provider: "nextain", model: "same", baseUrl: mainUrl }, memory: { provider: "nextain", model: "same", baseUrl: memoryUrl } } });
  let reply!: (value: boolean) => void;
  const answer = new Promise<boolean>((resolve) => { reply = resolve; });
  const authorize = bindMemoryAuthorization((input) => resolveMemoryRoleEndpoint(current(), input, () => "fake", undefined, input.endpoint, input.role), async () => answer);
  let sent = 0;
  const port = buildSubLlmProvider({ provider: "nextain", model: "same", baseUrl: memoryUrl }, { fetch: async () => { sent++; return { ok: true, status: 200, text: async () => "ok" }; } })!;
  const pending = port.complete("x", { authorizeAndDisclose: (input) => authorize({ ...input, role: "memory" }) });
  [memoryUrl, mainUrl] = [mainUrl, memoryUrl]; reply(true);
  await expect(pending).rejects.toThrow("SUB_LLM_PROCESSING_NOT_AUTHORIZED"); expect(sent).toBe(0);
});

it("UT-SM-AGENT-03 각 대상 승인과 한 번 폴백 및 최초 오류를 지킨다", async () => {
  const calls: string[] = [];
  const fetch = async (_url: string, init: { body: string }) => { const model = JSON.parse(init.body).model; calls.push(model); return { ok: false, status: model === "small" ? 429 : 503, text: async () => "" }; };
  const small = buildSubLlmProvider({ provider: "nextain", model: "small", baseUrl: "https://small.invalid" }, { fetch })!;
  const main = buildSubLlmProvider({ provider: "nextain", model: "main", baseUrl: "https://main.invalid" }, { fetch })!;
  const port = withMainFallback(small, main, () => {});
  await expect(port.complete("x", { authorizeAndDisclose: async () => false })).rejects.toThrow("SUB_LLM_PROCESSING_NOT_AUTHORIZED"); expect(calls).toEqual([]);
  await expect(port.complete("x", { authorizeAndDisclose: async ({ model }) => model === "small" })).rejects.toMatchObject({ status: 429 }); expect(calls).toEqual(["small"]);
  calls.length = 0;
  await expect(port.complete("x", { authorizeAndDisclose: async () => true })).rejects.toMatchObject({ status: 429 }); expect(calls).toEqual(["small", "main"]);
});
