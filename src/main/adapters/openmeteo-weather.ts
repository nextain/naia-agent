// adapters/openmeteo-weather — §E get_weather 의 fetchWeather 구현(open-meteo, API 키 불요).
// 추출만 — tempC/code 유한성·abort 는 skill(builtin-skills)이 검증/처리(§E.3). HTTP 실패=throw(skill catch→isError).
type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** open-meteo current weather fetcher. SkillDeps.fetchWeather 로 주입. */
export function makeOpenMeteoFetchWeather(deps: { fetch?: FetchLike; baseUrl?: string } = {}): (lat: number, lon: number, signal?: AbortSignal) => Promise<{ tempC: number; code: number }> {
  const doFetch: FetchLike = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = deps.baseUrl ?? "https://api.open-meteo.com/v1/forecast";
  return async (lat, lon, signal) => {
    const url = `${base}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=temperature_2m,weather_code`;
    const r = await doFetch(url, signal ? { signal } : {});
    if (!r.ok) throw new Error(`open-meteo HTTP ${r.status}`);
    const j = (await r.json()) as { current?: { temperature_2m?: unknown; weather_code?: unknown } };
    // ⚠️ typeof number 만 채택 → 아니면 NaN. Number(null)=0·Number("")=0 처럼 유한값으로 둔갑해 skill 검증을
    //    우회("기온 0°C" 가짜성공)하는 것 방지. NaN 은 skill 의 Number.isFinite 가 isError 처리.
    const num = (v: unknown): number => (typeof v === "number" ? v : NaN);
    return { tempC: num(j?.current?.temperature_2m), code: num(j?.current?.weather_code) };
  };
}
