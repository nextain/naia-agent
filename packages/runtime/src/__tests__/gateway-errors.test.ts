// Slice 5-RB1.a / 5-RB1.b — gateway-errors utility.
// Pure unit tests: no fetch, no fs, no timers (DI-driven retry).

import { describe, it, expect } from "vitest";
import {
  classifyGatewayError,
  formatGatewayErrorMessage,
  coldStartDelayMs,
  coldStartTimeoutMessage,
  isEnglishLocale,
  COLD_START_MAX_ELAPSED_MS,
} from "../utils/gateway-errors.js";

describe("classifyGatewayError", () => {
  it("classifies 401 license-failed", () => {
    const r = classifyGatewayError(401, { error: "license-failed" });
    expect(r).toEqual({ cls: "license-failed", status: 401 });
  });

  it("classifies 402 credit-insufficient", () => {
    const r = classifyGatewayError(402, { error: "credit-insufficient" });
    expect(r).toEqual({ cls: "credit-insufficient", status: 402 });
  });

  it("classifies 503 pod-starting with body tag", () => {
    const r = classifyGatewayError(503, { error: "pod-starting" });
    expect(r).toEqual({ cls: "pod-starting", status: 503 });
  });

  it("classifies 503 without body (infra-stripped) as pod-starting", () => {
    const r = classifyGatewayError(503, undefined);
    expect(r).toEqual({ cls: "pod-starting", status: 503 });
  });

  it("captures Retry-After numeric seconds on 503", () => {
    const r = classifyGatewayError(503, { error: "pod-starting" }, "12");
    expect(r).toEqual({ cls: "pod-starting", status: 503, retryAfterSeconds: 12 });
  });

  it("ignores malformed Retry-After (HTTP-date / NaN)", () => {
    const r = classifyGatewayError(503, undefined, "Wed, 21 Oct 2026 07:28:00 GMT");
    expect(r).toEqual({ cls: "pod-starting", status: 503 });
  });

  it("does not classify 401 without license-failed tag", () => {
    expect(classifyGatewayError(401, { error: "invalid-key" })).toBeNull();
    expect(classifyGatewayError(401, undefined)).toBeNull();
  });

  it("does not classify 402 without credit-insufficient tag", () => {
    expect(classifyGatewayError(402, { error: "something-else" })).toBeNull();
  });

  it("returns null for unclassified statuses (4xx/5xx others)", () => {
    expect(classifyGatewayError(429, undefined)).toBeNull();
    expect(classifyGatewayError(500, undefined)).toBeNull();
    expect(classifyGatewayError(200, undefined)).toBeNull();
  });
});

describe("formatGatewayErrorMessage", () => {
  it("emits Korean by default with pricing deeplink", () => {
    const msg = formatGatewayErrorMessage({ cls: "license-failed", status: 401 });
    expect(msg).toContain("유료 인증");
    expect(msg).toContain("https://naia.nextain.io/ko/pricing");
  });

  it("emits English when lang=en", () => {
    const msg = formatGatewayErrorMessage(
      { cls: "credit-insufficient", status: 402 },
      "en",
    );
    expect(msg).toContain("credit insufficient");
    expect(msg).toContain("https://naia.nextain.io/en/pricing");
  });

  it("falls back to ko for unsupported lang tags", () => {
    const msg = formatGatewayErrorMessage(
      { cls: "license-failed", status: 401 },
      "fr",
    );
    expect(msg).toContain("https://naia.nextain.io/ko/pricing");
  });

  it("uses ja/zh manuals when lang matches", () => {
    expect(
      formatGatewayErrorMessage({ cls: "license-failed", status: 401 }, "ja"),
    ).toContain("/ja/pricing");
    expect(
      formatGatewayErrorMessage({ cls: "license-failed", status: 401 }, "zh-CN"),
    ).toContain("/zh/pricing");
  });

  it("emits a pod-starting hint with no URL leak", () => {
    const msg = formatGatewayErrorMessage({ cls: "pod-starting", status: 503 });
    expect(msg).toContain("준비 중");
    expect(msg).not.toContain("https://");
  });
});

describe("coldStartDelayMs", () => {
  it("starts at 5s and doubles up to 60s cap", () => {
    expect(coldStartDelayMs(0)).toBe(5_000);
    expect(coldStartDelayMs(1)).toBe(10_000);
    expect(coldStartDelayMs(2)).toBe(20_000);
    expect(coldStartDelayMs(3)).toBe(40_000);
    expect(coldStartDelayMs(4)).toBe(60_000);
    expect(coldStartDelayMs(5)).toBe(60_000);
    expect(coldStartDelayMs(20)).toBe(60_000);
  });

  it("honors Retry-After hint clamped to [1s, 60s]", () => {
    expect(coldStartDelayMs(0, 7)).toBe(7_000);
    expect(coldStartDelayMs(0, 0)).toBe(1_000); // clamp lo
    expect(coldStartDelayMs(0, 600)).toBe(60_000); // clamp hi
  });
});

describe("cold-start cap constant", () => {
  it("COLD_START_MAX_ELAPSED_MS = 5 min (plan §0.6)", () => {
    expect(COLD_START_MAX_ELAPSED_MS).toBe(300_000);
  });
});

describe("coldStartTimeoutMessage", () => {
  it("ko default", () => {
    expect(coldStartTimeoutMessage()).toContain("5분");
  });
  it("en", () => {
    expect(coldStartTimeoutMessage("en")).toContain("5 min");
  });
  it("POSIX (c) → en (Round 2 fix — unified through normalizeLang)", () => {
    expect(coldStartTimeoutMessage("c")).toContain("5 min");
  });
  it("POSIX (posix) → en", () => {
    expect(coldStartTimeoutMessage("posix")).toContain("5 min");
  });
  it("fr falls back to ko", () => {
    expect(coldStartTimeoutMessage("fr")).toContain("5분");
  });
});

describe("isEnglishLocale", () => {
  it("identifies en variants", () => {
    expect(isEnglishLocale("en")).toBe(true);
    expect(isEnglishLocale("en-US")).toBe(true);
    expect(isEnglishLocale("EN")).toBe(true);
  });
  it("identifies POSIX as en", () => {
    expect(isEnglishLocale("c")).toBe(true);
    expect(isEnglishLocale("posix")).toBe(true);
    expect(isEnglishLocale("")).toBe(true);
  });
  it("rejects ko / ja / zh / fr", () => {
    expect(isEnglishLocale("ko")).toBe(false);
    expect(isEnglishLocale("ja")).toBe(false);
    expect(isEnglishLocale("zh")).toBe(false);
    expect(isEnglishLocale("fr")).toBe(false);
  });
});
