import { expect, it } from "vitest";
import { makeNaiaSettingsStore } from "../main/adapters/naia-settings-store.js";
import { resolveRoleRuntimeConfig } from "../main/adapters/llm-role-runtime.js";
import { buildSubLlmProvider } from "../main/adapters/sub-llm-provider.js";

it("IT-SM-AGENT-02 옛 기억만 있는 범용 소비와 별도 작은 선택을 이어 쓴다", async () => {
  let config: Record<string, unknown> = { provider: "openai", model: "main", memoryLlmProvider: "nextain", memoryLlmModel: "old-memory", memoryLlmBaseUrl: "https://old.invalid/v1", memoryLlmCredentialRef: "KEY" };
  const file = "/ws/naia-settings/config.json";
  const settings = makeNaiaSettingsStore({ fs: { existsSync: (path) => path === file, readFileSync: () => JSON.stringify(config) }, resolveSecret: () => "fake" });
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch = async (url: string, init: { body: string }) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"ok"}}]}' }; };
  const run = async () => {
    const roles = settings.loadLlmRoles("/ws");
    if (!roles?.ok) throw new Error("roles unavailable");
    const sub = resolveRoleRuntimeConfig(roles.configs[1], () => "fake");
    if (!sub.ok) throw new Error(sub.reason);
    await buildSubLlmProvider(sub.config, { fetch })!.complete("test", { authorizeAndDisclose: async () => true });
    return roles.configs[2];
  };
  expect((await run()).model.value).toBe("old-memory");
  expect(sent[0]).toMatchObject({ url: "https://old.invalid/v1/chat/completions", body: { model: "old-memory" } });
  config = { ...config, llmRoles: { sub: { provider: "nextain", model: "new-small", baseUrl: "https://new.invalid/v1", credentialRef: "KEY", thinkingLevel: "xhigh" } } };
  expect((await run()).model.value).toBe("old-memory");
  expect(sent[1]).toMatchObject({ url: "https://new.invalid/v1/chat/completions", body: { model: "new-small", reasoning_effort: "xhigh" } });
});
