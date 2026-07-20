import { closeSync, openSync, readSync, renameSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { DiscordInboxPort, DiscordInboxRecord } from "../ports/discord.js";
import { replaceOwnerOnlyAtomic } from "./owner-only-atomic-file.js";

interface DiscordInboxDocument {
  readonly version: 1;
  readonly generation: string;
  readonly channels: Readonly<Record<string, readonly DiscordInboxRecord[]>>;
}

export interface DiscordInboxStoreOptions {
  readonly path: string;
  readonly generation: string;
  readonly maxRecordsPerChannel?: number;
  readonly maxBytesPerChannel?: number;
  readonly replaceAtomic?: (path: string, contents: string) => void;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SNOWFLAKE = /^\d{1,128}$/;
const MAX_CONTENT_LENGTH = 4_000;
const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_MAX_BYTES = 512 * 1_024;
const MAX_CHANNELS = 256;
const MAX_FILE_BYTES = 16 * 1_024 * 1_024;

function isRecord(value: unknown): value is DiscordInboxRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<DiscordInboxRecord>;
  return ID.test(String(record.recordId ?? ""))
    && ["incoming", "outgoing"].includes(String(record.direction))
    && ID.test(String(record.bindingId ?? ""))
    && SNOWFLAKE.test(String(record.guildId ?? ""))
    && SNOWFLAKE.test(String(record.channelId ?? ""))
    && SNOWFLAKE.test(String(record.sourceMessageId ?? ""))
    && (record.authorId === undefined || SNOWFLAKE.test(record.authorId))
    && typeof record.content === "string"
    && record.content.length >= 1
    && record.content.length <= MAX_CONTENT_LENGTH
    && Number.isSafeInteger(record.createdAt)
    && record.createdAt! >= 0;
}

function channelKey(record: Pick<DiscordInboxRecord, "bindingId" | "guildId" | "channelId">): string {
  return `${record.bindingId}:${record.guildId}:${record.channelId}`;
}

function readBoundedFile(path: string): string {
  const handle = openSync(path, "r");
  try {
    const bytes = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(handle, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_FILE_BYTES) throw new Error("DISCORD_INBOX_CORRUPT");
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(handle);
  }
}

function parseDocument(
  raw: string,
  generation: string,
  maxRecords: number,
  maxBytes: number,
): DiscordInboxDocument {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("DISCORD_INBOX_CORRUPT"); }
  if (!value || typeof value !== "object") throw new Error("DISCORD_INBOX_CORRUPT");
  const document = value as Partial<DiscordInboxDocument>;
  if (document.version !== 1 || document.generation !== generation
    || !document.channels || typeof document.channels !== "object"
    || Array.isArray(document.channels)
    || Object.keys(document.channels).length > MAX_CHANNELS) {
    throw new Error("DISCORD_INBOX_CORRUPT");
  }
  for (const [key, records] of Object.entries(document.channels)) {
    if (!/^[A-Za-z0-9_-]{1,128}:\d{1,128}:\d{1,128}$/.test(key)
      || !Array.isArray(records) || !records.every(isRecord)
      || records.length > maxRecords
      || Buffer.byteLength(JSON.stringify(records), "utf8") > maxBytes
      || records.some((record) => channelKey(record) !== key)) {
      throw new Error("DISCORD_INBOX_CORRUPT");
    }
  }
  return document as DiscordInboxDocument;
}

function boundedPositive(value: number | undefined, fallback: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > max) {
    throw new Error("DISCORD_INBOX_CONFIG_INVALID");
  }
  return resolved;
}

export function makeFileDiscordInbox(options: DiscordInboxStoreOptions): DiscordInboxPort {
  if (!isAbsolute(options.path) || !ID.test(options.generation)) {
    throw new Error("DISCORD_INBOX_CONFIG_INVALID");
  }
  const maxRecords = boundedPositive(options.maxRecordsPerChannel, DEFAULT_MAX_RECORDS, 10_000);
  const maxBytes = boundedPositive(options.maxBytesPerChannel, DEFAULT_MAX_BYTES, 16 * 1_024 * 1_024);
  const replaceAtomic = options.replaceAtomic ?? replaceOwnerOnlyAtomic;
  let document: DiscordInboxDocument = { version: 1, generation: options.generation, channels: {} };
  let initializationFailed = false;
  try {
    document = parseDocument(
      readBoundedFile(options.path),
      options.generation,
      maxRecords,
      maxBytes,
    );
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = (error as { message?: string }).message;
    if (message === "DISCORD_INBOX_CORRUPT") {
      try {
        renameSync(options.path, `${options.path}.corrupt-${Date.now()}`);
      } catch {
        initializationFailed = true;
      }
    } else if (code !== "ENOENT") {
      initializationFailed = true;
    }
  }
  let queue = Promise.resolve();

  return {
    append(record) {
      if (initializationFailed || !isRecord(record)) return Promise.resolve(false);
      let result = false;
      queue = queue.then(() => {
        const key = channelKey(record);
        const channels = { ...document.channels };
        const existing = channels[key] ?? [];
        if (existing.some((item) => item.recordId === record.recordId)) {
          result = true;
          return;
        }
        const records = [...existing, { ...record }];
        while (records.length > maxRecords
          || Buffer.byteLength(JSON.stringify(records), "utf8") > maxBytes) {
          records.shift();
        }
        if (!records.length) return;
        channels[key] = records;
        const nextDocument: DiscordInboxDocument = {
          version: 1,
          generation: options.generation,
          channels,
        };
        replaceAtomic(options.path, JSON.stringify(nextDocument));
        document = nextDocument;
        result = true;
      }).catch(() => { result = false; });
      return queue.then(() => result);
    },
  };
}
