import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { DiscordInboxPort, DiscordInboxRecord } from "../ports/discord.js";

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
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SNOWFLAKE = /^\d{1,128}$/;
const MAX_CONTENT_LENGTH = 4_000;
const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_MAX_BYTES = 512 * 1_024;
const MAX_CHANNELS = 256;
let tempSequence = 0;

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

function parseDocument(raw: string, generation: string): DiscordInboxDocument {
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

function replaceAtomic(path: string, contents: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${++tempSequence}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temp, "wx", 0o600);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temp, path);
    try {
      const directoryDescriptor = openSync(directory, "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } catch { /* directory fsync is unavailable on some platforms */ }
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

export function makeFileDiscordInbox(options: DiscordInboxStoreOptions): DiscordInboxPort {
  if (!isAbsolute(options.path) || !ID.test(options.generation)) {
    throw new Error("DISCORD_INBOX_CONFIG_INVALID");
  }
  const maxRecords = boundedPositive(options.maxRecordsPerChannel, DEFAULT_MAX_RECORDS, 10_000);
  const maxBytes = boundedPositive(options.maxBytesPerChannel, DEFAULT_MAX_BYTES, 16 * 1_024 * 1_024);
  let document: DiscordInboxDocument = { version: 1, generation: options.generation, channels: {} };
  let initializationFailed = false;
  try {
    document = parseDocument(readFileSync(options.path, "utf8"), options.generation);
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
        document = { version: 1, generation: options.generation, channels };
        replaceAtomic(options.path, JSON.stringify(document));
        result = true;
      }).catch(() => { result = false; });
      return queue.then(() => result);
    },
  };
}
