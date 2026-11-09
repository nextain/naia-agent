import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCodexExecProvider, runCodexExec, type CodexExecInput } from "../main/adapters/codex-exec-provider.js";
import { makeProviderResolver } from "../main/adapters/provider-resolver.js";
import { providerProcessingEndpoint, resolveProviderRoute } from "../main/domain/provider-route.js";

const config = { provider: "codex-exec", model: "host-selected-model" };
const message = { role: "user" as const, content: "한글 문서 초안 `$(no shell)`" };
const completed = { type: "turn.completed", usage: { input_tokens: 11, output_tokens: 7 } };
async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}
function runner(events: readonly unknown[]) {
  return async function* () { yield* events; };
}

describe("FR-AX-026 Codex exec provider", () => {
  it("routes explicitly without changing existing Codex/OpenAI/Ollama routes", async () => {
    const fetch = vi.fn();
    const resolver = makeProviderResolver({ fetch, codexExecRun: runner([completed]) });
    expect(resolveProviderRoute(config)).toBe("codex-exec");
    expect(resolveProviderRoute({ ...config, provider: "codex" })).toBe("codex");
    expect(resolveProviderRoute({ ...config, provider: "openai" })).toBe("native");
    expect(resolveProviderRoute({ ...config, provider: "ollama" })).toBe("ollama");
    expect(providerProcessingEndpoint(config)).toMatch(/^opaque-cli:codex-exec:/);
    expect(await collect(resolver.resolve(config).chat(config, [message], {}))).toEqual([
      { kind: "usage", inputTokens: 11, outputTokens: 7 }, { kind: "finish" },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves role boundaries, Unicode, credentials and streamed usage without logging payload", async () => {
    let captured: CodexExecInput | undefined;
    const debug = vi.fn();
    const provider = makeCodexExecProvider({ diag: { log: vi.fn(), debug }, run: async function* (input) {
      captured = input;
      yield { type: "thread.started" };
      yield { type: "item.completed", item: { type: "agent_message", text: "초안" } };
      yield completed;
    } });
    expect(await collect(provider.chat({ ...config, apiKey: "test-only-not-a-real-key" }, [message], { systemPrompt: "간결하게" }))).toEqual([
      { kind: "text", text: "초안" }, { kind: "usage", inputTokens: 11, outputTokens: 7 }, { kind: "finish" },
    ]);
    expect(JSON.parse(captured!.prompt)).toEqual({ instructions: "간결하게", messages: [message] });
    expect(captured?.apiKey).toBe("test-only-not-a-real-key");
    expect(JSON.stringify(debug.mock.calls)).not.toContain("한글");
    expect(JSON.stringify(debug.mock.calls)).not.toContain("test-only");
  });
  it.each([
    [[], "before turn completion"],
    [[{ type: "turn.failed", error: { message: "secret" } }], "turn failed"],
    [[{ type: "error", message: "secret" }], "turn failed"],
    [[{ type: "item.completed", item: { type: "command_execution" } }], "unexpected native tool"],
    [[{ type: "turn.completed", usage: { input_tokens: -1, output_tokens: 1 } }], "invalid usage"],
    [[null], "invalid event"],
    [[completed, completed], "after completion"],
  ] as const)("rejects malformed/failed streams %j", async (events, error) => {
    const provider = makeCodexExecProvider({ run: runner(events) });
    await expect(collect(provider.chat(config, [message], {}))).rejects.toThrow(error);
  });
  it("does not invent usage when CLI omits it", async () => {
    const provider = makeCodexExecProvider({ run: runner([{ type: "turn.completed" }]) });
    expect(await collect(provider.chat(config, [message], {}))).toEqual([{ kind: "finish" }]);
  });
  it("rejects unsupported tools/images before starting a process", async () => {
    const run = vi.fn(runner([completed]));
    const provider = makeCodexExecProvider({ run });
    await expect(collect(provider.chat(config, [message], { tools: [{ name: "send", description: "", parameters: {} }] }))).rejects.toThrow("does not support tools");
    await expect(collect(provider.chat(config, [{ ...message, inlineImages: [{ mimeType: "image/png", data: "AA==" }] }], {}))).rejects.toThrow("does not support images");
    await expect(collect(provider.chat(config, [{ ...message, attachments: [{ id: "a", kind: "image", mimeType: "image/png", sizeBytes: 1, localRef: "private.png" }] }], {}))).rejects.toThrow("does not support attachments");
    expect(run).not.toHaveBeenCalled();
  });
  it("does not spawn on pre-abort or report finish on mid-stream abort", async () => {
    const controller = new AbortController();
    const provider = makeCodexExecProvider({ run: async function* () { controller.abort(); yield completed; } });
    await expect(collect(provider.chat(config, [message], { signal: controller.signal }))).rejects.toBeDefined();
    const run = vi.fn(runner([completed]));
    await expect(collect(makeCodexExecProvider({ run }).chat(config, [message], { signal: controller.signal }))).rejects.toBeDefined();
    expect(run).not.toHaveBeenCalled();
  });
});

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture(body: string): Promise<{ tempRoot: string; executable: string }> {
  const tempRoot = await mkdtemp(join(tmpdir(), "ax-exec-test-"));
  dirs.push(tempRoot);
  const executable = join(tempRoot, "fake-codex");
  await writeFile(executable, `#!${process.execPath}\n${body}\n`);
  await chmod(executable, 0o700);
  return { tempRoot, executable };
}

describe.skipIf(process.platform === "win32")("Codex exec process contract (no paid/model call)", () => {
  it("pipes prompt, isolates environment/config, and cleans temporary cwd", async () => {
    const deps = await fixture(`
      const assert = require('node:assert/strict');
      assert(process.argv.includes('--ignore-user-config'));
      assert(process.argv.includes('--ignore-rules'));
      assert(process.argv.includes('read-only'));
      assert(process.argv.includes('features.shell_tool=false'));
      assert(process.argv.includes('mcp_servers={}'));
      assert(!process.argv.some(x => x.includes('private prompt')));
      assert.equal(process.env.CODEX_API_KEY, 'fake-key');
      assert.equal(process.env.NAIA_API_KEY, undefined);
      let data = ''; process.stdin.on('data', x => data += x);
      process.stdin.on('end', () => {
        assert.equal(data, 'private prompt');
        process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');
      });
    `);
    vi.stubEnv("NAIA_API_KEY", "must-not-leak");
    try {
      expect(await collect(runCodexExec({ model: "test", prompt: "private prompt", apiKey: "fake-key" }, deps))).toEqual([{ type: "turn.completed" }]);
      expect(await readdir(deps.tempRoot)).toEqual(["fake-codex"]);
    } finally { vi.unstubAllEnvs(); }
  });
  it("rejects process failure even after a completed event", async () => {
    const deps = await fixture(`process.stdout.write('${JSON.stringify(completed)}\\n'); process.exitCode = 2;`);
    const provider = makeCodexExecProvider(deps);
    await expect(collect(provider.chat(config, [message], {}))).rejects.toThrow("process failed");
    expect(await readdir(deps.tempRoot)).toEqual(["fake-codex"]);
  });
  it("bounds timeout and reaps a child that ignores SIGTERM", async () => {
    const deps = await fixture("process.on('SIGTERM', () => {}); setInterval(() => {}, 100);");
    await expect(collect(runCodexExec({ model: "test", prompt: "test" }, { ...deps, timeoutMs: 200 }))).rejects.toThrow("timed out");
    expect(await readdir(deps.tempRoot)).toEqual(["fake-codex"]);
  });
  it("rejects malformed JSONL and executable absence without echoing stderr", async () => {
    const deps = await fixture("process.stderr.write('private contents'); process.stdout.write('invalid\\n');");
    await expect(collect(runCodexExec({ model: "test", prompt: "test" }, deps))).rejects.toThrow("malformed JSONL");
    await expect(collect(runCodexExec({ model: "test", prompt: "test" }, { ...deps, executable: join(deps.tempRoot, "absent") }))).rejects.toThrow("unavailable");
    expect(await readdir(deps.tempRoot)).toEqual(["fake-codex"]);
  });
  it("timeout terminates descendants holding inherited output pipes", async () => {
    const deps = await fixture(`
      require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},100)'], {stdio:['ignore','inherit','inherit']});
      process.exit(0);
    `);
    await expect(collect(runCodexExec({ model: "test", prompt: "test" }, { ...deps, timeoutMs: 200 }))).rejects.toThrow("timed out");
    expect(await readdir(deps.tempRoot)).toEqual(["fake-codex"]);
  }, 2000);
});
