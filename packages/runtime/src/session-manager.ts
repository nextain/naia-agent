import type { Session, SessionState } from "@nextain/agent-types";
import {
  ALLOWED_TRANSITIONS,
  isTerminalSessionState,
} from "@nextain/agent-types";

export interface SessionRecord extends Session {
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastUserText: string;
}

export interface SessionManagerOptions {
  maxSessions?: number;
}

export class SessionManager {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #maxSessions: number;
  #activeId: string | undefined;

  constructor(opts: SessionManagerOptions = {}) {
    this.#maxSessions = opts.maxSessions ?? 100;
  }

  create(title?: string): SessionRecord {
    let id: string;
    try {
      id = `sess-${crypto.randomUUID()}`;
    } catch {
      id = `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }
    const now = Date.now();
    const record: SessionRecord = {
      id,
      state: "created",
      createdAt: now,
      updatedAt: now,
      ...(title !== undefined ? { title } : {}),
      turnCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      lastUserText: "",
    };
    if (this.#sessions.size >= this.#maxSessions) {
      const oldest = this.#oldestInactive();
      if (oldest) this.#sessions.delete(oldest);
    }
    this.#sessions.set(id, record);
    return { ...record };
  }

  get(id: string): SessionRecord | undefined {
    const r = this.#sessions.get(id);
    return r ? { ...r } : undefined;
  }

  list(): SessionRecord[] {
    return Array.from(this.#sessions.values()).map((r) => ({ ...r }));
  }

  active(): SessionRecord | undefined {
    if (!this.#activeId) return undefined;
    return this.get(this.#activeId);
  }

  activeId(): string | undefined {
    return this.#activeId;
  }

  activate(id: string): SessionRecord {
    const r = this.#require(id);
    if (isTerminalSessionState(r.state)) {
      throw new Error(`Session "${id}" is in terminal state "${r.state}"`);
    }
    if (r.state === "paused") {
      this.#transition(r, "resumed");
      this.#transition(r, "active");
    } else if (r.state !== "active") {
      this.#transition(r, "active");
    }
    this.#activeId = id;
    return { ...r };
  }

  pause(id: string): SessionRecord {
    const r = this.#require(id);
    this.#transition(r, "paused");
    if (this.#activeId === id) this.#activeId = undefined;
    return { ...r };
  }

  close(id: string): SessionRecord {
    const r = this.#require(id);
    this.#transition(r, "closed");
    if (this.#activeId === id) this.#activeId = undefined;
    return { ...r };
  }

  delete(id: string): boolean {
    if (this.#activeId === id) this.#activeId = undefined;
    return this.#sessions.delete(id);
  }

  updateStats(
    id: string,
    delta: { turns?: number; inputTokens?: number; outputTokens?: number; lastUserText?: string },
  ): SessionRecord | undefined {
    const r = this.#sessions.get(id);
    if (!r) return undefined;
    if (delta.turns !== undefined) r.turnCount += delta.turns;
    if (delta.inputTokens !== undefined) r.totalInputTokens += delta.inputTokens;
    if (delta.outputTokens !== undefined) r.totalOutputTokens += delta.outputTokens;
    if (delta.lastUserText !== undefined) r.lastUserText = delta.lastUserText;
    r.updatedAt = Date.now();
    return { ...r };
  }

  #require(id: string): SessionRecord {
    const r = this.#sessions.get(id);
    if (!r) throw new Error(`Session "${id}" not found`);
    return r;
  }

  #transition(r: SessionRecord, to: SessionState): void {
    const allowed = ALLOWED_TRANSITIONS[r.state];
    if (!allowed.includes(to)) {
      throw new Error(`Invalid transition: ${r.state} → ${to} (session ${r.id})`);
    }
    r.state = to;
    r.updatedAt = Date.now();
  }

  #oldestInactive(): string | undefined {
    let oldestId: string | undefined;
    let oldestTime = Infinity;
    for (const [id, r] of this.#sessions) {
      if (id === this.#activeId) continue;
      if (r.updatedAt < oldestTime) {
        oldestTime = r.updatedAt;
        oldestId = id;
      }
    }
    return oldestId;
  }
}
