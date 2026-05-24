export type HookEvent =
  | "turn-start"
  | "turn-end"
  | "error"
  | "tool-call"
  | "tool-result";

export type HookSource = "core" | "host" | "adk";

export interface HookContext {
  event: HookEvent;
  sessionId: string;
  timestamp: number;
  data?: unknown;
}

export type HookHandler = (ctx: HookContext) => void | Promise<void>;

export interface HookRegistration {
  source: HookSource;
  event: HookEvent;
  handler: HookHandler;
  priority?: number;
}

export class HookDispatcher {
  readonly #hooks = new Map<HookEvent, HookRegistration[]>();

  register(reg: HookRegistration): void {
    const list = this.#hooks.get(reg.event) ?? [];
    list.push(reg);
    list.sort((a, b) => (a.priority ?? 1000) - (b.priority ?? 1000));
    this.#hooks.set(reg.event, list);
  }

  async emit(event: HookEvent, ctx: Omit<HookContext, "event" | "timestamp">): Promise<void> {
    const list = this.#hooks.get(event);
    if (!list || list.length === 0) return;
    const fullCtx: HookContext = { ...ctx, event, timestamp: Date.now() };
    for (const reg of list) {
      try {
        await reg.handler(fullCtx);
      } catch {
        // fire-and-forget: hook failure does not interrupt the turn
      }
    }
  }

  handlersFor(event: HookEvent): readonly HookRegistration[] {
    return this.#hooks.get(event) ?? [];
  }
}
