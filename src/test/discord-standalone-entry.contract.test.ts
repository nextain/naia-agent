import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("FR-DISCORD-169 standalone entry wiring", () => {
  const dispatcher = read("bin/naia-agent.mjs");
  const entry = read("scripts/builds/agent-stdio-entry.mjs");
  const standalone = read("bin/naia-agent-serve.mjs");

  it("routes `naia-agent serve` to the shared composition function", () => {
    expect(dispatcher).toContain('const SERVE = join(HERE, "naia-agent-serve.mjs")');
    expect(dispatcher).toContain('sub === "serve" ? SERVE');
    expect(standalone).toContain('startAgentHost({ mode: "discord-standalone" })');
    expect(entry).toContain("export async function startAgentHost({ mode = \"grpc\" } = {})");
    expect(entry).toContain("pathToFileURL(resolve(process.argv[1])).href === import.meta.url");
  });

  it("keeps Discord credentials on the one-shot stdin pipe and requires the standalone trust state", () => {
    expect(entry).toContain('process.env.NAIA_DISCORD_TOKEN_PIPE === "stdin"');
    expect(entry).toContain("const discordToken = await discordTokenFromSecretPipe");
    expect(entry).toContain('!secretPipeConfigured ? "token_pipe_required"');
    expect(entry).toContain('!discordAuthority.isActive() ? "authority_conflict"');
    expect(entry).toContain('discordStatus?.write("failed", code)');
    expect(entry).toContain("process.exit(1)");
    expect(entry.indexOf("const discordToken = await discordTokenFromSecretPipe"))
      .toBeLessThan(entry.indexOf('await import("../../dist/main/'));
  });

  it("does not bind or shut down gRPC in Discord-only mode", () => {
    expect(entry).toContain("if (!discordStandalone) {");
    expect(entry).toMatch(/if \(!discordStandalone\) \{\s*try \{\s*grpcAddr = await grpcServer\.start\(\)/);
    expect(entry).toMatch(/if \(!discordStandalone\) \{\s*try \{ await grpcServer\.shutdown\(\)/);
    expect(standalone).toContain("SIGTERM/SIGINT");
  });
});
