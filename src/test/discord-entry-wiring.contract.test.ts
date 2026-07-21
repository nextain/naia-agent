import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("T-DISCORD-RT-02/05 — production entry wiring", () => {
  const entry = readFileSync(new URL("../../scripts/builds/agent-stdio-entry.mjs", import.meta.url), "utf8");

  it("removes the injected token from process.env and never writes it to config", () => {
    expect(entry).toContain('process.env.NAIA_DISCORD_TOKEN_PIPE === "stdin"');
    expect(entry).toContain("const discordToken = await discordTokenFromSecretPipe");
    expect(entry).toContain("delete process.env.NAIA_DISCORD_TOKEN_PIPE");
    expect(entry).not.toContain('line.startsWith("NAIA_DISCORD_TOKEN ")');
    expect(entry).not.toContain("NAIA_DISCORD_BOT_TOKEN");
    expect(entry).not.toMatch(/writeFile[^\\n]*discordToken/);
    expect(entry).toContain("delete process.env.NAIA_DISCORD_GENERATION");
    expect(entry).toContain("delete process.env.NAIA_DISCORD_STATUS_PATH");
    expect(entry).toContain("delete process.env.NAIA_DISCORD_AUTHORITY_PATH");
    expect(entry).toContain("delete process.env.NAIA_DISCORD_INBOX_PATH");
    expect(entry).toContain("delete process.env.NAIA_AGENT_SHUTDOWN_NONCE");
    expect(entry).not.toMatch(/(?:stderr|stdout).*shutdownNonce/);
  });

  it("closes the one-shot secret pipe before evaluating runtime modules", () => {
    const tokenRead = entry.indexOf(
      "const discordToken = await discordTokenFromSecretPipe",
    );
    const firstRuntimeImport = entry.indexOf(
      'await import("../../dist/main/',
    );
    expect(tokenRead).toBeGreaterThan(0);
    expect(firstRuntimeImport).toBeGreaterThan(tokenRead);
    expect(entry).toContain("process.stdin.destroy()");
    expect(entry).not.toMatch(/^import .*dist\/main/m);
  });

  it("wires the generation-scoped Agent-owned inbox cache", () => {
    expect(entry).toContain("makeFileDiscordInbox");
    expect(entry).toContain("repairFileDiscordDedupeLock(dedupePath)");
    expect(entry).toContain("discordInboxPath && discordGeneration");
    expect(entry).toContain("inbox: makeFileDiscordInbox");
  });

  it("requires generation authority and exposes standby until this generation is authoritative", () => {
    expect(entry).toContain("makeDiscordGenerationAuthority");
    expect(entry).toContain("discordToken && discordConfig && discordAuthority");
    expect(entry).toContain('status.authoritative ? "ready" : "standby"');
  });

  it("reports a missing one-shot token even after deleting the bindings environment value", () => {
    expect(entry).toContain(
      "const discordBindingsProvided = Boolean(process.env.NAIA_DISCORD_BINDINGS_JSON)",
    );
    expect(entry).toContain("discordToken || discordBindingsProvided");
    expect(entry).toContain('"token_unavailable"');
  });

  it("routes Discord through the same wireAgentUC1 pipeline without leaking its events to gRPC", () => {
    expect(entry).toContain("makeCompositeAgentIngress([grpcServer.ingress, discordRuntime.ingress])");
    expect(entry).toContain('makePrefixedAgentEgress([{ prefix: "discord:", egress: discordRuntime.egress }], grpcServer.egress)');
    expect(entry).toContain("wireAgentUC1({ ingress: agentIngress, egress: agentEgress");
    expect(entry).toContain("makeProcessingGuard({");
    expect(entry).toContain("...(processingGuard ? { processingGuard } : {})");
    expect(entry).toContain("...(consents ? { consents } : {})");
  });

  it("wires the Codex delegate into the desktop host with workspace and agent allowlists", () => {
    expect(entry).toContain("makeDelegateAgentSkill");
    expect(entry).toContain("wireSupervisor({ subAgentName: agent");
    expect(entry).toContain("allowedWorkdirRoot: adkPath");
    expect(entry).toContain("resolveDefaultWorkdir: () => currentAdkPath");
    expect(entry).toContain("resolveAllowedWorkdirRoot: () => currentAdkPath");
    expect(entry).toContain('allowedAgents: ["codex"]');
    expect(entry.indexOf("let currentAdkPath = adkPath")).toBeLessThan(entry.indexOf("makeDelegateAgentSkill({"));
    expect(entry.indexOf("makeDelegateAgentSkill")).toBeLessThan(entry.indexOf("wireAgentUC1({ ingress: agentIngress"));
  });

  it("starts only after gRPC boot succeeds and gracefully drains Discord before shared resources", () => {
    expect(entry.indexOf("discordRuntime?.start()")).toBeGreaterThan(entry.indexOf("await grpcServer.start()"));
    expect(entry.indexOf("await discordRuntime?.gracefulStop()")).toBeLessThan(entry.indexOf("if (drain) await drain()"));
    expect(entry).toContain('diag.log("discord runtime", { code: "shutdown_failed" })');
    expect(entry).not.toMatch(/discord shutdown[^\\n]*(?:e\\.message|String\\(e\\))/);
    expect(entry).toContain('discordStatus?.write("stopped")');
  });

  it("shares one idempotent shutdown promise across authenticated RPC and signals", () => {
    expect(entry).toContain("shutdownPromise ??= performShutdown()");
    expect(entry).toContain("onShutdown: () => onShutdown?.()");
    expect(entry).toContain('process.on("SIGTERM", () => { void onShutdown?.(); })');
    expect(entry).toContain('process.on("SIGINT", () => { void onShutdown?.(); })');
  });
});
