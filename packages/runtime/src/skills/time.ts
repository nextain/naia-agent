import type { InMemoryToolDef } from "../mocks/in-memory-tool-executor.js";

export interface TimeSkillOptions {
  tier?: "T0" | "T1" | "T2" | "T3";
}

export function createTimeSkill(opts: TimeSkillOptions = {}): InMemoryToolDef {
  return {
    name: "time",
    description:
      "Get the current date and time. Supports locale, ISO 8601, and Unix timestamp formats. " +
      "Optionally specify a timezone (IANA name, e.g. 'Asia/Seoul').",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["locale", "iso", "unix"],
          description: "Output format. Default: locale.",
        },
        timezone: {
          type: "string",
          description: "IANA timezone name (e.g. 'Asia/Seoul', 'America/New_York').",
        },
      },
    } as Record<string, unknown>,
    tier: opts.tier ?? "T0",
    handler: (input) => {
      const args = input as { format?: string; timezone?: string };
      const format = args.format || "locale";
      const tz = args.timezone;
      const now = new Date();

      switch (format) {
        case "unix":
          return String(Math.floor(now.getTime() / 1000));

        case "iso": {
          if (tz) {
            const formatter = new Intl.DateTimeFormat("en-US", {
              timeZone: tz,
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false,
              fractionalSecondDigits: 3,
              timeZoneName: "longOffset",
            });
            const parts = formatter.formatToParts(now);
            const get = (t: string) =>
              parts.find((p) => p.type === t)?.value ?? "";
            const offset = get("timeZoneName").replace("GMT", "");
            return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset || "Z"}`;
          }
          return now.toISOString();
        }

        default: {
          const options: Intl.DateTimeFormatOptions = tz
            ? { timeZone: tz, dateStyle: "full", timeStyle: "long" }
            : { dateStyle: "full", timeStyle: "long" };
          return new Intl.DateTimeFormat("ko-KR", options).format(now);
        }
      }
    },
  };
}
