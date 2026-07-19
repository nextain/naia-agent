import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeFileDiscordConsentStore } from "../main/adapters/discord-consent-store.js";
import {
  hashDiscordRegistrationCode,
  makeFileDiscordRegistration,
} from "../main/adapters/discord-registration-store.js";
import { makeDiscordStatusFile } from "../main/adapters/discord-status-file.js";
import { makeDiscordGenerationAuthority } from "../main/adapters/discord-generation-authority.js";

const dirs: string[] = [];
function tempFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "naia-discord-state-"));
  dirs.push(dir);
  return join(dir, name);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Discord trusted one-time state", () => {
  it("accepts only an exact atomically selected generation and fails closed otherwise", () => {
    const path = tempFile("authority.json");
    const authority = makeDiscordGenerationAuthority({ path, generation: "generation_2" });
    expect(authority.isActive()).toBe(false);
    writeFileSync(path, JSON.stringify({ version: 1, generation: "generation_1" }));
    expect(authority.isActive()).toBe(false);
    writeFileSync(path, JSON.stringify({ version: 1, generation: "generation_2" }));
    expect(authority.isActive()).toBe(true);
    writeFileSync(path, JSON.stringify({
      version: 1, generation: "generation_2", unexpected: true,
    }));
    expect(authority.isActive()).toBe(false);
  });

  it("claims a registration code once, before its expiry, without persisting the code", async () => {
    const path = tempFile("registrations.json");
    const seed = {
      bindingId: "binding_1",
      codeHash: hashDiscordRegistrationCode("one-time-code"),
      expiresAt: 2_000,
    };
    const store = makeFileDiscordRegistration({ path, seeds: [seed] });
    expect(await store.claim({
      bindingId: "binding_1", userId: "300", code: "one-time-code", now: 1_999,
    })).toBe(true);
    expect(await store.claim({
      bindingId: "binding_1", userId: "301", code: "one-time-code", now: 1_999,
    })).toBe(false);
    expect(await store.isRegistered({ bindingId: "binding_1", userId: "300" })).toBe(true);
    expect(readFileSync(path, "utf8")).not.toContain("one-time-code");
  });

  it("rejects an expired or wrong-binding registration code", async () => {
    const store = makeFileDiscordRegistration({
      path: tempFile("registrations.json"),
      seeds: [{
        bindingId: "binding_1",
        codeHash: hashDiscordRegistrationCode("one-time-code"),
        expiresAt: 2_000,
      }],
    });
    expect(await store.claim({
      bindingId: "binding_2", userId: "300", code: "one-time-code", now: 1_000,
    })).toBe(false);
    expect(await store.claim({
      bindingId: "binding_1", userId: "300", code: "one-time-code", now: 2_000,
    })).toBe(false);
  });

  it("reloads registration claims after standby so a one-time code cannot be replayed", async () => {
    const path = tempFile("registrations.json");
    const seed = {
      bindingId: "binding_1",
      codeHash: hashDiscordRegistrationCode("one-time-code"),
      expiresAt: 2_000,
    };
    const oldProcess = makeFileDiscordRegistration({ path, seeds: [seed] });
    const standbyProcess = makeFileDiscordRegistration({ path, seeds: [seed] });
    expect(await oldProcess.claim({
      bindingId: "binding_1", userId: "300", code: "one-time-code", now: 1_000,
    })).toBe(true);
    expect(await standbyProcess.claim({
      bindingId: "binding_1", userId: "301", code: "one-time-code", now: 1_001,
    })).toBe(false);
    expect(await standbyProcess.isRegistered({ bindingId: "binding_1", userId: "300" })).toBe(true);
  });

  it("finds consent only by the full trusted tuple and atomically consumes its id", () => {
    const path = tempFile("consents.json");
    const record = {
      consentId: "consent_1",
      processingProfileRef: "profile_1",
      destination: "external_cloud" as const,
      workload: "main_llm" as const,
      sessionId: "discord:binding_1:100:200:300",
      expiresAt: 2_000,
    };
    const store = makeFileDiscordConsentStore({ path, records: [record], now: () => 1_000 });
    expect(store.find({
      processingProfileRef: "profile_1",
      destination: "external_cloud",
      workload: "main_llm",
      sessionId: "discord:binding_1:100:200:301",
    })).toBeUndefined();
    expect(store.find({
      processingProfileRef: "profile_1",
      destination: "external_cloud",
      workload: "main_llm",
      sessionId: record.sessionId,
    })).toEqual(record);
    expect(store.claim("consent_1")).toBe(true);
    expect(store.claim("consent_1")).toBe(false);
    expect(makeFileDiscordConsentStore({ path, records: [record], now: () => 1_000 }).find({
      processingProfileRef: "profile_1",
      destination: "external_cloud",
      workload: "main_llm",
      sessionId: record.sessionId,
    })).toBeUndefined();
  });

  it("reloads consent state after standby so a second process cannot reuse a consumed id", () => {
    const path = tempFile("consents.json");
    const record = {
      consentId: "consent_1",
      processingProfileRef: "profile_1",
      destination: "external_cloud" as const,
      workload: "main_llm" as const,
      sessionId: "discord:binding_1:100:200:300",
      expiresAt: 2_000,
    };
    const oldProcess = makeFileDiscordConsentStore({ path, records: [record], now: () => 1_000 });
    const standbyProcess = makeFileDiscordConsentStore({ path, records: [record], now: () => 1_000 });
    expect(oldProcess.claim("consent_1")).toBe(true);
    expect(standbyProcess.find({
      processingProfileRef: "profile_1",
      destination: "external_cloud",
      workload: "main_llm",
      sessionId: record.sessionId,
    })).toBeUndefined();
    expect(standbyProcess.claim("consent_1")).toBe(false);
  });

  it("fails consent commit closed and permits reuse only after the durable reservation expires", () => {
    let raw: string | undefined;
    let writes = 0;
    let now = 1_000;
    const store = makeFileDiscordConsentStore({
      path: "/virtual/consents.json",
      records: [{
        consentId: "consent_1",
        processingProfileRef: "profile_1",
        destination: "external_cloud",
        workload: "main_llm",
        sessionId: "session_1",
        expiresAt: 1_000_000,
      }],
      now: () => now,
      fs: {
        read: () => raw,
        replace: (_path, contents) => {
          writes++;
          if (writes === 2) throw new Error("disk full");
          raw = contents;
        },
      },
    });
    const reservation = store.reserveMany?.(["consent_1"]);
    expect(reservation).toBeDefined();
    expect(store.commitReservation?.(reservation!)).toBe(false);
    expect(store.find({
      processingProfileRef: "profile_1",
      destination: "external_cloud",
      workload: "main_llm",
      sessionId: "session_1",
    })).toBeUndefined();
    now += 5 * 60_000 + 1;
    expect(store.find({
      processingProfileRef: "profile_1",
      destination: "external_cloud",
      workload: "main_llm",
      sessionId: "session_1",
    })).toBeDefined();
  });

  it("does not return expired consent", () => {
    const store = makeFileDiscordConsentStore({
      path: tempFile("consents.json"),
      records: [{
        consentId: "consent_1",
        processingProfileRef: "profile_1",
        destination: "external_cloud",
        workload: "main_llm",
        sessionId: "discord:binding_1:100:200:300",
        expiresAt: 1_000,
      }],
      now: () => 1_000,
    });
    expect(store.find({
      processingProfileRef: "profile_1",
      destination: "external_cloud",
      workload: "main_llm",
      sessionId: "discord:binding_1:100:200:300",
    })).toBeUndefined();
  });

  it("atomically publishes only generation, state, and a stable code", () => {
    const path = tempFile("status.json");
    const writer = makeDiscordStatusFile({ path, generation: "generation_1" });
    writer.write("starting");
    writer.write("ready");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      generation: "generation_1",
      state: "ready",
    });
    expect(readFileSync(path, "utf8")).not.toMatch(/token|self.?id|endpoint|secret/i);
    expect(() => writer.write("failed", "raw exception text")).toThrow("DISCORD_STATUS_VALUE_INVALID");
    writer.write("ready", undefined, { confirmedChunk: 1 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      generation: "generation_1",
      state: "ready",
      partialReply: { confirmedChunk: 1 },
    });
    expect(readFileSync(path, "utf8")).not.toMatch(/binding|message|channel|guild/i);
  });
});
