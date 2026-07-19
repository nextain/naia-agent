import { createHash, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { DiscordFriendRegistrationPort } from "../ports/discord.js";

export interface DiscordRegistrationSeed {
  readonly bindingId: string;
  readonly codeHash: string;
  readonly expiresAt: number;
}

interface Claim {
  readonly bindingId: string;
  readonly codeHash: string;
  readonly userId: string;
  readonly claimedAt: number;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;

export function hashDiscordRegistrationCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export function makeFileDiscordRegistration(input: {
  readonly path: string;
  readonly seeds: readonly DiscordRegistrationSeed[];
}): DiscordFriendRegistrationPort {
  if (input.seeds.length > 256 || input.seeds.some((seed) =>
    !ID.test(seed.bindingId) || !HASH.test(seed.codeHash)
    || !Number.isSafeInteger(seed.expiresAt) || seed.expiresAt < 1)) {
    throw new Error("DISCORD_REGISTRATION_CONFIG_INVALID");
  }
  const seedKeys = new Set(input.seeds.map((seed) => `${seed.bindingId}\u0000${seed.codeHash}`));
  if (seedKeys.size !== input.seeds.length) throw new Error("DISCORD_REGISTRATION_CONFIG_INVALID");
  let claims: Claim[] = [];
  const reload = (): boolean => {
   try {
    const parsed = JSON.parse(readFileSync(input.path, "utf8")) as { version?: unknown; claims?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.claims) || parsed.claims.length > 256) throw new Error();
    claims = parsed.claims as Claim[];
    if (claims.some((claim) => !ID.test(claim.bindingId) || !HASH.test(claim.codeHash)
      || !ID.test(claim.userId) || !Number.isSafeInteger(claim.claimedAt) || claim.claimedAt < 0)) throw new Error();
    return true;
   } catch (error) {
     if ((error as { code?: string }).code === "ENOENT") {
       claims = [];
       return true;
     }
     return false;
   }
  };
  if (!reload()) throw new Error("DISCORD_REGISTRATION_STATE_CORRUPT");
  const persist = (next: readonly Claim[]): boolean => {
    mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 });
    const temp = `${input.path}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, claims: next }), { encoding: "utf8", mode: 0o600 });
      renameSync(temp, input.path);
      claims = [...next];
      return true;
    } catch {
      try { rmSync(temp, { force: true }); } catch { /* best effort */ }
      return false;
    }
  };
  return {
    async refresh() {
      return reload();
    },
    async isRegistered({ bindingId, userId }) {
      if (!reload()) return false;
      return ID.test(bindingId) && ID.test(userId)
        && claims.some((claim) => claim.bindingId === bindingId && claim.userId === userId);
    },
    async claim({ bindingId, userId, code, now }) {
      if (!reload()) return false;
      if (!ID.test(bindingId) || !ID.test(userId) || code.length < 4 || code.length > 128
        || !Number.isSafeInteger(now) || now < 0) return false;
      const candidateHash = hashDiscordRegistrationCode(code);
      const candidateBuffer = Buffer.from(candidateHash, "hex");
      const seed = input.seeds.find((item) =>
        item.bindingId === bindingId
        && timingSafeEqual(candidateBuffer, Buffer.from(item.codeHash, "hex")));
      if (!seed || now >= seed.expiresAt
        || claims.some((claim) => claim.bindingId === bindingId && claim.codeHash === seed.codeHash)) return false;
      return persist([...claims, { bindingId, codeHash: seed.codeHash, userId, claimedAt: now }]);
    },
  };
}
