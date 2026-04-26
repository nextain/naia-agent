/**
 * Parse opencode `run --format json` NDJSON event stream.
 *
 * Spec discovered 2026-04-26 spike (opencode-ai@1.14.25). May evolve;
 * this module isolates the parsing so adapter logic stays stable across
 * opencode versions.
 */

export type OpencodeEventType =
  | "step_start"
  | "text"
  | "tool_use"
  | "step_finish"
  | "unknown";

export interface OpencodeEvent {
  readonly type: OpencodeEventType;
  readonly raw: unknown;
  readonly sessionID?: string;
  readonly timestamp?: number;
  readonly text?: string;
  readonly tool?: {
    readonly name: string;
    readonly callId: string;
    readonly status: "running" | "completed" | "failed" | string;
    readonly input?: unknown;
    readonly output?: unknown;
  };
  readonly stepFinishReason?: string;
  readonly tokens?: {
    readonly total?: number;
    readonly input?: number;
    readonly output?: number;
    readonly reasoning?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
  };
}

interface RawEvent {
  type?: string;
  timestamp?: number;
  sessionID?: string;
  part?: Record<string, unknown>;
}

interface RawToolPart {
  type?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
  };
}

interface RawTextPart {
  type?: string;
  text?: string;
}

interface RawStepFinishPart {
  type?: string;
  reason?: string;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

/** Returns null if line is not valid JSON. Returns parsed event otherwise. */
export function parseOpencodeEvent(line: string): OpencodeEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: RawEvent;
  try {
    raw = JSON.parse(trimmed) as RawEvent;
  } catch {
    return null;
  }

  const sessionID =
    typeof raw.sessionID === "string" ? raw.sessionID : undefined;
  const timestamp =
    typeof raw.timestamp === "number" ? raw.timestamp : undefined;

  const event: OpencodeEvent = {
    type: classifyEventType(raw.type),
    raw,
    ...(sessionID !== undefined && { sessionID }),
    ...(timestamp !== undefined && { timestamp }),
  };

  switch (raw.type) {
    case "text": {
      const part = raw.part as RawTextPart | undefined;
      const text = typeof part?.text === "string" ? part.text : "";
      return { ...event, text };
    }
    case "tool_use": {
      const part = raw.part as RawToolPart | undefined;
      const tool = part?.tool ?? "unknown";
      const callId = part?.callID ?? "";
      const status: NonNullable<OpencodeEvent["tool"]>["status"] =
        part?.state?.status ?? "running";
      return {
        ...event,
        tool: {
          name: tool,
          callId,
          status,
          ...(part?.state?.input !== undefined && { input: part.state.input }),
          ...(part?.state?.output !== undefined && { output: part.state.output }),
        },
      };
    }
    case "step_finish": {
      const part = raw.part as RawStepFinishPart | undefined;
      const reason = part?.reason;
      const t = part?.tokens;
      const tokens = t
        ? {
            ...(t.total !== undefined && { total: t.total }),
            ...(t.input !== undefined && { input: t.input }),
            ...(t.output !== undefined && { output: t.output }),
            ...(t.reasoning !== undefined && { reasoning: t.reasoning }),
            ...(t.cache?.read !== undefined && { cacheRead: t.cache.read }),
            ...(t.cache?.write !== undefined && { cacheWrite: t.cache.write }),
          }
        : undefined;
      return {
        ...event,
        ...(reason !== undefined && { stepFinishReason: reason }),
        ...(tokens !== undefined && { tokens }),
      };
    }
    case "step_start":
    default:
      return event;
  }
}

function classifyEventType(t: string | undefined): OpencodeEventType {
  switch (t) {
    case "step_start":
    case "text":
    case "tool_use":
    case "step_finish":
      return t;
    default:
      return "unknown";
  }
}
