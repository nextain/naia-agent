import {
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

export type DiscordNativeStatusState = "starting" | "standby" | "ready" | "failed" | "stopped";

export function makeDiscordStatusFile(input: {
  readonly path: string;
  readonly generation: string;
}): {
  write(
    state: DiscordNativeStatusState,
    code?: string,
    partialReply?: { readonly confirmedChunk: number },
  ): void;
} {
  if (!isAbsolute(input.path) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.generation)) {
    throw new Error("DISCORD_STATUS_CONFIG_INVALID");
  }
  return {
    write(state, code, partialReply) {
      if (!["starting", "standby", "ready", "failed", "stopped"].includes(state)
        || (code !== undefined && !/^[a-z0-9_]{1,64}$/.test(code))
        || (partialReply !== undefined
          && (!Number.isSafeInteger(partialReply.confirmedChunk)
            || partialReply.confirmedChunk < 0 || partialReply.confirmedChunk > 6))) {
        throw new Error("DISCORD_STATUS_VALUE_INVALID");
      }
      const temp = `${input.path}.tmp`;
      mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 });
      try {
        writeFileSync(temp, JSON.stringify({
          version: 1,
          generation: input.generation,
          state,
          ...(code ? { code } : {}),
          ...(partialReply ? { partialReply } : {}),
        }), { encoding: "utf8", mode: 0o600 });
        renameSync(temp, input.path);
      } catch (error) {
        try { rmSync(temp, { force: true }); } catch { /* best effort */ }
        throw error;
      }
    },
  };
}
