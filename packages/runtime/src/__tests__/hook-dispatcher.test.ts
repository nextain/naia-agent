import { describe, it, expect, vi } from "vitest";
import { HookDispatcher } from "@nextain/agent-core";
import type { HookRegistration, HookContext } from "@nextain/agent-core";

describe("HookDispatcher", () => {
  it("emits to registered handler", async () => {
    const dispatcher = new HookDispatcher();
    const calls: string[] = [];
    dispatcher.register({ source: "core", event: "turn-start", handler: () => { calls.push("start"); } });
    await dispatcher.emit("turn-start", { sessionId: "s1" });
    expect(calls).toEqual(["start"]);
  });

  it("does not emit to different event", async () => {
    const dispatcher = new HookDispatcher();
    const calls: string[] = [];
    dispatcher.register({ source: "core", event: "turn-start", handler: () => { calls.push("start"); } });
    await dispatcher.emit("turn-end", { sessionId: "s1" });
    expect(calls).toEqual([]);
  });

  it("runs handlers in priority order", async () => {
    const dispatcher = new HookDispatcher();
    const order: number[] = [];
    dispatcher.register({ source: "core", event: "turn-start", handler: () => { order.push(200); }, priority: 200 });
    dispatcher.register({ source: "adk", event: "turn-start", handler: () => { order.push(50); }, priority: 50 });
    dispatcher.register({ source: "host", event: "turn-start", handler: () => { order.push(100); }, priority: 100 });
    await dispatcher.emit("turn-start", { sessionId: "s1" });
    expect(order).toEqual([50, 100, 200]);
  });

  it("fire-and-forget: handler failure does not stop subsequent", async () => {
    const dispatcher = new HookDispatcher();
    const order: string[] = [];
    dispatcher.register({ source: "core", event: "turn-start", handler: () => { order.push("a"); throw new Error("boom"); } });
    dispatcher.register({ source: "core", event: "turn-start", handler: () => { order.push("b"); } });
    await dispatcher.emit("turn-start", { sessionId: "s1" });
    expect(order).toEqual(["a", "b"]);
  });

  it("supports async handlers sequentially", async () => {
    const dispatcher = new HookDispatcher();
    const order: string[] = [];
    dispatcher.register({
      source: "core", event: "turn-end", priority: 1,
      handler: async () => { order.push("a-start"); await new Promise((r) => setTimeout(r, 10)); order.push("a-end"); },
    });
    dispatcher.register({
      source: "core", event: "turn-end", priority: 2,
      handler: async () => { order.push("b-start"); order.push("b-end"); },
    });
    await dispatcher.emit("turn-end", { sessionId: "s1" });
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("provides full context to handler", async () => {
    const dispatcher = new HookDispatcher();
    let received: HookContext | undefined;
    dispatcher.register({
      source: "host", event: "tool-call",
      handler: (ctx) => { received = ctx; },
    });
    await dispatcher.emit("tool-call", { sessionId: "s1", data: { tool: "bash" } });
    expect(received!.event).toBe("tool-call");
    expect(received!.sessionId).toBe("s1");
    expect(received!.timestamp).toBeGreaterThan(0);
    expect((received!.data as { tool: string }).tool).toBe("bash");
  });

  it("handlersFor returns empty for unregistered event", () => {
    const dispatcher = new HookDispatcher();
    expect(dispatcher.handlersFor("error")).toEqual([]);
  });

  it("handlersFor returns registered handlers", () => {
    const dispatcher = new HookDispatcher();
    const h1 = () => {};
    const h2 = () => {};
    dispatcher.register({ source: "core", event: "turn-start", handler: h1 });
    dispatcher.register({ source: "adk", event: "turn-start", handler: h2, priority: 50 });
    const handlers = dispatcher.handlersFor("turn-start");
    expect(handlers).toHaveLength(2);
    expect(handlers[0]!.priority).toBe(50);
    expect(handlers[1]!.priority).toBeUndefined();
  });
});
