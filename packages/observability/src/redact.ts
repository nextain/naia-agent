// Slice 2.7 — secret redaction (Log Policy §5).
//
// Pattern-based redaction for log entries. Applied to string values
// recursively; numbers/booleans untouched.
//
// Patterns derived from common API key formats. NOT exhaustive — for
// production use cases, layer with secret-scanning tools (e.g. trufflehog).

const PATTERNS: Array<{ regex: RegExp; replacement: string; label: string }> = [
  {
    regex: /sk-ant-[A-Za-z0-9_\-]{20,}/g,
    replacement: "sk-ant-***",
    label: "Anthropic API key",
  },
  {
    regex: /sk-[A-Za-z0-9]{32,}/g,
    replacement: "sk-***",
    label: "OpenAI/generic API key",
  },
  {
    regex: /gw-[A-Za-z0-9_\-]{30,}/g,
    replacement: "gw-***",
    label: "Gateway key",
  },
  {
    regex: /AIzaSy[A-Za-z0-9_\-]{30,}/g,
    replacement: "AIzaSy***",
    label: "Google API key",
  },
  {
    regex: /Bearer\s+[A-Za-z0-9_\-.~+/=]{16,}/gi,
    replacement: "Bearer ***",
    label: "Bearer token",
  },
];

export function redactString(input: string): string {
  let out = input;
  for (const { regex, replacement } of PATTERNS) {
    out = out.replace(regex, replacement);
  }
  return out;
}

/**
 * Recursively redact all string values in an object. Object structure
 * preserved. Returns a new object — input is not mutated.
 */
export function redactObject<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return redactString(input) as unknown as T;
  if (typeof input !== "object") return input;
  if (Array.isArray(input)) {
    return input.map((v) => redactObject(v)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = redactObject(v);
  }
  return out as T;
}

/** List of pattern labels for diagnostic display. */
export function listRedactionPatterns(): string[] {
  return PATTERNS.map((p) => p.label);
}
