// adapters/radio-dj-runtime — 개인 DJ의 기본 clock/context/selector/preference adapter.
import type {
  DjContextSnapshot,
  PersonalRadioDjConfig,
  ProactiveScheduler,
} from "../ports/speech-activity.js";

export function makeSystemProactiveScheduler(): ProactiveScheduler {
  return {
    now: () => Date.now(),
    schedule(delayMs, run) {
      const timer = setTimeout(() => { void Promise.resolve(run()).catch(() => {}); }, delayMs);
      return () => clearTimeout(timer);
    },
  };
}

type PreferenceSignal = {
  sentiment: "like" | "dislike";
  subject: string;
  sessionId: string;
  requestId: string;
  statedAt: string;
  source: "explicit_user_turn";
};

export function makeRadioDjPreferenceStore() {
  const signals: PreferenceSignal[] = [];
  return {
    async handoff(signal: PreferenceSignal): Promise<void> {
      signals.push(signal);
      if (signals.length > 100) signals.shift();
    },
    explicitLikes(sessionId: string): string[] {
      const latest = new Map<string, "like" | "dislike">();
      for (const signal of signals) {
        if (signal.sessionId === sessionId) latest.set(signal.subject, signal.sentiment);
      }
      return [...latest].filter(([, sentiment]) => sentiment === "like").map(([subject]) => subject);
    },
  };
}

export function makeRadioDjContext(deps: {
  readonly now?: () => Date;
  readonly explicitLikes: (sessionId: string) => readonly string[];
  readonly fetchWeather?: (
    latitude: number,
    longitude: number,
  ) => Promise<{ code: number; tempC: number; observedAt?: string }>;
}) {
  return {
    async snapshot(config: PersonalRadioDjConfig): Promise<DjContextSnapshot> {
      const now = deps.now?.() ?? new Date();
      let weather: DjContextSnapshot["weather"];
      if (config.weatherLocation?.consented && deps.fetchWeather) {
        try {
          const value = await deps.fetchWeather(
            config.weatherLocation.latitude,
            config.weatherLocation.longitude,
          );
          weather = {
            code: value.code,
            tempC: value.tempC,
            observedAt: value.observedAt ?? now.toISOString(),
            source: "open-meteo",
          };
        } catch {
          // missing weather is omitted; caller forbids guessing.
        }
      }
      return {
        localTime: {
          iso: now.toISOString(),
          timezone: config.timezone,
          source: "configured",
        },
        ...(weather ? { weather } : {}),
        preferences: deps.explicitLikes(config.sessionId).slice(0, 10).map((text) => ({
          text,
          source: "user-memory" as const,
          confidence: "explicit" as const,
        })),
      };
    },
  };
}

export function makeDeterministicRadioDjSelector() {
  return {
    async select(snapshot: DjContextSnapshot, opts?: { changeVibe?: boolean }) {
      const hour = localHour(snapshot.localTime.iso, snapshot.localTime.timezone);
      const timeBand = hour < 6 ? "새벽" : hour < 12 ? "아침" : hour < 18 ? "오후" : "저녁";
      if (opts?.changeVibe) {
        return { query: `${timeBand} 새로운 분위기 음악 믹스`, reason: "time" as const };
      }
      if (snapshot.preferences[0]) {
        return {
          query: `${timeBand} ${snapshot.preferences[0].text} 긴 음악 믹스`,
          reason: "preference" as const,
        };
      }
      if (snapshot.weather) {
        return {
          query: `${timeBand} 날씨에 어울리는 편안한 음악 믹스`,
          reason: "weather" as const,
        };
      }
      return { query: `${timeBand} 편안한 BGM 긴 믹스`, reason: "time" as const };
    },
  };
}

function localHour(iso: string, timezone: string): number {
  try {
    const hour = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(iso)).find((part) => part.type === "hour")?.value;
    const parsed = Number(hour);
    return Number.isInteger(parsed) ? parsed : new Date(iso).getUTCHours();
  } catch {
    return new Date(iso).getUTCHours();
  }
}
