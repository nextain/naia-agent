// Test browser-agent — MessagePort 기반 Agent 통합 시험 (FE-05, FE-06, FE-10).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  startBrowserAgent,
  makePersonaSourceStore,
  makeWorkspaceContextStore,
  type WorkspaceDirent,
  type PersonaFsRead,
  type WorkspaceFsRead,
} from "../main/composition/browser-agent.js";
import type { ProviderPort, ProviderChatOpts } from "../main/ports/uc1.js";
import type { ProviderConfig, ChatMessage, ProviderChunk } from "../main/domain/chat.js";

function parseLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("browser-agent 통합 시험 (FE-05/FE-06)", () => {
  let port1: MessagePort;
  let port2: MessagePort;
  let lines: string[];
  let onMessage: (ev: MessageEvent) => void;

  beforeEach(() => {
    const channel = new MessageChannel();
    port1 = channel.port1;
    port2 = channel.port2;
    lines = [];

    onMessage = (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        lines.push(ev.data);
      }
    };

    port2.addEventListener("message", onMessage);
    port2.start();
  });

  afterEach(() => {
    port2.removeEventListener("message", onMessage);
    port1.close();
    port2.close();
  });

  async function waitFor(
    predicate: () => boolean,
    timeoutMs = 2000,
    desc = "condition",
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(
      `Timeout waiting for ${desc} within ${timeoutMs}ms. Received lines: ${JSON.stringify(lines)}`,
    );
  }

  it("정상 요청 처리, 깨진 JSON 뒤 복구, stop() 뒤 줄 차단", async () => {
    const agent = startBrowserAgent({
      port: port1,
      diag: { log: () => {}, debug: () => {} },
    });

    // 1. 정상 요청 b1
    port2.postMessage(JSON.stringify({
      type: "chat_request",
      requestId: "b1",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "hi" }],
    }));

    await waitFor(
      () => lines.some((l) => parseLine(l)?.requestId === "b1" && parseLine(l)?.type === "finish"),
      2000,
      "b1 finish",
    );

    const b1Msgs = lines.map(parseLine).filter((m) => m?.requestId === "b1");
    const b1Types = b1Msgs.map((m) => m?.type);
    const textIdx = b1Types.indexOf("text");
    const finishIdx = b1Types.indexOf("finish");
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(finishIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeLessThan(finishIdx);

    // 2. 깨진 JSON 줄 뒤 두 번째 요청 b2
    port2.postMessage('{"type":');
    port2.postMessage(JSON.stringify({
      type: "chat_request",
      requestId: "b2",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "hi again" }],
    }));

    await waitFor(
      () => lines.some((l) => parseLine(l)?.requestId === "b2" && parseLine(l)?.type === "finish"),
      2000,
      "b2 finish",
    );

    const b2Msgs = lines.map(parseLine).filter((m) => m?.requestId === "b2");
    const b2Types = b2Msgs.map((m) => m?.type);
    expect(b2Types).toContain("text");
    expect(b2Types).toContain("finish");
    expect(b2Types.indexOf("text")).toBeLessThan(b2Types.indexOf("finish"));

    // 3. stop() 뒤 b3 요청 -> 500ms 동안 어떤 줄도 오지 않음
    agent.stop();
    const countBeforeB3 = lines.length;

    port2.postMessage(JSON.stringify({
      type: "chat_request",
      requestId: "b3",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "after stop" }],
    }));

    await sleep(500);
    expect(lines.length).toBe(countBeforeB3);
  });

  it("진행 중 취소: cancel_stream 전송 시 종결 줄 도착 및 이후 줄 차단", async () => {
    // 시험이 쥔 약속: 시험은 이 약속을 일부러 풀지 않는다.
    const gatePromise = new Promise<void>(() => {});

    const controlledProvider: ProviderPort = {
      async *chat(
        _config: ProviderConfig,
        _messages: readonly ChatMessage[],
        opts: ProviderChatOpts,
      ): AsyncIterable<ProviderChunk> {
        if (opts.signal?.aborted) return;
        yield { kind: "text", text: "partial" };

        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
            return;
          }
          const onAbort = () => {
            opts.signal?.removeEventListener("abort", onAbort);
            resolve();
          };
          opts.signal?.addEventListener("abort", onAbort);
          gatePromise.then(() => {
            opts.signal?.removeEventListener("abort", onAbort);
            resolve();
          });
        });

        if (opts.signal?.aborted) return;
      },
    };

    const agent = startBrowserAgent({
      port: port1,
      diag: { log: () => {}, debug: () => {} },
      provider: controlledProvider,
    });

    port2.postMessage(JSON.stringify({
      type: "chat_request",
      requestId: "c1",
      provider: { provider: "controlled", model: "m" },
      messages: [{ role: "user", content: "start stream" }],
    }));

    // partial text 수신 확인
    await waitFor(
      () => lines.some((l) => {
        const m = parseLine(l);
        return m?.requestId === "c1" && m?.type === "text" && m?.text === "partial";
      }),
      2000,
      "c1 partial text",
    );

    // cancel_stream 전송
    port2.postMessage(JSON.stringify({
      type: "cancel_stream",
      requestId: "c1",
    }));

    // 2초 안에 종결 줄 도착 (finish 또는 error(message: "cancelled"))
    await waitFor(
      () => {
        const c1Msgs = lines.map(parseLine).filter((m) => m?.requestId === "c1");
        return c1Msgs.some(
          (m) => m?.type === "finish" || (m?.type === "error" && m?.message === "cancelled"),
        );
      },
      2000,
      "c1 terminal line",
    );

    const c1Lines = lines.filter((l) => parseLine(l)?.requestId === "c1");
    const c1Parsed = c1Lines.map(parseLine);
    const terminalLines = c1Parsed.filter(
      (m) => m?.type === "finish" || (m?.type === "error" && m?.message === "cancelled"),
    );
    expect(terminalLines.length).toBe(1);

    const unexpectedErrors = c1Parsed.filter(
      (m) => m?.type === "error" && m?.message !== "cancelled",
    );
    expect(unexpectedErrors).toEqual([]);

    // 종결 줄 뒤 300ms 동안 c1 줄 추가 수신 없음
    const countAtTerminal = c1Lines.length;
    await sleep(300);
    const countAfter300ms = lines.filter((l) => parseLine(l)?.requestId === "c1").length;
    expect(countAfter300ms).toBe(countAtTerminal);

    agent.stop();
  });

  it("진행 중 정지: partial 수신 후 stop() 시 late 텍스트 및 finish 모두 차단", async () => {
    let releaseGate: () => void = () => {};
    const gatePromise = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const controlledProvider: ProviderPort = {
      async *chat(
        _config: ProviderConfig,
        _messages: readonly ChatMessage[],
        opts: ProviderChatOpts,
      ): AsyncIterable<ProviderChunk> {
        if (opts.signal?.aborted) return;
        yield { kind: "text", text: "partial" };

        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
            return;
          }
          const onAbort = () => {
            opts.signal?.removeEventListener("abort", onAbort);
            resolve();
          };
          opts.signal?.addEventListener("abort", onAbort);
          gatePromise.then(() => {
            opts.signal?.removeEventListener("abort", onAbort);
            resolve();
          });
        });

        if (opts.signal?.aborted) return;
        yield { kind: "text", text: "late" };
        yield { kind: "finish" };
      },
    };

    const agent = startBrowserAgent({
      port: port1,
      diag: { log: () => {}, debug: () => {} },
      provider: controlledProvider,
    });

    port2.postMessage(JSON.stringify({
      type: "chat_request",
      requestId: "s1",
      provider: { provider: "controlled", model: "m" },
      messages: [{ role: "user", content: "start stream" }],
    }));

    await waitFor(
      () => lines.some((l) => {
        const m = parseLine(l);
        return m?.requestId === "s1" && m?.type === "text" && m?.text === "partial";
      }),
      2000,
      "s1 partial text",
    );

    const countBeforeStop = lines.length;
    agent.stop();

    // 시험이 약속을 풀어 late 및 finish 내보냄 유도
    releaseGate();

    await sleep(500);

    // 정지 뒤 500ms 동안 어떤 줄도 포트로 오지 않아야 함
    expect(lines.length).toBe(countBeforeStop);
    const s1LateOrFinish = lines.map(parseLine).filter(
      (m) => m?.text === "late" || (m?.requestId === "s1" && m?.type === "finish"),
    );
    expect(s1LateOrFinish).toEqual([]);
  });
});

describe("browser-agent 워크스페이스 포트 (FE-16)", () => {
  let port1: MessagePort;
  let port2: MessagePort;
  let lines: string[];
  let onMessage: (ev: MessageEvent) => void;

  beforeEach(() => {
    const channel = new MessageChannel();
    port1 = channel.port1;
    port2 = channel.port2;
    lines = [];

    onMessage = (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        lines.push(ev.data);
      }
    };

    port2.addEventListener("message", onMessage);
    port2.start();
  });

  afterEach(() => {
    port2.removeEventListener("message", onMessage);
    port1.close();
    port2.close();
  });

  async function waitFor(
    predicate: () => boolean,
    timeoutMs = 2000,
    desc = "condition",
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(
      `Timeout waiting for ${desc} within ${timeoutMs}ms. Received lines: ${JSON.stringify(lines)}`,
    );
  }

  interface FakeEntry {
    type: "file" | "dir";
    content?: string;
    entries?: readonly WorkspaceDirent[];
  }

  function createFakeFs(initialConfig?: string): {
    fs: PersonaFsRead & WorkspaceFsRead;
    updateConfig: (content: string) => void;
  } {
    const table: Record<string, FakeEntry> = {
      "/adk/naia-settings/config.json": {
        type: "file",
        content:
          initialConfig ??
          JSON.stringify({
            agentName: "루미",
            speechStyle: "casual",
            persona: "You are 루미, an AI companion. FE16-PERSONA-MARK",
          }),
      },
      "/adk/AGENTS.md": { type: "file", content: "# AGENTS\n" },
      "/adk/projects": {
        type: "dir",
        entries: [
          { name: "proj-a", isDirectory: () => true },
          { name: "note.txt", isDirectory: () => false },
          { name: ".git", isDirectory: () => true },
        ],
      },
      "/adk/projects/proj-a": { type: "dir" },
      "/adk/projects/note.txt": { type: "file", content: "" },
      "/adk/projects/.git": { type: "dir" },
    };

    const fs: PersonaFsRead & WorkspaceFsRead = {
      existsSync(p: string): boolean {
        return Object.prototype.hasOwnProperty.call(table, p);
      },
      readFileSync(p: string, _encoding: "utf8"): string {
        const entry = table[p];
        if (entry && entry.type === "file" && typeof entry.content === "string") {
          return entry.content;
        }
        throw new Error(`File not found: ${p}`);
      },
      readdirSync(p: string, _opts: { withFileTypes: true }): readonly WorkspaceDirent[] {
        const entry = table[p];
        if (entry && entry.type === "dir" && entry.entries) {
          return entry.entries;
        }
        return [];
      },
    };

    return {
      fs,
      updateConfig(content: string): void {
        table["/adk/naia-settings/config.json"] = {
          type: "file",
          content,
        };
      },
    };
  }

  function createRecordingProvider(recordedPrompts: (string | undefined)[]): ProviderPort {
    return {
      async *chat(
        _config: ProviderConfig,
        _messages: readonly ChatMessage[],
        opts: ProviderChatOpts,
      ): AsyncIterable<ProviderChunk> {
        recordedPrompts.push(opts.systemPrompt);
        yield { kind: "text", text: "ok" };
        yield { kind: "finish" };
      },
    };
  }

  it("두 포트를 넘기면 systemPrompt 에 페르소나와 워크스페이스가 들어간다", async () => {
    const { fs } = createFakeFs();
    const recordedPrompts: (string | undefined)[] = [];
    const provider = createRecordingProvider(recordedPrompts);

    const agent = startBrowserAgent({
      port: port1,
      provider,
      diag: { log: () => {}, debug: () => {} },
      personaSource: makePersonaSourceStore({ fs, adkPath: "/adk" }),
      workspaceContext: makeWorkspaceContextStore({ fs, adkPath: "/adk", cwd: "/adk" }),
    });

    port2.postMessage(JSON.stringify({
      type: "chat_request",
      requestId: "w1",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "hi" }],
    }));

    await waitFor(
      () => lines.some((l) => parseLine(l)?.requestId === "w1" && parseLine(l)?.type === "finish"),
      2000,
      "w1 finish",
    );

    expect(recordedPrompts.length).toBe(1);
    const sp = recordedPrompts[0];
    expect(sp).toBeDefined();
    expect(sp).toContain("FE16-PERSONA-MARK");
    expect(sp).toContain("루미");
    expect(sp).toContain("Workspace root: /adk");
    expect(sp).toContain("Entrypoint: AGENTS.md");
    expect(sp).toContain("Projects (1): proj-a");

    const personaMarkIdx = sp!.indexOf("FE16-PERSONA-MARK");
    const workspaceIdx = sp!.indexOf("## Workspace");
    expect(personaMarkIdx).toBeGreaterThanOrEqual(0);
    expect(workspaceIdx).toBeGreaterThanOrEqual(0);
    expect(personaMarkIdx).toBeLessThan(workspaceIdx);

    agent.stop();
  });

  it("페르소나를 바꾸면 다음 턴에 반영된다", async () => {
    const { fs, updateConfig } = createFakeFs();
    const recordedPrompts: (string | undefined)[] = [];
    const provider = createRecordingProvider(recordedPrompts);

    const agent = startBrowserAgent({
      port: port1,
      provider,
      diag: { log: () => {}, debug: () => {} },
      personaSource: makePersonaSourceStore({ fs, adkPath: "/adk" }),
      workspaceContext: makeWorkspaceContextStore({ fs, adkPath: "/adk", cwd: "/adk" }),
    });

    // 턴 1: 시험 1의 상태
    port2.postMessage(JSON.stringify({
      type: "chat_request",
      requestId: "w2-1",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "turn 1" }],
    }));

    await waitFor(
      () => lines.some((l) => parseLine(l)?.requestId === "w2-1" && parseLine(l)?.type === "finish"),
      2000,
      "w2-1 finish",
    );

    expect(recordedPrompts.length).toBe(1);
    expect(recordedPrompts[0]).toContain("FE16-PERSONA-MARK");

    // 가짜 fs 의 config.json 을 FE16-PERSONA-MARK-2 로 바꿈
    updateConfig(JSON.stringify({
      agentName: "루미",
      speechStyle: "casual",
      persona: "You are 루미, an AI companion. FE16-PERSONA-MARK-2",
    }));

    // 두 번째 chat_request (동일 agent 인스턴스, 다시 띄우지 않음)
    port2.postMessage(JSON.stringify({
      type: "chat_request",
      requestId: "w2-2",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "turn 2" }],
    }));

    await waitFor(
      () => lines.some((l) => parseLine(l)?.requestId === "w2-2" && parseLine(l)?.type === "finish"),
      2000,
      "w2-2 finish",
    );

    expect(recordedPrompts.length).toBe(2);
    expect(recordedPrompts[1]).toBeDefined();
    expect(recordedPrompts[1]).toContain("FE16-PERSONA-MARK-2");

    agent.stop();
  });

  it("포트가 없으면 systemPrompt 가 없다", async () => {
    const recordedPrompts: (string | undefined)[] = [];
    const provider = createRecordingProvider(recordedPrompts);

    const agent = startBrowserAgent({
      port: port1,
      provider,
      diag: { log: () => {}, debug: () => {} },
    });

    port2.postMessage(JSON.stringify({
      type: "chat_request",
      requestId: "w3",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "hi" }],
    }));

    await waitFor(
      () => lines.some((l) => parseLine(l)?.requestId === "w3" && parseLine(l)?.type === "finish"),
      2000,
      "w3 finish",
    );

    expect(recordedPrompts.length).toBe(1);
    expect(recordedPrompts[0]).toBeUndefined();

    agent.stop();
  });

  it("이름만 바꾸면 지금은 본문 이름이 바뀌지 않는다(현행 동작 고정)", async () => {
    const { fs } = createFakeFs(
      JSON.stringify({
        agentName: "루미",
        speechStyle: "casual",
        persona: "You are Naia, an AI companion. Speak casually and warmly.",
      }),
    );
    const recordedPrompts: (string | undefined)[] = [];
    const provider = createRecordingProvider(recordedPrompts);

    const agent = startBrowserAgent({
      port: port1,
      provider,
      diag: { log: () => {}, debug: () => {} },
      personaSource: makePersonaSourceStore({ fs, adkPath: "/adk" }),
      workspaceContext: makeWorkspaceContextStore({ fs, adkPath: "/adk", cwd: "/adk" }),
    });

    port2.postMessage(JSON.stringify({
      type: "chat_request",
      requestId: "w4",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "hi" }],
    }));

    await waitFor(
      () => lines.some((l) => parseLine(l)?.requestId === "w4" && parseLine(l)?.type === "finish"),
      2000,
      "w4 finish",
    );

    expect(recordedPrompts.length).toBe(1);
    const sp = recordedPrompts[0];
    expect(sp).toBeDefined();
    expect(sp).toContain("You are Naia, an AI companion.");
    expect(sp).not.toContain("루미");

    agent.stop();
  });
});
