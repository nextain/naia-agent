import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { DiscordIngressAuthorityPort } from "../ports/discord.js";
import { replaceOwnerOnlyAtomic } from "./owner-only-atomic-file.js";

const GENERATION = /^[A-Za-z0-9_-]{1,128}$/;
const LEASE_TTL_MS = 30_000;
const LEASE_REFRESH_MS = 5_000;

interface GenerationLeaseRecord {
  readonly version: 1;
  readonly generation: string;
  readonly token: string;
  readonly updatedAt: number;
}

function readLease(path: string): GenerationLeaseRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (parsed.version !== 1 || typeof parsed.generation !== "string"
      || typeof parsed.token !== "string" || !/^[a-f0-9-]{36}$/.test(parsed.token)
      || !Number.isSafeInteger(parsed.updatedAt)) return undefined;
    return parsed as unknown as GenerationLeaseRecord;
  } catch {
    return undefined;
  }
}

function createLease(path: string, record: GenerationLeaseRecord): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(record), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    return true;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function claimGenerationLease(input: { readonly path: string; readonly generation: string }):
  { release(): void } | undefined {
  const path = `${input.path}.${input.generation}.lock`;
  const token = randomUUID();
  const makeRecord = (): GenerationLeaseRecord => ({
    version: 1,
    generation: input.generation,
    token,
    updatedAt: Date.now(),
  });
  let claimed = createLease(path, makeRecord());
  if (!claimed && existsSync(path)) {
    const current = readLease(path);
    let lastChangedAt = 0;
    try { lastChangedAt = statSync(path).mtimeMs; } catch { /* file may have disappeared */ }
    const isStale = current
      ? Date.now() - current.updatedAt > LEASE_TTL_MS
      : lastChangedAt > 0 && Date.now() - lastChangedAt > LEASE_TTL_MS;
    if (isStale) {
      const stalePath = `${path}.${randomUUID()}.stale`;
      try {
        renameSync(path, stalePath);
        try { unlinkSync(stalePath); } catch { /* best effort */ }
        claimed = createLease(path, makeRecord());
      } catch {
        claimed = false;
      }
    }
  }
  if (!claimed) return undefined;

  const refresh = setInterval(() => {
    const current = readLease(path);
    if (current?.token !== token) return;
    try { replaceOwnerOnlyAtomic(path, JSON.stringify(makeRecord())); }
    catch { /* another generation owner will fail closed until this lease expires */ }
  }, LEASE_REFRESH_MS);
  refresh.unref();
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      clearInterval(refresh);
      if (readLease(path)?.token !== token) return;
      try { unlinkSync(path); } catch { /* best effort */ }
    },
  };
}

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
    acquire() {
      if (!this.isActive()) return undefined;
      try { return claimGenerationLease(input); }
      catch { return undefined; }
    },
  };
}
