// packages/runtime/src/utils/login-ops.ts
// Pure helper functions for the `naia-agent login` subcommand.
//
// All functions are side-effect-free (no I/O, no filesystem, no process.env).
// Injectable for unit testing — bin/naia-agent.ts owns I/O and TTY interaction.
//
// Extracted to enable unit testing of:
//   - S1-L2: duplicate key detection without TTY (Track B)
//   - buildEnvAppend: file content generation
//
// S1-L1 (empty value check) remains in bin (TTY-gated promptLine flow).

export interface ProviderField {
  envKey: string;
  label: string;
}

/**
 * Parse `--key <provider>` from argv slice (login subcommand args only).
 * Returns { provider } or { error } — never both.
 */
export function parseLoginArgs(argv: string[]): { provider: string } | { error: string } {
  let provider: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--key") {
      provider = argv[++i];
    }
  }
  if (!provider) return { error: "missing --key <provider>" };
  return { provider };
}

/**
 * Given a set of existing env keys and a map of new key→value pairs,
 * separate entries into those to add vs. those already present.
 *
 * @param existingKeys  Keys already in the .env file (from parseEnv()).
 * @param values        Key→value map from interactive prompts.
 */
export function checkDuplicateKeys(
  existingKeys: ReadonlySet<string>,
  values: Record<string, string>,
): { toAdd: ReadonlyArray<readonly [string, string]>; alreadySet: readonly string[] } {
  const toAdd: Array<readonly [string, string]> = [];
  const alreadySet: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (existingKeys.has(k)) {
      alreadySet.push(k);
    } else {
      toAdd.push([k, v]);
    }
  }
  return { toAdd, alreadySet };
}

/**
 * Build the updated .env file content by appending new key=value lines.
 * Preserves existing content exactly; handles trailing-newline edge case.
 *
 * Throws if any key or value contains a newline or carriage-return character
 * (CWE-93: newline injection guard). Keys must not contain `=`.
 * Note: promptLine() already trims input, so TTY paths are safe; this guard
 * protects against misuse when called programmatically.
 *
 * @param existing  Current file content (empty string if file does not exist).
 * @param toAdd     Key→value pairs to append (from checkDuplicateKeys).
 * @returns         Full updated file content to write.
 */
export function buildEnvAppend(existing: string, toAdd: ReadonlyArray<readonly [string, string]>): string {
  if (toAdd.length === 0) return existing;
  for (const [k, v] of toAdd) {
    if (/[\n\r=]/.test(k)) throw new Error(`invalid env key (contains newline or '='): ${JSON.stringify(k)}`);
    if (/[\n\r]/.test(v)) throw new Error(`env value for key ${JSON.stringify(k)} contains newline — strip before writing`);
  }
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  return existing + sep + toAdd.map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}
