import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DiscordDedupePort } from "../ports/discord.js";
import { replaceOwnerOnlyAtomic } from "./owner-only-atomic-file.js";

type DedupeState = "reserved" | "replying" | "completed" | "partial";

interface DedupeEntry {
  readonly bindingId: string;
  readonly messageId: string;
  readonly updatedAt: number;
  readonly state: DedupeState;
  readonly owner?: string;
  readonly chunks?: readonly string[];
  readonly nextChunk?: number;
  readonly confirmedChunk?: number;
}

interface DedupeDocument {
  readonly version: 2;
  readonly entries: readonly DedupeEntry[];
}

export interface DiscordDedupeFs {
  read(path: string): string | undefined;
  replace(path: string, contents: string): void;
  transaction?<T>(path: string, operation: () => T): T;
}

export interface DiscordDedupeOptions {
  readonly path: string;
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly fs?: DiscordDedupeFs;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const STATES = new Set<DedupeState>(["reserved", "replying", "completed", "partial"]);
const DEFAULT_MAX_ENTRIES = 4_096;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_CHUNKS = 6;
const MAX_CHUNK_LENGTH = 2_000;

/** Explicit recovery for a lock left by a crashed process. Call only while Agent startup is serialized. */
export function repairFileDiscordDedupeLock(path: string): boolean {
  const lockPath = `${path}.lock`;
  let observed: { pid?: number; token?: string };
  try {
    observed = JSON.parse(readFileSync(`${lockPath}/owner.json`, "utf8")) as { pid?: number; token?: string };
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(observed.pid) || typeof observed.token !== "string") return false;
  try {
    process.kill(observed.pid!, 0);
    return false;
  } catch (error) {
    if ((error as { code?: string }).code !== "ESRCH") return false;
  }
  try {
    const current = JSON.parse(readFileSync(`${lockPath}/owner.json`, "utf8")) as { pid?: number; token?: string };
    if (current.pid !== observed.pid || current.token !== observed.token) return false;
  } catch { return false; }
  rmSync(lockPath, { recursive: true, force: true });
  return true;
}

function makeNodeFs(): DiscordDedupeFs {
  return {
    read(path) {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return undefined;
        throw error;
      }
    },
    replace(path, contents) {
      replaceOwnerOnlyAtomic(path, contents);
    },
    transaction(path, operation) {
      const lockPath = `${path}.lock`;
      const token = randomUUID();
      const ownerPath = `${lockPath}/owner.json`;
      const candidate = `${lockPath}.${token}.candidate`;
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (const name of readdirSync(directory)) {
        if (!name.startsWith(`${basename(lockPath)}.`) || !name.endsWith(".candidate")) continue;
        const abandoned = join(directory, name);
        let pid: number | undefined;
        try { pid = (JSON.parse(readFileSync(join(abandoned, "owner.json"), "utf8")) as { pid?: number }).pid; } catch { /* incomplete candidate */ }
        let alive = false;
        if (Number.isSafeInteger(pid)) {
          try { process.kill(pid!, 0); alive = true; } catch (error) {
            alive = (error as { code?: string }).code !== "ESRCH";
          }
        }
        if (!alive) rmSync(abandoned, { recursive: true, force: true });
      }
      try {
        mkdirSync(candidate, { mode: 0o700 });
        writeFileSync(`${candidate}/owner.json`, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
        renameSync(candidate, lockPath);
      } catch (error) {
        rmSync(candidate, { recursive: true, force: true });
        if (new Set(["EEXIST", "ENOTEMPTY", "EACCES"]).has((error as { code?: string }).code ?? "")) {
          throw new Error("DISCORD_DEDUPE_BUSY");
        }
        throw error;
      }
      try {
        return operation();
      } finally {
        try {
          const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { token?: string };
          if (owner.token === token) rmSync(lockPath, { recursive: true, force: true });
        } catch { /* another owner or already reclaimed */ }
      }
    },
  };
}

function validChunks(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= MAX_CHUNKS
    && value.every((chunk) => typeof chunk === "string" && chunk.length >= 1 && chunk.length <= MAX_CHUNK_LENGTH);
}

function parseDocument(raw: string | undefined, maxEntries: number): readonly DedupeEntry[] {
  if (raw === undefined) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("DISCORD_DEDUPE_CORRUPT");
  }
  if (!value || typeof value !== "object") throw new Error("DISCORD_DEDUPE_CORRUPT");
  const doc = value as Partial<DedupeDocument>;
  if (doc.version !== 2 || !Array.isArray(doc.entries) || doc.entries.length > maxEntries) {
    throw new Error("DISCORD_DEDUPE_CORRUPT");
  }
  const seen = new Set<string>();
  const entries: DedupeEntry[] = [];
  for (const rawEntry of doc.entries) {
    if (!rawEntry || typeof rawEntry !== "object") throw new Error("DISCORD_DEDUPE_CORRUPT");
    const entry = rawEntry as Partial<DedupeEntry>;
    const key = `${entry.bindingId}\u0000${entry.messageId}`;
    if (typeof entry.bindingId !== "string" || !ID.test(entry.bindingId)
      || typeof entry.messageId !== "string" || !ID.test(entry.messageId)
      || (entry.owner !== undefined && (typeof entry.owner !== "string" || !ID.test(entry.owner)))
      || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt! < 0
      || !STATES.has(entry.state as DedupeState) || seen.has(key)) {
      throw new Error("DISCORD_DEDUPE_CORRUPT");
    }
    if (entry.state === "replying"
      && (!validChunks(entry.chunks) || !Number.isSafeInteger(entry.nextChunk)
        || entry.nextChunk! < 0 || entry.nextChunk! > entry.chunks.length
        || !Number.isSafeInteger(entry.confirmedChunk) || entry.confirmedChunk! < 0
        || entry.confirmedChunk! > entry.nextChunk!)) {
      throw new Error("DISCORD_DEDUPE_CORRUPT");
    }
    if (entry.state === "partial"
      && (!Number.isSafeInteger(entry.confirmedChunk) || entry.confirmedChunk! < 0)) {
      throw new Error("DISCORD_DEDUPE_CORRUPT");
    }
    if (entry.state !== "replying" && entry.state !== "partial"
      && (entry.chunks !== undefined || entry.nextChunk !== undefined || entry.confirmedChunk !== undefined)) {
      throw new Error("DISCORD_DEDUPE_CORRUPT");
    }
    if (entry.state === "partial" && (entry.chunks !== undefined || entry.nextChunk !== undefined)) {
      throw new Error("DISCORD_DEDUPE_CORRUPT");
    }
    seen.add(key);
    entries.push({
      bindingId: entry.bindingId,
      messageId: entry.messageId,
      updatedAt: entry.updatedAt!,
      state: entry.state as DedupeState,
      ...(entry.owner === undefined ? {} : { owner: entry.owner }),
      ...(entry.state === "replying"
        ? { chunks: [...entry.chunks!], nextChunk: entry.nextChunk!, confirmedChunk: entry.confirmedChunk! }
        : entry.state === "partial" ? { confirmedChunk: entry.confirmedChunk! } : {}),
    });
  }
  return entries;
}

export function makeFileDiscordDedupe(options: DiscordDedupeOptions): DiscordDedupePort {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000
    || !Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new Error("DISCORD_DEDUPE_CONFIG_INVALID");
  }
  const fs = options.fs ?? makeNodeFs();
  const owner = randomUUID();
  const transaction = <T>(operation: () => T): T => fs.transaction?.(options.path, operation) ?? operation();
  const load = (): DedupeEntry[] => {
    return transaction(() => {
      const parsed = [...parseDocument(fs.read(options.path), maxEntries)];
      if (!parsed.some((entry) => entry.state === "reserved"
        || (entry.state === "replying" && entry.owner !== owner))) return parsed;
      const recovered = parsed.map((entry): DedupeEntry => entry.state === "reserved"
        ? {
            bindingId: entry.bindingId,
            messageId: entry.messageId,
            updatedAt: entry.updatedAt,
            state: "partial",
            owner,
            confirmedChunk: 0,
          }
        : entry.state === "replying" ? { ...entry, owner }
        : entry);
      fs.replace(options.path, JSON.stringify({ version: 2, entries: recovered }));
      return recovered;
    });
  };
  let entries = load();

  const keyOf = (bindingId: string, messageId: string) => `${bindingId}\u0000${messageId}`;
  const validIdentity = (bindingId: string, messageId: string, now: number) =>
    ID.test(bindingId) && ID.test(messageId) && Number.isSafeInteger(now) && now >= 0;
  const write = (entry: DedupeEntry, now: number): boolean => {
    try {
      const next = transaction(() => {
        const cutoff = Math.max(0, now - ttlMs);
        const latest = [...parseDocument(fs.read(options.path), maxEntries)];
        const key = keyOf(entry.bindingId, entry.messageId);
        const current = latest.find((candidate) => keyOf(candidate.bindingId, candidate.messageId) === key
          && (candidate.state === "reserved" || candidate.state === "replying" || candidate.updatedAt >= cutoff));
        if (entry.state === "reserved") {
          if (current) throw new Error("DISCORD_DEDUPE_CONFLICT");
        } else if (!current || (current.owner !== entry.owner
          && !(entry.state === "replying" && current.state === "partial"))) {
          throw new Error("DISCORD_DEDUPE_CONFLICT");
        }
        let durable = entry;
        if (entry.state === "replying" && current?.state === "replying") {
          if (JSON.stringify(current.chunks) !== JSON.stringify(entry.chunks)
            || !((entry.nextChunk === current.nextChunk! + 1 && entry.confirmedChunk === current.confirmedChunk)
              || (entry.nextChunk === current.nextChunk && entry.confirmedChunk === current.confirmedChunk! + 1))) {
            throw new Error("DISCORD_DEDUPE_CONFLICT");
          }
        }
        if (entry.state === "replying" && current && current.state !== "reserved"
          && current.state !== "replying" && current.state !== "partial") {
          throw new Error("DISCORD_DEDUPE_CONFLICT");
        }
        if (entry.state === "replying" && current?.state === "partial"
          && (entry.nextChunk !== current.confirmedChunk || entry.confirmedChunk !== current.confirmedChunk)) {
          throw new Error("DISCORD_DEDUPE_CONFLICT");
        }
        if (entry.state === "partial") {
          if (current?.state === "completed") throw new Error("DISCORD_DEDUPE_CONFLICT");
          durable = { ...entry, confirmedChunk: Math.max(current?.confirmedChunk ?? 0, entry.confirmedChunk ?? 0) };
        }
        const others = latest.filter((candidate) => keyOf(candidate.bindingId, candidate.messageId) !== key);
        const active = others.filter((candidate) => candidate.state === "reserved" || candidate.state === "replying"
          || (candidate.state === "partial" && candidate.updatedAt >= cutoff));
        const terminal = others.filter((candidate) => candidate.state === "completed" && candidate.updatedAt >= cutoff)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, Math.max(0, maxEntries - active.length - 1));
        const combined = [...active, ...terminal, durable];
        if (combined.length > maxEntries) throw new Error("DISCORD_DEDUPE_CAPACITY");
        fs.replace(options.path, JSON.stringify({ version: 2, entries: combined }));
        return combined;
      });
      entries = next;
    } catch {
      return false;
    }
    return true;
  };
  const find = (bindingId: string, messageId: string, now: number) => {
    const cutoff = Math.max(0, now - ttlMs);
    const key = keyOf(bindingId, messageId);
    return entries.find((entry) =>
      keyOf(entry.bindingId, entry.messageId) === key
      && (entry.state === "reserved" || entry.state === "replying" || entry.updatedAt >= cutoff));
  };

  return {
    async refresh() {
      try {
        entries = load();
        return true;
      } catch {
        return false;
      }
    },
    async reserve({ bindingId, messageId, now }) {
      if (!validIdentity(bindingId, messageId, now)) return { decision: "duplicate" };
      const existing = find(bindingId, messageId, now);
      if (existing?.state === "replying") {
        if (existing.nextChunk! > existing.confirmedChunk!) {
          write({
            bindingId,
            messageId,
            updatedAt: now,
            state: "partial",
            owner: existing.owner,
            confirmedChunk: existing.confirmedChunk!,
          }, now);
          return { decision: "duplicate" };
        }
        return { decision: "resume_reply", chunks: existing.chunks!, nextChunk: existing.nextChunk! };
      }
      if (existing) return { decision: "duplicate" };
      return write({ bindingId, messageId, updatedAt: now, state: "reserved", owner }, now)
        ? { decision: "process" }
        : { decision: "duplicate" };
    },
    async releaseReservation({ bindingId, messageId, now }) {
      if (!validIdentity(bindingId, messageId, now)) return false;
      const existing = find(bindingId, messageId, now);
      if (!existing || existing.state !== "reserved") return false;
      const key = keyOf(bindingId, messageId);
      try {
        entries = transaction(() => {
          const latest = [...parseDocument(fs.read(options.path), maxEntries)];
          const current = latest.find((entry) => keyOf(entry.bindingId, entry.messageId) === key);
          if (!current || current.state !== "reserved" || current.owner !== existing.owner) {
            throw new Error("DISCORD_DEDUPE_CONFLICT");
          }
          const next = latest.filter((entry) => keyOf(entry.bindingId, entry.messageId) !== key);
          fs.replace(options.path, JSON.stringify({ version: 2, entries: next }));
          return next;
        });
        return true;
      } catch {
        return false;
      }
    },
    async beginReply({ bindingId, messageId, chunks, now }) {
      if (!validIdentity(bindingId, messageId, now) || !validChunks(chunks)) return false;
      const existing = find(bindingId, messageId, now);
      if (!existing || existing.state !== "reserved") return false;
      return write({
        bindingId,
        messageId,
        updatedAt: now,
        state: "replying",
        owner: existing.owner,
        chunks: [...chunks],
        nextChunk: 0,
        confirmedChunk: 0,
      }, now);
    },
    async claimChunk({ bindingId, messageId, nextChunk, now }) {
      if (!validIdentity(bindingId, messageId, now) || !Number.isSafeInteger(nextChunk)) return false;
      const existing = find(bindingId, messageId, now);
      if (!existing || existing.state !== "replying" || !existing.chunks
        || nextChunk !== existing.nextChunk! + 1 || nextChunk > existing.chunks.length
        || existing.nextChunk !== existing.confirmedChunk) return false;
      return write({ ...existing, updatedAt: now, nextChunk }, now);
    },
    async confirmChunk({ bindingId, messageId, confirmedChunk, now }) {
      if (!validIdentity(bindingId, messageId, now) || !Number.isSafeInteger(confirmedChunk)) return false;
      const existing = find(bindingId, messageId, now);
      if (!existing || existing.state !== "replying" || !existing.chunks
        || confirmedChunk !== existing.confirmedChunk! + 1
        || confirmedChunk !== existing.nextChunk) return false;
      if (confirmedChunk === existing.chunks.length) {
        return write({ bindingId, messageId, updatedAt: now, state: "completed", owner: existing.owner }, now);
      }
      return write({ ...existing, updatedAt: now, confirmedChunk }, now);
    },
    async complete({ bindingId, messageId, now }) {
      if (!validIdentity(bindingId, messageId, now)) return false;
      const existing = find(bindingId, messageId, now);
      if (!existing || (existing.state !== "reserved" && existing.state !== "replying")) return false;
      return write({ bindingId, messageId, updatedAt: now, state: "completed", owner: existing.owner }, now);
    },
    async partial({ bindingId, messageId, confirmedChunk, now }) {
      if (!validIdentity(bindingId, messageId, now)
        || !Number.isSafeInteger(confirmedChunk) || confirmedChunk < 0) return false;
      const existing = find(bindingId, messageId, now);
      if (!existing || (existing.state !== "reserved" && existing.state !== "replying"
        && existing.state !== "partial")) return false;
      const durableConfirmedChunk = Math.max(existing.confirmedChunk ?? 0, confirmedChunk);
      if (existing.state === "replying" && durableConfirmedChunk > existing.chunks!.length) return false;
      return write({
        bindingId,
        messageId,
        updatedAt: now,
        state: "partial",
        owner: existing.owner,
        confirmedChunk: durableConfirmedChunk,
      }, now);
    },
    async resumePartialReply({ bindingId, messageId, chunks, now }) {
      if (!validIdentity(bindingId, messageId, now) || !validChunks(chunks)) {
        return { decision: "failed" as const };
      }
      const existing = find(bindingId, messageId, now);
      if (!existing || existing.state !== "partial") return { decision: "not_partial" as const };
      const confirmedChunk = existing.confirmedChunk ?? 0;
      if (confirmedChunk > chunks.length) return { decision: "failed" as const };
      if (!write({
        bindingId,
        messageId,
        updatedAt: now,
        state: "replying",
        owner,
        chunks: [...chunks],
        nextChunk: confirmedChunk,
        confirmedChunk,
      }, now)) return { decision: "failed" as const };
      return { decision: "resumed" as const, nextChunk: confirmedChunk };
    },
  };
}
