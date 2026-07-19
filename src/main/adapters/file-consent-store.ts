import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { ProcessingDestination, ProcessingWorkload } from "../domain/chat.js";
import type { TrustedConsentRecord } from "../domain/wire-v1.js";
import type { TrustedConsentStore } from "./processing-guard.js";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION = /^[A-Za-z0-9_:-]{1,512}$/;
const DESTINATIONS = new Set<ProcessingDestination>(["local_device", "private_managed", "external_cloud"]);
const WORKLOADS = new Set<ProcessingWorkload>(["main_llm", "sub_llm", "memory_llm", "embedding", "network_tool"]);
const CONSENT_KEYS = new Set([
  "consentId", "scope", "processingProfileRef", "destination",
  "workload", "sessionId", "expiresAt",
]);

function hasClosedConsentShape(record: TrustedConsentRecord): boolean {
  const keys = Reflect.ownKeys(record);
  return keys.length === CONSENT_KEYS.size
    && keys.every((key) => typeof key === "string" && CONSENT_KEYS.has(key));
}

/** File-backed one-shot consent store. claim persists before exposing success. */
export function makeFileConsentStore(input: {
  readonly path: string;
  readonly records: readonly TrustedConsentRecord[];
  readonly now?: () => number;
}): TrustedConsentStore {
  if (input.records.length > 256 || input.records.some((record) =>
    !hasClosedConsentShape(record)
    || !ID.test(record.consentId) || !ID.test(record.scope)
    || !ID.test(record.processingProfileRef) || !DESTINATIONS.has(record.destination)
    || !WORKLOADS.has(record.workload) || !SESSION.test(record.sessionId)
    || !Number.isSafeInteger(record.expiresAt) || record.expiresAt < 1
    || record.consumedAt !== undefined)) {
    throw new Error("PROCESSING_CONSENT_CONFIG_INVALID");
  }
  const ids = new Set(input.records.map((record) => record.consentId));
  if (ids.size !== input.records.length) throw new Error("PROCESSING_CONSENT_CONFIG_INVALID");
  const readConsumed = (): Set<string> => {
    try {
      const parsed = JSON.parse(readFileSync(input.path, "utf8")) as { version?: unknown; consumed?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.consumed) || parsed.consumed.length > 256
      || parsed.consumed.some((id) => typeof id !== "string" || !ID.test(id))) throw new Error();
      return new Set(parsed.consumed);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return new Set();
      throw new Error("PROCESSING_CONSENT_STATE_CORRUPT");
    }
  };
  let consumed = readConsumed();
  const persist = (next: Set<string>) => {
    mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 });
    const temp = `${input.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, consumed: [...next].sort() }), {
        encoding: "utf8", mode: 0o600,
      });
      const file = openSync(temp, "r");
      try { fsyncSync(file); } finally { closeSync(file); }
      renameSync(temp, input.path);
      const directory = openSync(dirname(input.path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
      consumed = next;
      return true;
    } catch {
      try { rmSync(temp, { force: true }); } catch { /* best effort */ }
      return false;
    }
  };
  return {
    hasExact(query) {
      if (!Number.isFinite(query.now)) return false;
      return input.records.some((candidate) =>
        !consumed.has(candidate.consentId) && candidate.scope === query.scope
        && candidate.processingProfileRef === query.processingProfileRef
        && candidate.destination === query.destination && candidate.workload === query.workload
        && candidate.sessionId === query.sessionId && candidate.expiresAt > query.now);
    },
    claimExact(query) {
      if (!Number.isFinite(query.now)) return undefined;
      const lock = `${input.path}.lock`;
      try {
        mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 });
        mkdirSync(lock, { mode: 0o700 });
      } catch {
        return undefined;
      }
      try {
        consumed = readConsumed();
        const record = input.records.find((candidate) =>
          !consumed.has(candidate.consentId) && candidate.scope === query.scope
          && candidate.processingProfileRef === query.processingProfileRef
          && candidate.destination === query.destination && candidate.workload === query.workload
          && candidate.sessionId === query.sessionId && candidate.expiresAt > query.now);
        if (!record) return undefined;
        const next = new Set(consumed);
        next.add(record.consentId);
        return persist(next) ? record : undefined;
      } catch {
        return undefined;
      } finally {
        try { rmSync(lock, { recursive: true, force: true }); } catch { /* fail closed on next claim */ }
      }
    },
  };
}
