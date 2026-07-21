// adapters/radio-dj-runtime — 개인 DJ의 clock/context/selector/exact preference adapter.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MemoryPort } from "../ports/memory.js";
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

export type PreferenceSignal = {
  sentiment: "like" | "dislike" | "forget";
  subject: string;
  sessionId: string;
  requestId: string;
  statedAt: string;
  source: "explicit_user_turn";
};

export type RadioDjPreferenceRecord = PreferenceSignal & {
  schema: "naia.dj.preference.v1";
  idempotencyKey: string;
  subjectKey: string;
  sequence: number;
};

export interface RadioDjPreferenceDocument {
  version: 1;
  nextSequence: number;
  records: Record<string, RadioDjPreferenceRecord>;
  outbox: RadioDjPreferenceRecord[];
  processedRequests: Record<string, number>;
}

export interface RadioDjPreferencePersistence {
  load(): Promise<RadioDjPreferenceDocument | undefined>;
  commit(document: RadioDjPreferenceDocument): Promise<void>;
}

const emptyDocument = (): RadioDjPreferenceDocument => ({
  version: 1,
  nextSequence: 1,
  records: {},
  outbox: [],
  processedRequests: {},
});

const cloneDocument = (document: RadioDjPreferenceDocument): RadioDjPreferenceDocument =>
  structuredClone(document);

const MAX_NEXT_SEQUENCE = Number.MAX_SAFE_INTEGER - 1;

function validRecord(value: unknown): value is RadioDjPreferenceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<RadioDjPreferenceRecord>;
  return record.schema === "naia.dj.preference.v1"
    && ["like", "dislike", "forget"].includes(String(record.sentiment))
    && typeof record.subject === "string"
    && typeof record.subjectKey === "string"
    && typeof record.sessionId === "string"
    && typeof record.requestId === "string"
    && typeof record.statedAt === "string"
    && record.source === "explicit_user_turn"
    && typeof record.idempotencyKey === "string"
    && Number.isSafeInteger(record.sequence)
    && (record.sequence ?? 0) > 0
    && (record.sequence ?? MAX_NEXT_SEQUENCE) < MAX_NEXT_SEQUENCE;
}

function sanitizeDocument(value: unknown): RadioDjPreferenceDocument | undefined {
  if (!value || typeof value !== "object") return undefined;
  const d = value as Partial<RadioDjPreferenceDocument>;
  if (
    d.version !== 1
    || !d.records
    || typeof d.records !== "object"
    || !Array.isArray(d.outbox)
  ) return undefined;
  const records = Object.fromEntries(
    Object.entries(d.records).filter(([, record]) => validRecord(record)),
  );
  const outbox = d.outbox.filter(validRecord);
  const processedRequests = d.processedRequests && typeof d.processedRequests === "object"
    ? Object.fromEntries(Object.entries(d.processedRequests).filter(
      ([key, sequence]) =>
        Boolean(key)
        && Number.isSafeInteger(sequence)
        && Number(sequence) > 0
        && Number(sequence) < MAX_NEXT_SEQUENCE,
    ))
    : {};
  const maxSequence = Math.max(
    0,
    ...Object.values(records).map((record) => record.sequence),
    ...outbox.map((record) => record.sequence),
    ...Object.values(processedRequests),
  );
  return {
    version: 1,
    nextSequence: Math.max(
      Number.isSafeInteger(d.nextSequence)
        && Number(d.nextSequence) > 0
        && Number(d.nextSequence) < Number.MAX_SAFE_INTEGER
        ? Number(d.nextSequence)
        : 1,
      maxSequence + 1,
    ),
    records,
    outbox,
    processedRequests,
  };
}

export function makeFileRadioDjPreferencePersistence(path: string): RadioDjPreferencePersistence {
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        return sanitizeDocument(parsed);
      } catch {
        return undefined;
      }
    },
    async commit(document) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      await rename(temporary, path);
    },
  };
}

function makeMemoryPersistence(): RadioDjPreferencePersistence {
  let value: RadioDjPreferenceDocument | undefined;
  return {
    load: async () => value ? cloneDocument(value) : undefined,
    commit: async (next) => { value = cloneDocument(next); },
  };
}

function subjectKey(subject: string): string {
  return [...subject.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase()]
    .slice(0, 500)
    .join("");
}

function memoryPayload(record: RadioDjPreferenceRecord): string {
  return `[NAIA_DJ_PREFERENCE_V1] ${JSON.stringify(record)}`;
}

export function makeRadioDjPreferenceStore(opts: {
  persistence?: RadioDjPreferencePersistence;
  memory?: MemoryPort;
} = {}) {
  const persistence = opts.persistence ?? makeMemoryPersistence();
  const moods = new Map<string, { quote: string; sessionId: string; statedAt: string }>();
  let loaded: Promise<RadioDjPreferenceDocument> | undefined;
  let queue = Promise.resolve();
  const load = () => loaded ??= persistence.load().then((value) =>
    sanitizeDocument(value) ?? emptyDocument());
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const flushUnlocked = async (): Promise<void> => {
    if (!opts.memory) return;
    let current = await load();
    while (current.outbox.length) {
      const record = current.outbox[0]!;
      const payload = memoryPayload(record);
      await opts.memory.save(
        payload,
        `DJ preference handoff ${record.idempotencyKey}`,
        { idempotencyKey: `naia-dj:${record.idempotencyKey}`, durable: true },
      );
      const next = cloneDocument(current);
      next.outbox.shift();
      await persistence.commit(next);
      loaded = Promise.resolve(next);
      current = next;
    }
  };

  const api = {
    async handoff(signal: PreferenceSignal): Promise<void> {
      return serial(async () => {
        const key = subjectKey(signal.subject);
        const requestId = [...signal.requestId.trim()].slice(0, 200).join("");
        const sessionId = [...signal.sessionId.trim()].slice(0, 200).join("");
        if (!key || !requestId || !sessionId) return;
        const current = await load();
        const requestKey = `${sessionId}\u0000${requestId}`;
        if (current.processedRequests[requestKey]) {
          try { await flushUnlocked(); } catch { /* retry pending handoff */ }
          return;
        }
        const sequence = current.nextSequence;
        if (sequence >= MAX_NEXT_SEQUENCE) {
          throw new Error("DJ preference sequence capacity exhausted");
        }
        const record: RadioDjPreferenceRecord = {
          ...signal,
          sessionId,
          requestId,
          subject: [...signal.subject.trim()].slice(0, 500).join(""),
          schema: "naia.dj.preference.v1",
          idempotencyKey: `${sequence}:${requestId}`,
          subjectKey: key,
          sequence,
        };
        const next = cloneDocument(current);
        next.nextSequence = sequence + 1;
        next.processedRequests[requestKey] = sequence;
        next.records[key] = record;
        if (opts.memory) next.outbox.push(record);
        await persistence.commit(next);
        loaded = Promise.resolve(next);
        try { await flushUnlocked(); } catch { /* durable outbox retries on next call/start */ }
      });
    },
    async explicitLikes(): Promise<string[]> {
      const document = await load();
      return Object.values(document.records)
        .filter((record) => record.sentiment === "like")
        .sort((a, b) => a.sequence - b.sequence)
        .map((record) => record.subject);
    },
    recordMood(input: { sessionId: string; quote: string; statedAt: string }): void {
      const quote = [...input.quote.trim()].slice(0, 500).join("");
      if (!input.sessionId.trim() || !quote || !Number.isFinite(Date.parse(input.statedAt))) return;
      moods.set(input.sessionId, { ...input, quote });
      if (moods.size > 100) moods.delete(moods.keys().next().value!);
    },
    explicitMood(sessionId: string) {
      return moods.get(sessionId);
    },
    async flushOutbox(): Promise<void> {
      return serial(flushUnlocked);
    },
    async document(): Promise<RadioDjPreferenceDocument> {
      return cloneDocument(await load());
    },
  };
  return api;
}

const MOOD_FRESH_MS = 6 * 60 * 60_000;
const WEATHER_FRESH_MS = 60 * 60_000;

export function makeRadioDjContext(deps: {
  readonly now?: () => Date;
  readonly explicitLikes: (sessionId: string) => readonly string[] | Promise<readonly string[]>;
  readonly explicitMood?: (
    sessionId: string,
  ) => { quote: string; sessionId: string; statedAt: string } | undefined;
  readonly recordMood?: (input: { sessionId: string; quote: string; statedAt: string }) => void;
  readonly fetchWeather?: (
    latitude: number,
    longitude: number,
  ) => Promise<{ code: number; tempC: number; observedAt?: string }>;
}) {
  return {
    recordMood: deps.recordMood,
    async snapshot(config: PersonalRadioDjConfig): Promise<DjContextSnapshot> {
      const now = deps.now?.() ?? new Date();
      let weather: DjContextSnapshot["weather"];
      if (config.weatherLocation?.consented && deps.fetchWeather) {
        try {
          const value = await deps.fetchWeather(
            config.weatherLocation.latitude,
            config.weatherLocation.longitude,
          );
          const observedAt = value.observedAt ?? now.toISOString();
          const weatherAge = now.getTime() - Date.parse(observedAt);
          if (
            Number.isFinite(weatherAge)
            && weatherAge >= 0
            && weatherAge <= WEATHER_FRESH_MS
            && Number.isFinite(value.code)
            && Number.isFinite(value.tempC)
          ) {
            weather = {
              code: value.code,
              tempC: value.tempC,
              observedAt,
              source: "open-meteo",
            };
          }
        } catch {
          // Missing weather is omitted; caller forbids guessing.
        }
      }
      const mood = deps.explicitMood?.(config.sessionId);
      const moodAge = mood ? now.getTime() - Date.parse(mood.statedAt) : Number.NaN;
      const freshMood = mood
        && Number.isFinite(moodAge)
        && moodAge >= 0
        && moodAge <= MOOD_FRESH_MS;
      const likes = await deps.explicitLikes(config.sessionId);
      return {
        localTime: {
          iso: now.toISOString(),
          timezone: config.timezone,
          source: "configured",
        },
        ...(weather ? { weather } : {}),
        ...(freshMood ? { moodActivity: mood } : {}),
        preferences: likes.slice(0, 10).map((text) => ({
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
      if (snapshot.moodActivity) {
        const mood = snapshot.moodActivity.quote
          .normalize("NFKC")
          .replace(/[\p{Cc}\p{Cf}]/gu, " ")
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, 100);
        return {
          query: `${timeBand} ${mood}에 어울리는 음악 믹스`,
          reason: "mood" as const,
        };
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
