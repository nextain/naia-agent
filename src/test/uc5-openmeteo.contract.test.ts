// open-meteo fetchWeather 어댑터 계약 테스트 — mock fetch(실 네트워크 0).
import { describe, it, expect } from "vitest";
import { makeOpenMeteoFetchWeather } from "../main/adapters/openmeteo-weather.js";

const mk = (resp: { ok?: boolean; status?: number; body?: unknown }) => {
  let url = "";
  const fetch = async (u: string) => { url = u; return { ok: resp.ok ?? true, status: resp.status ?? 200, json: async () => resp.body }; };
  return { fetch: fetch as never, urlOf: () => url };
};

describe("makeOpenMeteoFetchWeather", () => {
  it("정상 응답 → {tempC, code} 추출 + URL 파라미터", async () => {
    const m = mk({ body: { current: { temperature_2m: 15.6, weather_code: 1 } } });
    const f = makeOpenMeteoFetchWeather({ fetch: m.fetch });
    expect(await f(37.5, 127)).toEqual({ tempC: 15.6, code: 1 });
    expect(m.urlOf()).toContain("latitude=37.5");
    expect(m.urlOf()).toContain("longitude=127");
    expect(m.urlOf()).toContain("current=temperature_2m,weather_code");
  });
  it("HTTP !ok → throw(skill 이 catch→isError)", async () => {
    const f = makeOpenMeteoFetchWeather({ fetch: mk({ ok: false, status: 503 }).fetch });
    await expect(f(0, 0)).rejects.toThrow(/503/);
  });
  it("current 결측 → {NaN, NaN}(skill 의 Number.isFinite 가 isError 처리)", async () => {
    const f = makeOpenMeteoFetchWeather({ fetch: mk({ body: {} }).fetch });
    const r = await f(0, 0);
    expect(Number.isNaN(r.tempC)).toBe(true);
    expect(Number.isNaN(r.code)).toBe(true);
  });
  it("null/빈문자열 → NaN(Number 강제변환 0 둔갑 차단)", async () => {
    const f = makeOpenMeteoFetchWeather({ fetch: mk({ body: { current: { temperature_2m: null, weather_code: "" } } }).fetch });
    const r = await f(0, 0);
    expect(Number.isNaN(r.tempC)).toBe(true);
    expect(Number.isNaN(r.code)).toBe(true);
  });
});
