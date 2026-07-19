import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ProcessingWorkload, ProcessingDestination } from "../domain/chat.js";
import type { TrustedConsentRecord } from "../domain/security-wire.js";
import type { TrustedConsentStore } from "./processing-guard.js";

export interface DiscordConsentSeed extends TrustedConsentRecord {
  readonly consumedAt?: never;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION = /^[A-Za-z0-9_:-]{1,512}$/;
const DESTINATIONS = new Set<ProcessingDestination>(["local_device", "private_managed", "external_cloud"]);
const WORKLOADS = new Set<ProcessingWorkload>(["main_llm", "sub_llm", "memory_llm", "embedding", "network_tool"]);

export function makeFileDiscordConsentStore(input: {
  readonly path: string;
  readonly records: readonly DiscordConsentSeed[];
  readonly now?: () => number;
}): TrustedConsentStore {
  if (input.records.length > 256 || input.records.some((record) =>
    !ID.test(record.consentId) || !ID.test(record.processingProfileRef)
    || !DESTINATIONS.has(record.destination) || !WORKLOADS.has(record.workload)
    || !SESSION.test(record.sessionId) || !Number.isSafeInteger(record.expiresAt) || record.expiresAt < 1)) {
    throw new Error("DISCORD_CONSENT_CONFIG_INVALID");
  }
  const ids = new Set(input.records.map((record) => record.consentId));
  if (ids.size !== input.records.length) throw new Error("DISCORD_CONSENT_CONFIG_INVALID");
  let consumed = new Set<string>();
  const reload = (): boolean => {
   try {
    const parsed = JSON.parse(readFileSync(input.path, "utf8")) as { version?: unknown; consumed?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.consumed) || parsed.consumed.length > 256
      || parsed.consumed.some((id) => typeof id !== "string" || !ID.test(id))) throw new Error();
    consumed = new Set(parsed.consumed);
    return true;
   } catch (error) {
     if ((error as { code?: string }).code === "ENOENT") {
       consumed = new Set();
       return true;
     }
     return false;
   }
  };
  if (!reload()) throw new Error("DISCORD_CONSENT_STATE_CORRUPT");
  const persist = (next: Set<string>): boolean => {
    mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 });
    const temp = `${input.path}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, consumed: [...next].sort() }), { encoding: "utf8", mode: 0o600 });
      renameSync(temp, input.path);
      consumed = next;
      return true;
    } catch {
      try { rmSync(temp, { force: true }); } catch { /* best effort */ }
      return false;
    }
  };
  return {
    find(query) {
      if (!reload()) return undefined;
      return input.records.find((record) =>
        !consumed.has(record.consentId)
        && record.processingProfileRef === query.processingProfileRef
        && record.destination === query.destination
        && record.workload === query.workload
        && record.sessionId === query.sessionId
        && record.expiresAt > (input.now ?? Date.now)());
    },
    claim(consentId) {
      return this.claimMany([consentId]);
    },
    claimMany(consentIds) {
      if (!reload()) return false;
      if (!consentIds.length || consentIds.some((consentId) =>
        !ID.test(consentId) || consumed.has(consentId) || !ids.has(consentId))) return false;
      const next = new Set(consumed);
      for (const consentId of consentIds) next.add(consentId);
      return persist(next);
    },
  };
}
