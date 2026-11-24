import { expect, it } from "vitest";
import { makeNaiaSettingsStore } from "../main/adapters/naia-settings-store.js";
import { resolveRoleRuntimeConfig } from "../main/adapters/llm-role-runtime.js";
import { buildSubLlmProvider } from "../main/adapters/sub-llm-provider.js";

it("IT-SM-AGENT-02 옛 기억만 있는 범용 소비와 별도 작은 선택을 이어 쓴다", async () => {
  let config: Record<string, unknown> = { provider: "openai", model: "main", memoryLlmProvider: "nextain", memoryLlmModel: "old-memory", memoryLlmBaseUrl: "https://old.invalid/v1", memoryLlmCredentialRef: "OLD_REF" };
  const file = "/ws/naia-settings/config.json";
  const refs: string[] = [];
  const resolveSecret = (ref: string) => { refs.push(ref); return ref === "OLD_REF" ? "old-credential" : ref === "NEW_REF" ? "new-credential" : undefined; };
  const settings = makeNaiaSettingsStore({ fs: { existsSync: (path) => path === file, readFileSync: () => JSON.stringify(config) }, resolveSecret });
  const sent: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetch = async (url: string, init: { body: string; headers: Record<string, string> }) => { sent.push({ url, body: JSON.parse(init.body), headers: init.headers }); return { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"ok"}}]}' }; };
  const run = async () => {
    const roles = settings.loadLlmRoles("/ws");
    if (!roles?.ok) throw new Error("roles unavailable");
    const sub = resolveRoleRuntimeConfig(roles.configs[1], resolveSecret);
    if (!sub.ok) throw new Error(sub.reason);
    await buildSubLlmProvider(sub.config, { fetch })!.complete("test", { authorizeAndDisclose: async () => true });
    return roles.configs[2];
  };
  expect(await run()).toMatchObject({ model: { value: "old-memory" }, credentialRef: { value: "OLD_REF" } });
  expect(refs).toContain("OLD_REF");
  expect(sent[0]?.headers["X-AnyLLM-Key"]).toBe("Bearer old-credential");
  expect(sent[0]).toMatchObject({ url: "https://old.invalid/v1/chat/completions", body: { model: "old-memory" } });
  config = { ...config, llmRoles: { sub: { provider: "nextain", model: "new-small", baseUrl: "https://new.invalid/v1", credentialRef: "NEW_REF", thinkingLevel: "xhigh" } } };
  expect(await run()).toMatchObject({ model: { value: "old-memory" }, credentialRef: { value: "OLD_REF" } });
  expect(refs).toContain("NEW_REF");
  expect(sent[1]?.headers["X-AnyLLM-Key"]).toBe("Bearer new-credential");
  expect(sent[1]).toMatchObject({ url: "https://new.invalid/v1/chat/completions", body: { model: "new-small", reasoning_effort: "xhigh" } });
});
