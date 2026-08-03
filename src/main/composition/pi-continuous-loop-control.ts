import { randomUUID } from "node:crypto";
import type { PiContinuousLoopConfig } from "./pi-continuous-loop.js";

interface ControlLoop {
  readonly profile: unknown;
  readonly sessions: {
    submit(input: unknown): Promise<{ sessionId: string }>;
    answer(sessionId: string, questionId: string, text: string): Promise<unknown>;
    cancel(sessionId: string): Promise<unknown>;
    get(sessionId: string): unknown;
    portfolio(): unknown;
    pump(): Promise<void>;
  };
  readonly budget: {
    snapshot(): unknown;
    reservations(): unknown;
  };
}

export interface PiLoopControlResponse {
  readonly id: unknown;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

/** Run one foreground, line-delimited control session over one durable loop instance. */
export async function runPiLoopControlSession(
  loop: ControlLoop,
  config: Pick<PiContinuousLoopConfig, "profileId" | "facing" | "moderator">,
  lines: AsyncIterable<string>,
  emit: (response: PiLoopControlResponse) => void,
): Promise<void> {
  let activePump: Promise<void> | undefined;
  let pumpFailure: string | undefined;
  let pumpRequested = false;
  const schedulePump = () => {
    pumpRequested = true;
    if (activePump) return;
    const tracked = (async () => {
      while (pumpRequested) {
        pumpRequested = false;
        try { await loop.sessions.pump(); }
        catch (error) { pumpFailure = error instanceof Error ? error.message : String(error); }
      }
    })().finally(() => { if (activePump === tracked) activePump = undefined; });
    activePump = tracked;
  };
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("control message must be an object");
      message = parsed as Record<string, unknown>;
      const result = await dispatch(loop, config, message, schedulePump, () => activePump);
      const backgroundError = pumpFailure; pumpFailure = undefined;
      emit(backgroundError
        ? { id: message.id ?? null, ok: false, error: `background pump failed: ${backgroundError}`, result }
        : { id: message.id ?? null, ok: true, result });
    } catch (error) {
      emit({ id: message?.id ?? null, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (activePump) await activePump;
  if (pumpFailure) emit({ id: null, ok: false, error: `background pump failed: ${pumpFailure}` });
}

async function dispatch(loop: ControlLoop,
  config: Pick<PiContinuousLoopConfig, "profileId" | "facing" | "moderator">,
  message: Record<string, unknown>, schedulePump: () => void,
  getActivePump: () => Promise<void> | undefined): Promise<unknown> {
  const command = requiredString(message, "command");
  if (command === "start") {
    const source = requiredObject(message, "request");
    const requestId = optionalString(source, "requestId") ?? randomUUID();
    const session = await loop.sessions.submit({ request: { requestId, text: requiredString(source, "text"),
      requiredObligations: requiredStrings(source, "requiredObligations"), workspacePath: requiredString(source, "workspacePath"),
      naiaBinding: config.facing, moderatorBinding: config.moderator,
      workerProfiles: { [config.profileId]: loop.profile } }, source: { kind: "local",
      sourceId: optionalString(source, "sourceId") ?? requestId, actorId: optionalString(source, "actorId") ?? "local-user" } });
    schedulePump(); return session;
  }
  if (command === "list") return loop.sessions.portfolio();
  if (command === "show") return loop.sessions.get(requiredString(message, "session"));
  if (command === "answer") {
    const session = await loop.sessions.answer(requiredString(message, "session"), requiredString(message, "question"),
      requiredString(message, "text")); schedulePump(); return session;
  }
  if (command === "cancel") {
    const session = await loop.sessions.cancel(requiredString(message, "session")); schedulePump(); return session;
  }
  if (command === "pump") { schedulePump(); await getActivePump(); return loop.sessions.portfolio(); }
  if (command === "budget") return loop.budget.snapshot();
  if (command === "reservations") return loop.budget.reservations();
  throw new Error(`unknown serve command: ${command}`);
}

function requiredObject(value: Record<string, unknown>, name: string): Record<string, unknown> {
  const found = value[name];
  if (!found || typeof found !== "object" || Array.isArray(found)) throw new Error(`${name} must be an object`);
  return found as Record<string, unknown>;
}
function requiredString(value: Record<string, unknown>, name: string): string {
  const found = value[name];
  if (typeof found !== "string" || found.length === 0 || found !== found.trim()) throw new Error(`${name} is required`);
  return found;
}
function optionalString(value: Record<string, unknown>, name: string): string | undefined {
  return value[name] === undefined ? undefined : requiredString(value, name);
}
function requiredStrings(value: Record<string, unknown>, name: string): readonly string[] {
  const found = value[name];
  if (!Array.isArray(found) || !found.every((item) => typeof item === "string" && item.length > 0 && item === item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return found;
}
