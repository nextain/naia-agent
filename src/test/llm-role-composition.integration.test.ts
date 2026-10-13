import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs 호스트 조립기(타입 선언 없음). 통합 경계라 의도적.
import { composeAgentRuntimeDeps, resolveMemoryStorePath } from "../../scripts/builds/compose-agent-deps.mjs";

describe("compose-agent-deps 역할별 실제 소비", () => {
  it("기본 메모리 저장소를 활성 ADK의 naia-settings 아래에 둔다", async () => {
    const adk = await mkdtemp(join(tmpdir(), "naia-memory-path-compose-"));
    await mkdir(join(adk, "naia-settings"), { recursive: true });
    const storePath = resolveMemoryStorePath({
      adkPath: adk,
    });

    expect(storePath).toBe(join(adk, "naia-settings", "memory", "store.json"));
    expect(storePath).not.toContain(join(".naia-agent", "memory"));
  });

  it("환경변수로 제품 메모리 정본을 우회하지 않는다", async () => {
    const adk = await mkdtemp(join(tmpdir(), "naia-memory-path-compose-"));
    expect(resolveMemoryStorePath({
      adkPath: adk,
      env: {
        NAIA_MEMORY_STORE: join(adk, "redirected.json"),
        NAIA_MEMORY_DIR: join(adk, "redirected"),
      },
    })).toBe(join(adk, "naia-settings", "memory", "store.json"));
  });

  it("main Codex + sub Ollama + memory Naia 설정을 서로 덮어쓰지 않는다", async () => {
    const adk = await mkdtemp(join(tmpdir(), "naia-role-compose-"));
    await mkdir(join(adk, "naia-settings"), { recursive: true });
    await writeFile(join(adk, "naia-settings", "config.json"), JSON.stringify({
      provider: "codex",
      model: "gpt-5.4",
      llmRoles: {
        main: { provider: "codex", model: "gpt-5.4" },
        sub: { provider: "ollama", model: "qwen3:4b", baseUrl: "http://localhost:11434/v1" },
        memory: {
          provider: "nextain",
          model: "gemini-3.1-flash-lite",
          credentialRef: "NAIA_ANYLLM_API_KEY",
        },
      },
    }), "utf8");

    const deps = await composeAgentRuntimeDeps({
      env: {
        ...process.env,
        NAIA_ADK_PATH: adk,
        AGENT_PROVIDER: "fake",
        NAIA_AGENT_SKILLS: "off",
        NAIA_AGENT_MEMORY: "off",
        NAIA_AGENT_TRANSCRIPT: "off",
        NAIA_ANYLLM_API_KEY: "test-secret",
      },
    });
    expect(deps.defaultConfig).toEqual({ provider: "codex", model: "gpt-5.4" });
    expect(deps.subLlm).toMatchObject({ provider: "ollama", model: "qwen3:4b" });
    expect(deps.roleLabel).toContain("main=codex/gpt-5.4:explicit");
    expect(deps.roleLabel).toContain("sub=ollama/qwen3:4b:explicit");
    expect(deps.roleLabel).toContain("memory=nextain/gemini-3.1-flash-lite:explicit");
    expect(deps.roleLabel).not.toContain("test-secret");
  });
});
