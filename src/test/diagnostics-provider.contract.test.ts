// F1 rich-health provider 테스트 — gRPC Diagnostics RPC onDiagnostics. now 주입(순수 검증).
import { describe, it, expect } from "vitest";
import { makeDiagnosticsProvider } from "../main/adapters/diagnostics-provider.js";

describe("makeDiagnosticsProvider (F1 rich-health)", () => {
  it("version/uptime(now-startedAt)/components 산출", () => {
    const p = makeDiagnosticsProvider({ version: "0.9.0", startedAtMs: 1000, now: () => 6000, components: () => [{ name: "provider", healthy: true }] });
    expect(p()).toEqual({ version: "0.9.0", uptimeMs: 5000, healthy: true, components: [{ name: "provider", healthy: true }] });
  });
  it("컴포넌트 unhealthy 있으면 healthy=false", () => {
    const p = makeDiagnosticsProvider({ version: "v", startedAtMs: 0, now: () => 0, components: () => [{ name: "a", healthy: true }, { name: "b", healthy: false }] });
    expect(p().healthy).toBe(false);
  });
  it("components 미주입 → 빈 + healthy true(agent 자체 응답중)", () => {
    const r = makeDiagnosticsProvider({ version: "v", startedAtMs: 0, now: () => 100 })();
    expect(r).toEqual({ version: "v", uptimeMs: 100, healthy: true, components: [] });
  });
  it("components throw → contain(unhealthy 표면화, crash X)", () => {
    const p = makeDiagnosticsProvider({ version: "v", startedAtMs: 0, now: () => 0, components: () => { throw new Error("boom"); } });
    expect(p().healthy).toBe(false);
    expect(p().components).toEqual([{ name: "components", healthy: false }]);
  });
  it("uptime 음수 방지(now<startedAt → 0)", () => {
    expect(makeDiagnosticsProvider({ version: "v", startedAtMs: 5000, now: () => 1000 })().uptimeMs).toBe(0);
  });
});
