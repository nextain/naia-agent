// Slice 5-RB1.c — heartbeat sender tests.
// DI-driven scheduler + fetcher; no real timers or network.

import { describe, it, expect, vi } from "vitest";
import {
  maybeStartHeartbeat,
  startHeartbeat,
  type HeartbeatScheduler,
} from "../utils/heartbeat.js";

function makeScheduler(): HeartbeatScheduler & {
  tick: () => void;
  cleared: boolean;
} {
  let cb: (() => void) | null = null;
  let cleared = false;
  return {
    setInterval: (fn) => {
      cb = fn;
      return { unref: () => undefined };
    },
    clearInterval: () => {
      cleared = true;
      cb = null;
    },
    tick: () => {
      cb?.();
    },
    get cleared() {
      return cleared;
    },
  };
}

describe("maybeStartHeartbeat", () => {
  it("returns null when NAIA_AGENT_HEARTBEAT is unset", () => {
    const ctrl = maybeStartHeartbeat({} as NodeJS.ProcessEnv, {
      baseURL: "https://gateway.example.com/v1",
      instanceId: "00000000-0000-4000-8000-000000000000",
    });
    expect(ctrl).toBeNull();
  });

  it("returns null when NAIA_AGENT_HEARTBEAT=0", () => {
    const ctrl = maybeStartHeartbeat(
      { NAIA_AGENT_HEARTBEAT: "0" } as NodeJS.ProcessEnv,
      {
        baseURL: "https://gateway.example.com/v1",
        instanceId: "00000000-0000-4000-8000-000000000000",
      },
    );
    expect(ctrl).toBeNull();
  });

  it("starts when NAIA_AGENT_HEARTBEAT=1", () => {
    const sch = makeScheduler();
    const ctrl = maybeStartHeartbeat(
      { NAIA_AGENT_HEARTBEAT: "1" } as NodeJS.ProcessEnv,
      {
        baseURL: "https://gateway.example.com/v1",
        instanceId: "00000000-0000-4000-8000-000000000000",
        scheduler: sch,
        fetcher: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      },
    );
    expect(ctrl).not.toBeNull();
    ctrl?.stop();
    expect(sch.cleared).toBe(true);
  });
});

describe("startHeartbeat", () => {
  const INSTANCE = "11111111-1111-4111-8111-111111111111";

  it("posts to {baseURL}/heartbeat with body + header on tick", async () => {
    const sch = makeScheduler();
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const ctrl = startHeartbeat({
      baseURL: "https://gateway.example.com/v1",
      instanceId: INSTANCE,
      intervalMs: 60_000,
      scheduler: sch,
      fetcher,
    });
    sch.tick();
    // sendOnce is fire-and-forget — flush microtasks
    await new Promise((r) => setImmediate(r));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://gateway.example.com/v1/heartbeat");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-Naia-OS-Instance"]).toBe(INSTANCE);
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse((init as RequestInit).body as string) as {
      instance_id: string;
      ts: number;
    };
    expect(body.instance_id).toBe(INSTANCE);
    expect(typeof body.ts).toBe("number");
    ctrl.stop();
  });

  it("trims trailing slash on baseURL", async () => {
    const sch = makeScheduler();
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    startHeartbeat({
      baseURL: "https://gateway.example.com/v1/",
      instanceId: INSTANCE,
      scheduler: sch,
      fetcher,
    });
    sch.tick();
    await new Promise((r) => setImmediate(r));
    expect(fetcher.mock.calls[0]![0]).toBe(
      "https://gateway.example.com/v1/heartbeat",
    );
  });

  it("is silent on fetch failure (no rethrow, no stop)", async () => {
    const sch = makeScheduler();
    const fetcher = vi.fn().mockRejectedValue(new Error("network down"));
    const ctrl = startHeartbeat({
      baseURL: "https://gateway.example.com/v1",
      instanceId: INSTANCE,
      scheduler: sch,
      fetcher,
    });
    expect(() => sch.tick()).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(fetcher).toHaveBeenCalledTimes(1);
    ctrl.stop();
  });

  it("is silent on non-2xx response (still scheduled)", async () => {
    const sch = makeScheduler();
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 500 }));
    const ctrl = startHeartbeat({
      baseURL: "https://gateway.example.com/v1",
      instanceId: INSTANCE,
      scheduler: sch,
      fetcher,
    });
    sch.tick();
    sch.tick();
    await new Promise((r) => setImmediate(r));
    expect(fetcher).toHaveBeenCalledTimes(2);
    ctrl.stop();
  });

  it("stop() is idempotent", () => {
    const sch = makeScheduler();
    const ctrl = startHeartbeat({
      baseURL: "https://gateway.example.com/v1",
      instanceId: INSTANCE,
      scheduler: sch,
      fetcher: vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 200 })),
    });
    ctrl.stop();
    ctrl.stop();
    expect(sch.cleared).toBe(true);
  });
});

describe("maybeStartHeartbeat interval parsing", () => {
  it("uses default 60_000 when env value is invalid", () => {
    const sch = makeScheduler();
    const setSpy = vi.spyOn(sch, "setInterval");
    const ctrl = maybeStartHeartbeat(
      {
        NAIA_AGENT_HEARTBEAT: "1",
        NAIA_AGENT_HEARTBEAT_INTERVAL_MS: "not-a-number",
      } as NodeJS.ProcessEnv,
      {
        baseURL: "https://gateway.example.com/v1",
        instanceId: "00000000-0000-4000-8000-000000000000",
        scheduler: sch,
        fetcher: vi
          .fn()
          .mockResolvedValue(new Response(null, { status: 200 })),
      },
    );
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    ctrl?.stop();
  });

  it("uses default 60_000 when env value is below 1_000", () => {
    const sch = makeScheduler();
    const setSpy = vi.spyOn(sch, "setInterval");
    const ctrl = maybeStartHeartbeat(
      {
        NAIA_AGENT_HEARTBEAT: "1",
        NAIA_AGENT_HEARTBEAT_INTERVAL_MS: "100",
      } as NodeJS.ProcessEnv,
      {
        baseURL: "https://gateway.example.com/v1",
        instanceId: "00000000-0000-4000-8000-000000000000",
        scheduler: sch,
        fetcher: vi
          .fn()
          .mockResolvedValue(new Response(null, { status: 200 })),
      },
    );
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    ctrl?.stop();
  });

  it("honors custom valid interval", () => {
    const sch = makeScheduler();
    const setSpy = vi.spyOn(sch, "setInterval");
    const ctrl = maybeStartHeartbeat(
      {
        NAIA_AGENT_HEARTBEAT: "1",
        NAIA_AGENT_HEARTBEAT_INTERVAL_MS: "30000",
      } as NodeJS.ProcessEnv,
      {
        baseURL: "https://gateway.example.com/v1",
        instanceId: "00000000-0000-4000-8000-000000000000",
        scheduler: sch,
        fetcher: vi
          .fn()
          .mockResolvedValue(new Response(null, { status: 200 })),
      },
    );
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    ctrl?.stop();
  });
});
