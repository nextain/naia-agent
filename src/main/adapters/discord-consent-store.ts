import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { ProcessingWorkload, ProcessingDestination } from "../domain/chat.js";
import type { TrustedConsentRecord } from "../domain/security-wire.js";
import type { TrustedConsentStore } from "./processing-guard.js";

export interface DiscordConsentSeed extends TrustedConsentRecord {
  readonly consumedAt?: never;
}
export interface DiscordConsentFs {
  read(path: string): string | undefined;
  replace(path: string, contents: string): void;
}
interface ConsentReservation {
  readonly reservationId: string;
  readonly consentIds: readonly string[];
  readonly expiresAt: number;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION = /^[A-Za-z0-9_:-]{1,512}$/;
const DESTINATIONS = new Set<ProcessingDestination>(["local_device", "private_managed", "external_cloud"]);
const WORKLOADS = new Set<ProcessingWorkload>(["main_llm", "sub_llm", "memory_llm", "embedding", "network_tool"]);

export function makeFileDiscordConsentStore(input: {
  readonly path: string;
  readonly records: readonly DiscordConsentSeed[];
  readonly now?: () => number;
  readonly fs?: DiscordConsentFs;
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
  let reservations: ConsentReservation[] = [];
  const fs: DiscordConsentFs = input.fs ?? {
    read(path) {
      try { return readFileSync(path, "utf8"); }
      catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return undefined;
        throw error;
      }
    },
    replace(path, contents) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.tmp`;
      try {
        writeFileSync(temp, contents, { encoding: "utf8", mode: 0o600 });
        renameSync(temp, path);
      } catch (error) {
        try { rmSync(temp, { force: true }); } catch { /* best effort */ }
        throw error;
      }
    },
  };
  const reload = (): boolean => {
   try {
    const raw = fs.read(input.path);
    if (raw === undefined) {
      consumed = new Set();
      reservations = [];
      return true;
    }
    const parsed = JSON.parse(raw) as {
      version?: unknown; consumed?: unknown; reservations?: unknown;
    };
    if (![1, 2].includes(Number(parsed.version))
      || !Array.isArray(parsed.consumed) || parsed.consumed.length > 256
      || parsed.consumed.some((id) => typeof id !== "string" || !ID.test(id))) throw new Error();
    consumed = new Set(parsed.consumed);
    reservations = parsed.version === 2 && Array.isArray(parsed.reservations)
      ? parsed.reservations as ConsentReservation[]
      : [];
    if (reservations.length > 256 || reservations.some((reservation) =>
      !ID.test(reservation.reservationId)
      || !Array.isArray(reservation.consentIds) || reservation.consentIds.length < 1
      || reservation.consentIds.some((id) => !ID.test(id))
      || !Number.isSafeInteger(reservation.expiresAt) || reservation.expiresAt < 1)) throw new Error();
    reservations = reservations.filter((reservation) =>
      reservation.expiresAt > (input.now ?? Date.now)());
    return true;
   } catch {
     return false;
   }
  };
  if (!reload()) throw new Error("DISCORD_CONSENT_STATE_CORRUPT");
  const persist = (nextConsumed: Set<string>, nextReservations = reservations): boolean => {
    try {
      fs.replace(input.path, JSON.stringify({
        version: 2,
        consumed: [...nextConsumed].sort(),
        reservations: nextReservations,
      }));
      consumed = nextConsumed;
      reservations = [...nextReservations];
      return true;
    } catch {
      return false;
    }
  };
  const reserveMany = (consentIds: readonly string[]): string | undefined => {
    if (!reload()) return undefined;
    const unique = [...new Set(consentIds)];
    if (!unique.length || unique.some((consentId) =>
      !ID.test(consentId) || consumed.has(consentId) || !ids.has(consentId)
      || reservations.some((reservation) => reservation.consentIds.includes(consentId)))) return undefined;
    const reservationId = randomUUID();
    const reservationExpiry = Math.min(...unique.map((consentId) =>
      input.records.find((record) => record.consentId === consentId)!.expiresAt));
    return persist(consumed, [...reservations, {
      reservationId,
      consentIds: unique,
      expiresAt: reservationExpiry,
    }])
      ? reservationId : undefined;
  };
  const commitReservation = (reservationId: string): boolean => {
    if (!reload() || !ID.test(reservationId)) return false;
    // The durable reservation itself is the terminal one-time burn and remains
    // unavailable until the original consent expires. No post-disclosure write exists.
    return reservations.some((item) => item.reservationId === reservationId);
  };
  const rollbackReservation = (reservationId: string): boolean => {
    if (!reload() || !ID.test(reservationId)) return false;
    if (!reservations.some((item) => item.reservationId === reservationId)) return false;
    return persist(consumed, reservations.filter((item) => item.reservationId !== reservationId));
  };
  return {
    find(query) {
      if (!reload()) return undefined;
      return input.records.find((record) =>
        !consumed.has(record.consentId)
        && !reservations.some((reservation) => reservation.consentIds.includes(record.consentId))
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
      const reservationId = reserveMany(consentIds);
      return reservationId !== undefined && commitReservation(reservationId);
    },
    reserveMany,
    commitReservation,
    rollbackReservation,
  };
}
