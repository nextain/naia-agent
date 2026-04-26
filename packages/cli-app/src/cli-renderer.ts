import type { NaiaStreamChunk } from "@nextain/agent-types";

export interface CliOptions {
  prompt: string;
  workdir: string;
  noVerify?: boolean;
  /** Print every chunk type for debug. */
  debug?: boolean;
}

/**
 * Render NaiaStreamChunk to CLI-friendly text.
 *
 * Phase 1 spec target output (r4-phase-1-spec.md §1):
 *   [알파] task 시작: <prompt>
 *   [opencode 0001] spawning ...
 *   [opencode 0001] phase: planning
 *   [opencode 0001] phase: editing
 *     ✚ src/utils/hello.ts (+5)
 *   [verify] running pnpm test ...
 *   [verify] test 24/24 PASS (3.2s)
 *   [알파] 완료
 *           files: 1 (+5/-0)
 *           tests: 24/24 PASS
 *           elapsed: 12.4s
 */
export function renderChunk(chunk: NaiaStreamChunk): string | null {
  switch (chunk.type) {
    case "session_start":
      return `[${chunk.adapterId} ${shortId(chunk.sessionId)}] start: ${chunk.taskSummary}`;
    case "session_progress":
      return `[${shortId(chunk.sessionId)}] phase: ${chunk.phase}${chunk.note ? ` (${chunk.note})` : ""}`;
    case "text_delta": {
      const text = chunk.text.replace(/\n+$/, "");
      return text.length > 0 ? `  ${text}` : null;
    }
    case "thinking_delta":
      return null; // Phase 1: hide thinking
    case "tool_use_start":
      return `  → tool: ${chunk.tool}`;
    case "tool_use_end":
      return `  ✓ tool: ${chunk.tool} (${chunk.elapsedMs}ms, ok=${chunk.ok})`;
    case "workspace_change": {
      const sym =
        chunk.kind === "add" ? "✚" : chunk.kind === "delete" ? "✘" : "✎";
      const base = `  ${sym} ${chunk.path}`;
      if (chunk.diff && chunk.diff.length > 0) {
        return `${base}\n${indentBlock(chunk.diff, 4)}`;
      }
      return base;
    }
    case "session_end":
      return `[${shortId(chunk.sessionId)}] end: ${chunk.reason}`;
    case "session_aggregated":
      return null; // structural only
    case "verification_start":
      return `[verify] running ${chunk.command} ...`;
    case "verification_result": {
      const verdict = chunk.pass ? "PASS" : "FAIL";
      const stats = chunk.stats;
      const detail =
        chunk.runner === "test" && stats.passed !== undefined
          ? ` ${stats.passed}/${stats.total ?? stats.passed} ${verdict}`
          : ` ${verdict}`;
      return `[verify] ${chunk.runner}${detail} (${(chunk.durationMs / 1000).toFixed(1)}s)${chunk.pass ? "" : ""}`;
    }
    case "report":
      return `[알파] 완료\n${indentBlock(chunk.summary, 8)}`;
    case "interrupt":
      return `[!!] interrupt: ${chunk.reason} (mode=${chunk.mode})`;
    case "audio_delta":
    case "image_delta":
    case "input_json_delta":
    case "review_request":
    case "review_finding":
    case "end":
      return null;
    default: {
      // Exhaustiveness — surface unknown variant in debug
      const _exhaustive: never = chunk;
      void _exhaustive;
      return null;
    }
  }
}

function shortId(id: string): string {
  return id.slice(-6);
}

function indentBlock(s: string, indent: number): string {
  const pad = " ".repeat(indent);
  return s
    .split("\n")
    .map((l) => (l.length > 0 ? pad + l : l))
    .join("\n");
}

/**
 * Run CLI: stream Phase1Supervisor and print rendered chunks to stdout.
 * Returns final exit code.
 */
export async function runCli(
  stream: AsyncIterable<NaiaStreamChunk>,
  opts: CliOptions,
): Promise<number> {
  process.stdout.write(`[알파] task 시작: ${opts.prompt}\n`);
  let hadError = false;
  let verificationFailed = false;
  for await (const chunk of stream) {
    if (chunk.type === "verification_result" && !chunk.pass) {
      verificationFailed = true;
    }
    if (chunk.type === "session_end" && chunk.reason === "failed") {
      hadError = true;
    }
    if (opts.debug) {
      process.stdout.write(`[debug] ${chunk.type}\n`);
    }
    const line = renderChunk(chunk);
    if (line !== null) process.stdout.write(line + "\n");
  }
  if (hadError) return 2;
  if (verificationFailed) return 1;
  return 0;
}
