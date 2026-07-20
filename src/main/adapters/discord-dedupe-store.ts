import { readFileSync } from "node:fs";
import type { DiscordDedupePort } from "../ports/discord.js";
import { replaceOwnerOnlyAtomic } from "./owner-only-atomic-file.js";

type DedupeState = "reserved" | "replying" | "completed" | "partial";

interface DedupeEntry {
  readonly bindingId: string;
  readonly messageId: string;
  readonly updatedAt: number;
  readonly state: DedupeState;
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
  let entries = [...parseDocument(fs.read(options.path), maxEntries)]
    .filter((entry) => entry.state !== "reserved");

  const keyOf = (bindingId: string, messageId: string) => `${bindingId}\u0000${messageId}`;
  const validIdentity = (bindingId: string, messageId: string, now: number) =>
    ID.test(bindingId) && ID.test(messageId) && Number.isSafeInteger(now) && now >= 0;
  const persist = (next: readonly DedupeEntry[]): boolean => {
    try {
      fs.replace(options.path, JSON.stringify({ version: 2, entries: next }));
    } catch {
      return false;
    }
    entries = [...next];
    return true;
  };
  const write = (entry: DedupeEntry, now: number): boolean => {
    const key = keyOf(entry.bindingId, entry.messageId);
    const cutoff = Math.max(0, now - ttlMs);
    const existing = entries.filter((candidate) => keyOf(candidate.bindingId, candidate.messageId) !== key);
    const active = existing.filter((candidate) => candidate.state === "reserved" || candidate.state === "replying");
    const terminal = existing.filter((candidate) =>
      candidate.state !== "reserved" && candidate.state !== "replying" && candidate.updatedAt >= cutoff);
    const next = [...active, ...terminal, entry];
    if (next.length > maxEntries) {
      const terminalKeys = new Set(
        terminal
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, Math.max(0, maxEntries - active.length - 1))
          .map((candidate) => keyOf(candidate.bindingId, candidate.messageId)),
      );
      const bounded = [...active, ...terminal.filter((candidate) => terminalKeys.has(keyOf(candidate.bindingId, candidate.messageId))), entry];
      if (bounded.length > maxEntries) return false;
      return persist(bounded);
    }
    return persist(next);
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
        entries = [...parseDocument(fs.read(options.path), maxEntries)]
          .filter((entry) => entry.state !== "reserved");
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
            confirmedChunk: existing.confirmedChunk!,
          }, now);
          return { decision: "duplicate" };
        }
        return { decision: "resume_reply", chunks: existing.chunks!, nextChunk: existing.nextChunk! };
      }
      if (existing) return { decision: "duplicate" };
      return write({ bindingId, messageId, updatedAt: now, state: "reserved" }, now)
        ? { decision: "process" }
        : { decision: "duplicate" };
    },
    async releaseReservation({ bindingId, messageId, now }) {
      if (!validIdentity(bindingId, messageId, now)) return false;
      const existing = find(bindingId, messageId, now);
      if (!existing || existing.state !== "reserved") return false;
      const key = keyOf(bindingId, messageId);
      return persist(entries.filter((entry) => keyOf(entry.bindingId, entry.messageId) !== key));
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
        return write({ bindingId, messageId, updatedAt: now, state: "completed" }, now);
      }
      return write({ ...existing, updatedAt: now, confirmedChunk }, now);
    },
    async complete({ bindingId, messageId, now }) {
      if (!validIdentity(bindingId, messageId, now)) return false;
      const existing = find(bindingId, messageId, now);
      if (!existing || (existing.state !== "reserved" && existing.state !== "replying")) return false;
      return write({ bindingId, messageId, updatedAt: now, state: "completed" }, now);
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
        confirmedChunk: durableConfirmedChunk,
      }, now);
    },
  };
}
