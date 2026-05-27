// naia-gateway heartbeat sender (Slice 5-RB1.c).
//
// Safety-net layer [4] (plan §0.8): dev/verification ONLY — production user
// traffic is unaffected. The gateway-side cron (layer [2]) is the primary
// dead-agent detector; this is a redundant signal we explicitly mark as
// fate-sharing with the gateway endpoint.
//
// Activation: env `NAIA_AGENT_HEARTBEAT=1`. Default OFF.
// Interval:   env `NAIA_AGENT_HEARTBEAT_INTERVAL_MS`, default 60_000.
// Endpoint:   POST {baseURL}/heartbeat  with body { instance_id, ts }.
//
// Failures are silent (no stderr, no exit) — a flaky safety-net layer must
// never block real user calls.

export interface HeartbeatConfig {
  /** Gateway base URL (matches manifest llm.baseURL — `/v1` suffix expected). */
  baseURL: string;
  /** Routing key sent as the heartbeat body. */
  instanceId: string;
  /** Interval in ms. Default 60_000 (1 min). */
  intervalMs?: number;
  /** fetch override for tests. Default = globalThis.fetch. */
  fetcher?: typeof fetch;
  /** Inject a timer wrapper so vitest fake-timers can drive the schedule. */
  scheduler?: HeartbeatScheduler;
}

export interface HeartbeatScheduler {
  setInterval: (cb: () => void, ms: number) => HeartbeatHandle;
  clearInterval: (handle: HeartbeatHandle) => void;
}

export type HeartbeatHandle = unknown;

export interface HeartbeatController {
  /** Stops the timer. Safe to call multiple times. */
  stop: () => void;
}

const HEARTBEAT_PATH = "/heartbeat";
const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Read env to decide whether to start the heartbeat. Returns null when
 * disabled (caller skips). Returned controller's `stop()` is idempotent.
 */
export function maybeStartHeartbeat(
  env: NodeJS.ProcessEnv,
  base: Omit<HeartbeatConfig, "intervalMs">,
): HeartbeatController | null {
  if (env["NAIA_AGENT_HEARTBEAT"] !== "1") return null;
  const intervalMs = parseInterval(env["NAIA_AGENT_HEARTBEAT_INTERVAL_MS"]);
  return startHeartbeat({ ...base, intervalMs });
}

function parseInterval(raw: string | undefined): number {
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1_000) return DEFAULT_INTERVAL_MS;
  return n;
}

export function startHeartbeat(cfg: HeartbeatConfig): HeartbeatController {
  const interval = cfg.intervalMs ?? DEFAULT_INTERVAL_MS;
  const fetcher = cfg.fetcher ?? globalThis.fetch;
  const scheduler = cfg.scheduler ?? nodeScheduler;
  const url = trimTrailingSlash(cfg.baseURL) + HEARTBEAT_PATH;

  const tick = () => {
    void sendOnce(fetcher, url, cfg.instanceId);
  };

  const handle = scheduler.setInterval(tick, interval);
  // Allow process to exit even if heartbeat is still scheduled.
  if (
    typeof handle === "object" &&
    handle !== null &&
    "unref" in handle &&
    typeof (handle as { unref: unknown }).unref === "function"
  ) {
    (handle as { unref: () => void }).unref();
  }

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      scheduler.clearInterval(handle);
    },
  };
}

async function sendOnce(
  fetcher: typeof fetch,
  url: string,
  instanceId: string,
): Promise<void> {
  try {
    await fetcher(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Naia-OS-Instance": instanceId,
      },
      body: JSON.stringify({ instance_id: instanceId, ts: Date.now() }),
    });
  } catch {
    /* silent — layer [4] is a redundant signal, never blocking. */
  }
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

const nodeScheduler: HeartbeatScheduler = {
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};
