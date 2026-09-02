// adapters/subagent-grok — SubAgentPort 의 grok 구현.
//
// `grok -p "<prompt>" --output-format streaming-messages-json --include-partial-messages`
// 를 sub-agent 로 spawn. 세션 머신은 subprocess-session, 여기엔 bin/args/parser 만.
// auth.json 미읽기. spawn env에서 XAI_API_KEY 제거(구독 OAuth).
import { execSync } from "node:child_process";
import { isAbsolute } from "node:path";
import type { TaskSpec, SubAgentEvent } from "../domain/orchestration.js";
import type { SubAgentPort, SubAgentSession } from "../ports/orchestration.js";
import {
  DEFAULT_HARD_KILL_DEADLINE_MS, defaultSpawn, spawnSubprocessSession, endedSession,
  type SpawnFn, type ResolvedBin, pickSpawnableBin, resolveSpawnableBin, resolveFallbackCommand,
} from "./subprocess-session.js";
import { createGrokNdjsonAcc, grokNdjsonLineToEvents, grokSubscriptionEnv } from "./grok-cli-provider.js";

export type { SpawnFn, ResolvedBin };

export interface SubAgentGrokOptions {
  readonly model?: string;
  readonly skipPermissions?: boolean;
  readonly hardKillDeadlineMs?: number;
  readonly resolveBin?: () => ResolvedBin;
  readonly spawnFn?: SpawnFn;
}

function validateGrokBin(raw: string | undefined): string | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const trimmed = raw.trim();
  if (trimmed.includes("\0")) throw new Error(`GROK_BIN contains null byte — refusing to spawn (injection guard)`);
  if (!isAbsolute(trimmed)) {
    throw new Error(`GROK_BIN must be an absolute path (got: ${trimmed.slice(0, 60)}) — set full path e.g. /usr/local/bin/grok`);
  }
  return trimmed;
}

function findGrokInPath(): string | null {
  const cmd = process.platform === "win32" ? `where grok` : `which grok`;
  try {
    const result = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return pickSpawnableBin(result.split(/\r?\n/));
  } catch {
    return null;
  }
}

export function resolveGrokBin(): ResolvedBin {
  const validated = validateGrokBin(process.env["GROK_BIN"]);
  if (validated) return { command: validated, prefixArgs: [] };
  const inPath = findGrokInPath();
  if (inPath) return resolveSpawnableBin(inPath);
  const fb = resolveFallbackCommand("npx");
  return { command: fb.command, prefixArgs: [...fb.prefixArgs, "--yes", "@xai-official/grok"] };
}

export function createGrokLineParser(): (line: string) => SubAgentEvent | null {
  const acc = createGrokNdjsonAcc();
  return (line: string): SubAgentEvent | null => {
    const events = grokNdjsonLineToEvents(line, acc);
    for (const event of events) {
      if (event.kind === "text") return { kind: "text_delta", text: event.text };
      if (event.kind === "thinking") return { kind: "planning", note: event.text };
      if (event.kind === "toolUse") return { kind: "tool_use_start", tool: event.name };
      if (event.kind === "error") return { kind: "session_end", ok: false, reason: event.message };
    }
    return null;
  };
}

export function makeGrokSubAgent(opts: SubAgentGrokOptions = {}): SubAgentPort {
  const hardKillMs = opts.hardKillDeadlineMs ?? DEFAULT_HARD_KILL_DEADLINE_MS;
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const resolveBin = opts.resolveBin ?? resolveGrokBin;
  return {
    spawn(task: TaskSpec): SubAgentSession {
      let bin: ResolvedBin;
      try {
        bin = resolveBin();
      } catch (e) {
        return endedSession(`grok unavailable: ${(e as Error).message}`);
      }
      const model = opts.model ?? task.model;
      const args: string[] = [
        "-p", task.prompt,
        "--output-format", "streaming-messages-json",
        "--include-partial-messages",
        "--cwd", task.workdir,
      ];
      if (model) args.push("-m", model);
      if (opts.skipPermissions) args.push("--always-approve");
      return spawnSubprocessSession({
        spawnFn,
        bin,
        args,
        cwd: task.workdir,
        env: grokSubscriptionEnv(),
        hardKillMs,
        lineToEvent: createGrokLineParser(),
        label: "grok",
      });
    },
  };
}
