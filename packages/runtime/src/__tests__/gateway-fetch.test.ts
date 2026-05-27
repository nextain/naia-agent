// Slice 5-RB1.a / 5-RB1.b integration — fetch wrapper end-to-end.

import { describe, it, expect, vi } from "vitest";
import { makeGatewayFetch } from "../utils/gateway-fetch.js";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
  });
}

function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

class FatalThrow extends Error {
  constructor(public cls: string) {
    super(cls);
  }
}
const throwOnFatal = (cls: string): never => {
  throw new FatalThrow(cls);
};

describe("makeGatewayFetch", () => {
  it("passes through 2xx responses unchanged", async () => {
    const fetcher = makeGatewayFetch({
      rawFetch: vi.fn().mockResolvedValue(jsonResponse(200, { ok: true })),
      onFatalError: throwOnFatal as never,
    });
    const r = await fetcher("https://example.com");
    expect(r.status).toBe(200);
  });

  it("passes through unclassified 4xx unchanged", async () => {
    const fetcher = makeGatewayFetch({
      rawFetch: vi
        .fn()
        .mockResolvedValue(jsonResponse(429, { error: "rate-limited" })),
      onFatalError: throwOnFatal as never,
    });
    const r = await fetcher("https://example.com");
    expect(r.status).toBe(429);
  });

  it("classifies 401 license-failed → onFatalError + KO message", async () => {
    const fetcher = makeGatewayFetch({
      rawFetch: vi
        .fn()
        .mockResolvedValue(jsonResponse(401, { error: "license-failed" })),
      lang: "ko",
      onFatalError: throwOnFatal as never,
    });
    await expect(fetcher("https://example.com")).rejects.toThrow(FatalThrow);
    try {
      await fetcher("https://example.com");
    } catch (e) {
      expect((e as FatalThrow).cls).toBe("license-failed");
    }
  });

  it("classifies 402 credit-insufficient → onFatalError", async () => {
    let captured: { cls: string; msg: string } | null = null;
    const fetcher = makeGatewayFetch({
      rawFetch: vi
        .fn()
        .mockResolvedValue(jsonResponse(402, { error: "credit-insufficient" })),
      lang: "en",
      onFatalError: ((cls: string, msg: string) => {
        captured = { cls, msg };
        throw new FatalThrow(cls);
      }) as never,
    });
    await expect(fetcher("https://example.com")).rejects.toThrow(FatalThrow);
    expect(captured).not.toBeNull();
    expect(captured!.cls).toBe("credit-insufficient");
    expect(captured!.msg).toContain("credit insufficient");
    expect(captured!.msg).toContain("/en/pricing");
  });

  it("retries on 503 pod-starting then succeeds", async () => {
    const clock = makeClock();
    const raw = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: "pod-starting" }))
      .mockResolvedValueOnce(jsonResponse(503, { error: "pod-starting" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const pending: Array<{ msg: string; wait: number }> = [];
    const fetcher = makeGatewayFetch({
      rawFetch: raw as unknown as typeof fetch,
      onFatalError: throwOnFatal as never,
      onPodStarting: (msg, wait) => pending.push({ msg, wait }),
      now: clock.now,
      sleep: clock.sleep,
    });
    const r = await fetcher("https://example.com");
    expect(r.status).toBe(200);
    expect(raw).toHaveBeenCalledTimes(3);
    // onPodStarting fires on every retry (alive-signal each cycle, cross-review r1 fix)
    expect(pending).toHaveLength(2);
    expect(pending[0]!.wait).toBe(5_000);
    expect(pending[1]!.wait).toBe(10_000);
    expect(pending[0]!.msg).toContain("준비 중");
  });

  it("honors Retry-After on 503", async () => {
    const clock = makeClock();
    let attempts = 0;
    const sleeps: number[] = [];
    const raw = vi.fn().mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse(
          503,
          { error: "pod-starting" },
          { "Retry-After": "8" },
        );
      }
      return jsonResponse(200, { ok: true });
    });
    const fetcher = makeGatewayFetch({
      rawFetch: raw as unknown as typeof fetch,
      onFatalError: throwOnFatal as never,
      now: clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        await clock.sleep(ms);
      },
    });
    const r = await fetcher("https://example.com");
    expect(r.status).toBe(200);
    expect(sleeps).toEqual([8_000]);
  });

  it("aborts with timeout → onFatalError when cap exceeded", async () => {
    const clock = makeClock();
    const raw = vi
      .fn()
      .mockResolvedValue(jsonResponse(503, { error: "pod-starting" }));
    let captured: { cls: string; msg: string } | null = null;
    const fetcher = makeGatewayFetch({
      rawFetch: raw as unknown as typeof fetch,
      lang: "en",
      onFatalError: ((cls: string, msg: string) => {
        captured = { cls, msg };
        throw new FatalThrow(cls);
      }) as never,
      now: clock.now,
      sleep: clock.sleep,
      maxElapsedMs: 20_000,
    });
    await expect(fetcher("https://example.com")).rejects.toThrow(FatalThrow);
    expect(captured).not.toBeNull();
    expect(captured!.cls).toBe("timeout");
    expect(captured!.msg).toContain("5 min");
  });

  it("503 with non-JSON body still triggers retry", async () => {
    const clock = makeClock();
    const raw = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<html>Bad gateway</html>", {
          status: 503,
          headers: { "Content-Type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const fetcher = makeGatewayFetch({
      rawFetch: raw as unknown as typeof fetch,
      onFatalError: throwOnFatal as never,
      now: clock.now,
      sleep: clock.sleep,
    });
    const r = await fetcher("https://example.com");
    expect(r.status).toBe(200);
  });
});
