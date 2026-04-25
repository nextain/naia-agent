// Slice 2.7 — Dev mode logger factory.
//
// Auto-detects dev environment (tsx execution, NODE_ENV !== "production",
// or explicit DEV_MODE=1). When dev: enables debug + appends to file at
// ~/.naia-agent/logs/naia-agent-YYYYMMDD.jsonl.
//
// Production: stderr only, level from LOG_LEVEL or default warn.

import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger, LogLevel } from "@nextain/agent-types";
import { ConsoleLogger, type ConsoleLoggerOptions } from "./logger.js";

export interface DevLoggerOptions {
  /** Override level. Default: "debug" if dev else "warn". */
  level?: LogLevel;
  /** Override log file path. Default: ~/.naia-agent/logs/naia-agent-YYYYMMDD.jsonl when dev. */
  logFile?: string;
  /** Force dev mode on/off (overrides auto-detect). */
  dev?: boolean;
  /** baseContext fields. */
  baseContext?: Record<string, unknown>;
}

export interface DevLoggerReport {
  logger: Logger;
  isDev: boolean;
  level: LogLevel;
  logFile?: string;
}

/**
 * Detect whether we're running in dev mode.
 *
 * Heuristic:
 *   - explicit DEV_MODE=1 or NAIA_DEV=1 → true
 *   - explicit NODE_ENV=production       → false
 *   - argv[1] ends with .ts (tsx)        → true
 *   - default                            → false
 */
export function isDevMode(): boolean {
  if (process.env["DEV_MODE"] === "1" || process.env["NAIA_DEV"] === "1") return true;
  if (process.env["NODE_ENV"] === "production") return false;
  const entry = process.argv[1] ?? "";
  if (entry.endsWith(".ts") || entry.endsWith(".tsx")) return true;
  return false;
}

/** Default log file path: ~/.naia-agent/logs/naia-agent-YYYYMMDD.jsonl */
function defaultLogFile(): string {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return join(homedir(), ".naia-agent", "logs", `naia-agent-${today}.jsonl`);
}

/**
 * Create the canonical project logger. Use this everywhere — bin, hosts,
 * tests, scripts — instead of constructing ConsoleLogger directly. Single
 * factory ensures consistent format + dev mode rules.
 */
export function createProjectLogger(opts: DevLoggerOptions = {}): DevLoggerReport {
  const dev = opts.dev ?? isDevMode();
  const envLevel = process.env["LOG_LEVEL"] as LogLevel | undefined;
  const level: LogLevel = opts.level ?? envLevel ?? (dev ? "debug" : "warn");

  const cfgOpts: ConsoleLoggerOptions = {
    level,
    baseContext: { ...(opts.baseContext ?? {}), pid: process.pid, ...(dev ? { dev: true } : {}) },
    redact: true,
  };

  let logFile: string | undefined;
  // dev mode: always write to file. Production: only if explicit logFile or LOG_FILE env.
  if (dev || opts.logFile || process.env["LOG_FILE"]) {
    logFile = opts.logFile ?? process.env["LOG_FILE"] ?? defaultLogFile();
    try {
      mkdirSync(join(logFile, ".."), { recursive: true });
      cfgOpts.secondaryStream = createWriteStream(logFile, { flags: "a" });
    } catch (e) {
      // Don't crash on log dir failure — fall back to stderr only.
      process.stderr.write(`[naia-agent] log file unavailable (${(e as Error).message}); stderr only\n`);
      logFile = undefined;
    }
  }

  return {
    logger: new ConsoleLogger(cfgOpts),
    isDev: dev,
    level,
    ...(logFile ? { logFile } : {}),
  };
}
