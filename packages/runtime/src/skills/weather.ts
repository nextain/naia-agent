import type { InMemoryToolDef } from "../mocks/in-memory-tool-executor.js";

export interface WeatherSkillOptions {
  tier?: "T0" | "T1" | "T2" | "T3";
  timeoutMs?: number;
}

export function createWeatherSkill(
  opts: WeatherSkillOptions = {},
): InMemoryToolDef {
  const timeoutMs = opts.timeoutMs ?? 10_000;

  return {
    name: "weather",
    description:
      "Get current weather conditions for a location. Uses wttr.in API (no API key required). " +
      "Returns temperature, humidity, wind, UV index, and condition.",
    inputSchema: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City name, airport code, or geographic location.",
        },
      },
      required: ["location"],
    } as Record<string, unknown>,
    tier: opts.tier ?? "T0",
    handler: async (input) => {
      const args = input as { location?: string };
      const location = args.location?.trim();
      if (!location) {
        return "ERROR: location is required";
      }

      try {
        const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
        const res = await fetch(url, {
          headers: { "User-Agent": "Naia-Agent/1.0" },
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
          return `ERROR: Weather API returned ${res.status}`;
        }

        const data = (await res.json()) as {
          current_condition?: Array<{
            temp_C?: string;
            temp_F?: string;
            weatherDesc?: Array<{ value?: string }>;
            humidity?: string;
            windspeedKmph?: string;
            winddir16Point?: string;
            FeelsLikeC?: string;
            uvIndex?: string;
          }>;
          nearest_area?: Array<{
            areaName?: Array<{ value?: string }>;
            country?: Array<{ value?: string }>;
          }>;
        };

        const current = data.current_condition?.[0];
        if (!current) {
          return "ERROR: No weather data available for this location";
        }

        const area = data.nearest_area?.[0];
        const result = {
          location: area?.areaName?.[0]?.value ?? location,
          country: area?.country?.[0]?.value ?? "",
          temperature: `${current.temp_C}°C (${current.temp_F}°F)`,
          feelsLike: `${current.FeelsLikeC}°C`,
          condition: current.weatherDesc?.[0]?.value ?? "Unknown",
          humidity: `${current.humidity}%`,
          wind: `${current.windspeedKmph} km/h ${current.winddir16Point}`,
          uvIndex: current.uvIndex ?? "N/A",
        };

        return JSON.stringify(result, null, 2);
      } catch (err) {
        return `ERROR: Weather failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
