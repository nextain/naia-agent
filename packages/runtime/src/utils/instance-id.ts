// naia-os instance_id resolver (Slice 5-RB1.d).
//
// gateway routes by `(user_id, instance_id)` so sub-agent fan-out does NOT
// spawn extra Pods (plan §0.5 "sub-agent = 같은 Pod 공유"). naia-agent must
// send `X-Naia-OS-Instance: <uuid>` on every gateway-bound call.
//
// Resolution priority (first match wins):
//   1. {adkPath}/naia-settings/naia-os.json  — naia-os owns this schema
//      (plan §2.4 "naia-os settings schema": instanceId, tierBEnabled, ...).
//   2. {home}/.naia-agent/instance.json      — headless / pre-naia-os fallback.
//      If missing: generate a UUID v4 with crypto.randomUUID() and persist
//      at mode 600 (same posture as naia-agent.env / .naia-agent.json).
//
// The id is a public-ish routing key (NOT a secret), but we keep mode 600
// on the fallback file out of consistency with the rest of ~/.naia-agent/.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";

export interface ResolveInstanceIdDeps {
  /** naia-adk workspace root — resolveAdkPath()'s output in bin. */
  adkPath: string;
  /** User home dir — homedir() in bin. */
  home: string;
}

export interface InstanceIdResolution {
  instanceId: string;
  /** Where the id came from, for stderr diagnostics + tests. */
  source: "naia-settings" | "fallback-existing" | "fallback-generated";
}

interface NaiaOsSettings {
  instanceId?: unknown;
}

interface FallbackFile {
  instanceId?: unknown;
}

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve the naia-os instance_id, generating + persisting one on first run.
 *
 * Never throws on missing files — only rethrows on hard fs errors (EACCES,
 * ENOSPC) the host should surface anyway. JSON parse errors fall through
 * to the next source so a corrupted naia-os.json does not block the agent.
 */
export async function resolveInstanceId(
  deps: ResolveInstanceIdDeps,
): Promise<InstanceIdResolution> {
  // Source 1: {adkPath}/naia-settings/naia-os.json
  const naiaOsPath = join(deps.adkPath, "naia-settings", "naia-os.json");
  const fromSettings = await tryReadInstanceId(naiaOsPath);
  if (fromSettings !== null) {
    return { instanceId: fromSettings, source: "naia-settings" };
  }

  // Source 2: {home}/.naia-agent/instance.json (fallback)
  const fallbackDir = join(deps.home, ".naia-agent");
  const fallbackPath = join(fallbackDir, "instance.json");
  const fromFallback = await tryReadInstanceId(fallbackPath);
  if (fromFallback !== null) {
    return { instanceId: fromFallback, source: "fallback-existing" };
  }

  // Generate + persist (mode 600).
  const instanceId = randomUUID();
  await mkdir(fallbackDir, { recursive: true, mode: 0o700 });
  await writeFile(
    fallbackPath,
    JSON.stringify({ instanceId, createdAt: new Date().toISOString() }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  // mkdir/writeFile mode is best-effort on some platforms; chmod enforces.
  try {
    await chmod(fallbackPath, 0o600);
  } catch {
    /* non-fatal — Windows lacks chmod semantics; the file is still in
       ~/.naia-agent which is user-only on Linux/macOS. */
  }
  return { instanceId, source: "fallback-generated" };
}

async function tryReadInstanceId(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isFsNotFound(err)) return null;
    throw err;
  }
  let parsed: NaiaOsSettings | FallbackFile;
  try {
    parsed = JSON.parse(raw) as NaiaOsSettings | FallbackFile;
  } catch {
    return null;
  }
  const v = parsed.instanceId;
  if (typeof v === "string" && UUID_V4_RE.test(v)) return v;
  return null;
}

function isFsNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
