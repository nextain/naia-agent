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

function heartbeatPath(path: string, token: string): string {
  return `${path}.${token}.heartbeat`;
}

function readHeartbeat(path: string, record: GenerationLeaseRecord): GenerationLeaseRecord | undefined {
  const heartbeat = readLease(heartbeatPath(path, record.token));
  return heartbeat?.generation === record.generation && heartbeat.token === record.token
    ? heartbeat
    : undefined;
}

function claimGenerationLease(input: { readonly path: string; readonly generation: string }):
  { isOwner(): boolean; release(): void } | undefined {
  const path = `${input.path}.${input.generation}.lock`;
  const token = randomUUID();
  const ownerHeartbeatPath = heartbeatPath(path, token);
  const makeRecord = (): GenerationLeaseRecord => ({
    version: 1,
    generation: input.generation,
    token,
    updatedAt: Date.now(),
  });
  if (!createLease(ownerHeartbeatPath, makeRecord())) return undefined;
  let claimed = createLease(path, makeRecord());
  let previous: GenerationLeaseRecord | undefined;
  if (!claimed && existsSync(path)) {
    const current = readLease(path);
    previous = current;
    let lastChangedAt = 0;
    try { lastChangedAt = statSync(path).mtimeMs; } catch { /* file may have disappeared */ }
    const heartbeat = current ? readHeartbeat(path, current) : undefined;
    const lastUpdatedAt = heartbeat?.updatedAt ?? current?.updatedAt;
    const isStale = current
      ? Date.now() - (lastUpdatedAt ?? 0) > LEASE_TTL_MS
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
  if (!claimed) {
    try { unlinkSync(ownerHeartbeatPath); } catch { /* best effort */ }
    return undefined;
  }
  if (previous) {
    try { unlinkSync(heartbeatPath(path, previous.token)); } catch { /* stale owner may have exited */ }
  }

  const isOwner = (): boolean => {
    const current = readLease(path);
    const heartbeat = readLease(ownerHeartbeatPath);
    return current?.generation === input.generation
      && current.token === token
      && heartbeat?.generation === input.generation
      && heartbeat.token === token
      && Date.now() - heartbeat.updatedAt <= LEASE_TTL_MS;
  };

  const refresh = setInterval(() => {
    if (!isOwner()) return;
    try { replaceOwnerOnlyAtomic(ownerHeartbeatPath, JSON.stringify(makeRecord())); }
    catch { /* another generation owner will fail closed until this lease expires */ }
  }, LEASE_REFRESH_MS);
  refresh.unref();
  let released = false;
  return {
    isOwner,
    release() {
      if (released) return;
      released = true;
      clearInterval(refresh);
      if (readLease(path)?.token === token) {
        try { unlinkSync(path); } catch { /* best effort */ }
      }
      try { unlinkSync(ownerHeartbeatPath); } catch { /* best effort */ }
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
  let leaseAttempted = false;
  let localLease: ReturnType<typeof claimGenerationLease>;
  const generationSelected = (): boolean => {
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
  };
  return {
    isActive() {
      if (!generationSelected()) return false;
      return !leaseAttempted || localLease?.isOwner() === true;
    },
    acquire() {
      leaseAttempted = true;
      if (!generationSelected()) return undefined;
      try {
        localLease = claimGenerationLease(input);
        return localLease;
      } catch {
        return undefined;
      }
    },
  };
}
