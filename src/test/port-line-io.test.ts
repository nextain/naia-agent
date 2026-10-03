// Test port-line-io — WHATWG HTML MessagePort start() 규약 및 LineIO 계약 검증 (FE-06).
import { describe, it, expect } from "vitest";
import { makePortLineIO, type LinePortLike } from "../main/adapters/port-line-io.js";
import { startBrowserAgent } from "../main/composition/browser-agent.js";

class FakeBrowserPort implements LinePortLike {
  public calls: string[] = [];
  public postedMessages: string[] = [];
  private listeners: ((ev: { data: unknown }) => void)[] = [];
  private queue: unknown[] = [];
  public isStarted = false;

  postMessage(data: string): void {
    this.calls.push("postMessage");
    this.postedMessages.push(data);
  }

  addEventListener(_type: "message", cb: (ev: { data: unknown }) => void): void {
    this.calls.push("addEventListener");
    this.listeners.push(cb);
  }

  removeEventListener(_type: "message", cb: (ev: { data: unknown }) => void): void {
    this.calls.push("removeEventListener");
    const idx = this.listeners.indexOf(cb);
    if (idx >= 0) {
      this.listeners.splice(idx, 1);
    }
  }

  start(): void {
    this.calls.push("start");
    this.isStarted = true;
    while (this.queue.length > 0) {
      const data = this.queue.shift();
      for (const listener of [...this.listeners]) {
        listener({ data });
      }
    }
  }

  emit(data: unknown): void {
    if (!this.isStarted) {
      this.queue.push(data);
    } else {
      for (const listener of [...this.listeners]) {
        listener({ data });
      }
    }
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

describe("MessagePort LineIO 어댑터 (FE-06)", () => {
  it("onLine 등록 시 addEventListener 가 start 보다 먼저 불리고, start 는 정확히 1회 호출되며 큐잉된 줄이 전달된다", () => {
    const port = new FakeBrowserPort();
    port.emit("pre-queued line");

    const io = makePortLineIO(port);
    const received: string[] = [];

    io.onLine((line) => received.push(line));

    const addIdx = port.calls.indexOf("addEventListener");
    const startIdx = port.calls.indexOf("start");
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeLessThan(startIdx);

    const startCount = port.calls.filter((c) => c === "start").length;
    expect(startCount).toBe(1);
    expect(received).toEqual(["pre-queued line"]);

    // 두 번째 onLine 호출 시 start() 가 중복 호출되지 않음
    io.onLine(() => {});
    const startCountAfterSecond = port.calls.filter((c) => c === "start").length;
    expect(startCountAfterSecond).toBe(1);
  });

  it("문자열이 아닌 메시지는 cb 로 전달되지 않고 무시된다", () => {
    const port = new FakeBrowserPort();
    const io = makePortLineIO(port);
    const received: string[] = [];

    io.onLine((line) => received.push(line));

    port.emit({ a: 1 });
    port.emit(12345);
    port.emit(null);
    port.emit(undefined);
    port.emit([1, 2, 3]);
    port.emit("valid line");

    expect(received).toEqual(["valid line"]);
  });

  it("onLine 이 반환한 해제 함수를 부르면 리스너가 제거되고 이후 줄이 오지 않는다", () => {
    const port = new FakeBrowserPort();
    const io = makePortLineIO(port);
    const received: string[] = [];

    const unsub = io.onLine((line) => received.push(line));
    port.emit("line 1");
    expect(received).toEqual(["line 1"]);

    unsub();
    expect(port.calls).toContain("removeEventListener");

    port.emit("line 2");
    expect(received).toEqual(["line 1"]);
  });

  it("가짜 포트로 startBrowserAgent 를 붙이면 start() 가 호출되고 chat_request 에 대해 finish 줄이 나간다", async () => {
    const port = new FakeBrowserPort();
    const agent = startBrowserAgent({
      port,
      diag: { log: () => {}, debug: () => {} },
    });

    expect(port.isStarted).toBe(true);

    const req = JSON.stringify({
      type: "chat_request",
      requestId: "p1",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "hi" }],
    });
    port.emit(req);

    await waitFor(() => port.postedMessages.some((m) => {
      try {
        return (JSON.parse(m) as { type?: string }).type === "finish";
      } catch {
        return false;
      }
    }));

    const parsed = port.postedMessages.map((m) => JSON.parse(m) as Record<string, unknown>);
    const finishMsg = parsed.find((m) => m["type"] === "finish");
    expect(finishMsg).toBeDefined();
    expect(finishMsg?.["requestId"]).toBe("p1");

    agent.stop();
  });
});
