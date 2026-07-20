import { describe, expect, it } from "vitest";
import {
  checkCodexPreflight,
  makeCodexAppServerProvider,
  type CodexRunTurn,
  type CodexTurnInput,
} from "../main/adapters/codex-app-server-provider.js";
import { makeProviderResolver } from "../main/adapters/provider-resolver.js";
import { resolveProviderRoute } from "../main/domain/provider-route.js";
import type { ProviderChunk } from "../main/domain/chat.js";

async function collect(stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const chunks: ProviderChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("Codex app-server main provider", () => {
  it("codex는 OpenAI API-key native가 아닌 전용 route다", () => {
    expect(resolveProviderRoute({ provider: "codex", model: "gpt-5.4" })).toBe("codex");
  });

  it("메시지/system/model을 app-server turn에 전달하고 정규화 chunk를 방출한다", async () => {
    let captured: CodexTurnInput | undefined;
    const runTurn: CodexRunTurn = (input) => {
      captured = input;
      return (async function* () {
        yield { kind: "thinking", text: "검토" } as const;
        yield { kind: "text", text: "안녕하세요" } as const;
        yield { kind: "usage", inputTokens: 11, outputTokens: 7 } as const;
        yield { kind: "completed" } as const;
      })();
    };
    const provider = makeCodexAppServerProvider({ runTurn });
    const chunks = await collect(provider.chat(
      { provider: "codex", model: "gpt-5.4" },
      [
        { role: "system", content: "한국어로 답해" },
        { role: "user", content: "안녕" },
      ],
      { systemPrompt: "간결하게" },
    ));

    expect(captured?.model).toBe("gpt-5.4");
    expect(captured?.systemPrompt).toContain("간결하게");
    expect(captured?.systemPrompt).toContain("한국어로 답해");
    expect(captured?.prompt).toContain("User: 안녕");
    expect(chunks).toEqual([
      { kind: "thinking", text: "검토" },
      { kind: "text", text: "안녕하세요" },
      { kind: "usage", inputTokens: 11, outputTokens: 7 },
      { kind: "finish" },
    ]);
  });

  it("resolver는 fetch/API key 없이 Codex transport를 선택한다", async () => {
    let fetchCalls = 0;
    const resolver = makeProviderResolver({
      fetch: (async () => {
        fetchCalls++;
        throw new Error("must not fetch");
      }) as never,
      codexRunTurn: () => (async function* () {
        yield { kind: "text", text: "ok" } as const;
        yield { kind: "completed" } as const;
      })(),
    });
    const config = { provider: "codex", model: "gpt-5.4" };
    const chunks = await collect(resolver.resolve(config).chat(config, [{ role: "user", content: "hi" }], {}));
    expect(fetchCalls).toBe(0);
    expect(chunks).toEqual([{ kind: "text", text: "ok" }, { kind: "finish" }]);
  });

  it("CLI preflight가 설치/로그인 상태를 token 노출 없이 분류한다", async () => {
    await expect(checkCodexPreflight(async () => ({
      code: 0,
      stdout: "Logged in using ChatGPT",
      stderr: "",
    }))).resolves.toEqual({ status: "ready", detail: "Logged in using ChatGPT" });
    await expect(checkCodexPreflight(async () => ({
      code: 1,
      stdout: "",
      stderr: "Not logged in",
    }))).resolves.toEqual({ status: "login-required", detail: "Not logged in" });
    await expect(checkCodexPreflight(async () => {
      throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    })).resolves.toEqual({ status: "not-installed", detail: "Codex CLI not installed" });
  });
});
