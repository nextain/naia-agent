import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { DiscordIngressAuthorityPort } from "../ports/discord.js";

const GENERATION = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Native atomically replaces this file only after its manifest is durable.
 * Every ingress-consuming operation re-reads it; invalid state fails closed.
 */
export function makeDiscordGenerationAuthority(input: {
  readonly path: string;
  readonly generation: string;
}): DiscordIngressAuthorityPort {
  if (!isAbsolute(input.path) || !GENERATION.test(input.generation)) {
    throw new Error("DISCORD_AUTHORITY_CONFIG_INVALID");
  }
  return {
    isActive() {
      try {
        const parsed = JSON.parse(readFileSync(input.path, "utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
        const record = parsed as Record<string, unknown>;
        return Object.keys(record).length === 2
          && record.version === 1
          && record.generation === input.generation
          && GENERATION.test(String(record.generation));
      } catch {
        return false;
      }
    },
  };
}
