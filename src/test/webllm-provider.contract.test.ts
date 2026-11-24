/**
 * src/test/webllm-provider.contract.test.ts
 * WebLLM 공급자 어댑터 계약 및 동작 검증 시험 (FE-08, FE-10).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  makeWebLLMProvider,
  type WebLLMEngineLike,
  type WebLLMChatRequest,
  type WebLLMChatChunk,
} from "../main/adapters/webllm-provider.js";
import { resolveProviderRoute } from "../main/domain/provider-route.js";
import { makeProviderResolver } from "../main/adapters/provider-resolver.js";
import { startBrowserAgent, BROWSER_READ_TOOL_NAMES } from "../main/composition/browser-agent.js";
import type { ProviderConfig, ChatMessage, ProviderChunk } from "../main/domain/chat.js";

interface FakeStreamRecord {
  id: number;
  finishReason?: "stop" | "abort" | "error";
  reachedDone: boolean;
  returnedCount: number;
  streamStarted: boolean;
  emittedChunks: WebLLMChatChunk[];
  createEntered: Promise<void>;
  bodyStarted: Promise<void>;
  reachedDonePromise: Promise<void>;
}

class FakeLock {
  private tail: Promise<void> = Promise.resolve();
  private locked = false;

  isLocked(): boolean {
    return this.locked;
  }

  async acquire(): Promise<() => void> {
    let releaseLock!: () => void;
    const nextP = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const prev = this.tail;
    this.tail = nextP;
    await prev;
    this.locked = true;
    return () => {
      this.locked = false;
      releaseLock();
    };
  }
}

class FakeWebLLMEngine implements WebLLMEngineLike {
  public lock = new FakeLock();
  public requests: WebLLMChatRequest[] = [];
  public createCalls = 0;
  public interruptCalls: Array<{ streamId?: number; streamStarted?: boolean }> = [];
  public streams: FakeStreamRecord[] = [];
  public totalReturnCalls = 0;
  public totalThrowCalls = 0;

  public activeStreamId?: number;
  public interruptSignal = false;

  public createGate?: Promise<void>;
  public beforeFirstChunkGate?: Promise<void>;
  public betweenChunksGate?: Promise<void>;
  public chunksToSend: Array<{
    content?: string;
    finish_reason?: string | null;
    usage?: { prompt_tokens: number; completion_tokens: number };
  }> = [
    { content: "가" },
    { content: "나" },
    { content: "다" },
    { usage: { prompt_tokens: 3, completion_tokens: 5 } },
  ];
  public shouldThrowErrorOnNext = false;
  public errorToThrow = new Error("fake stream error");

  public createEntered!: Promise<void>;
  private resolveCreateEntered!: () => void;

  public bodyStarted!: Promise<void>;
  private resolveBodyStarted!: () => void;

  public reachedDone!: Promise<void>;
  private resolveReachedDone!: () => void;

  constructor() {
    this.initStreamPromises();
  }

  public initStreamPromises(): void {
    this.createEntered = new Promise<void>((resolve) => {
      this.resolveCreateEntered = resolve;
    });
    this.bodyStarted = new Promise<void>((resolve) => {
      this.resolveBodyStarted = resolve;
    });
    this.reachedDone = new Promise<void>((resolve) => {
      this.resolveReachedDone = resolve;
    });
  }

  async interruptGenerate(): Promise<void> {
    const activeStream = this.streams.find((s) => s.id === this.activeStreamId);
    this.interruptCalls.push({
      streamId: this.activeStreamId,
      streamStarted: activeStream?.streamStarted,
    });
    this.interruptSignal = true;
  }

  chat = {
    completions: {
      create: async (req: WebLLMChatRequest): Promise<AsyncIterable<WebLLMChatChunk>> => {
        this.createCalls++;
        this.requests.push(req);

        if (this.createCalls > 1) {
          this.initStreamPromises();
        }
        this.resolveCreateEntered();

        if (this.createGate) {
          await this.createGate;
        }

        const unlock = await this.lock.acquire();
        const streamId = this.streams.length + 1;
        const currentResolveBodyStarted = this.resolveBodyStarted;
        const currentResolveReachedDone = this.resolveReachedDone;

        const record: FakeStreamRecord = {
          id: streamId,
          reachedDone: false,
          returnedCount: 0,
          streamStarted: false,
          emittedChunks: [],
          createEntered: this.createEntered,
          bodyStarted: this.bodyStarted,
          reachedDonePromise: this.reachedDone,
        };
        this.streams.push(record);
        this.activeStreamId = streamId;

        const engine = this;

        async function* streamGenerator(): AsyncGenerator<WebLLMChatChunk, void, unknown> {
          record.streamStarted = true;
          engine.interruptSignal = false;
          currentResolveBodyStarted();

          if (engine.beforeFirstChunkGate) {
            await engine.beforeFirstChunkGate;
          }

          let threw = false;
          try {
            for (let i = 0; i < engine.chunksToSend.length; i++) {
              if (engine.shouldThrowErrorOnNext && i === 1) {
                threw = true;
                unlock();
                record.finishReason = "error";
                throw engine.errorToThrow;
              }

              const item = engine.chunksToSend[i];
              const chunk: WebLLMChatChunk = {
                choices: item.content !== undefined
                  ? [{ delta: { content: item.content }, finish_reason: item.finish_reason ?? null }]
                  : [],
                ...(item.usage ? { usage: item.usage } : {}),
              };

              record.emittedChunks.push(chunk);
              yield chunk;

              if (i === 0 && engine.betweenChunksGate) {
                await engine.betweenChunksGate;
              }

              if (engine.interruptSignal) {
                record.finishReason = "abort";
                const abortChunk: WebLLMChatChunk = {
                  choices: [{ delta: { content: null }, finish_reason: "abort" }],
                };
                record.emittedChunks.push(abortChunk);
                yield abortChunk;

                const usageChunk: WebLLMChatChunk = {
                  choices: [],
                  usage: { prompt_tokens: 1, completion_tokens: 1 },
                };
                record.emittedChunks.push(usageChunk);
                yield usageChunk;
                break;
              }
            }

            if (!record.finishReason && !threw) {
              record.finishReason = "stop";
            }
          } finally {
            // 엔진 잠금은 생성기 끝 또는 throw 경로에서만 풀림
          }

          if (!threw) {
            unlock();
            record.reachedDone = true;
            if (engine.activeStreamId === streamId) {
              engine.activeStreamId = undefined;
            }
            currentResolveReachedDone();
          }
        }

        const gen = streamGenerator();
        const originalReturn = gen.return?.bind(gen);
        const originalThrow = gen.throw?.bind(gen);
        const streamIt: AsyncIterableIterator<WebLLMChatChunk> = {
          [Symbol.asyncIterator]() {
            return this;
          },
          next: () => gen.next(),
          return: (val?: void | PromiseLike<void>) => {
            record.returnedCount++;
            engine.totalReturnCalls++;
            return originalReturn ? originalReturn(val) : Promise.resolve({ done: true as const, value: undefined });
          },
          throw: (err?: unknown) => {
            engine.totalThrowCalls++;
            return originalThrow ? originalThrow(err) : Promise.reject(err);
          },
        };
        return streamIt;
      },
    },
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  getDebugInfo: () => string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout after ${timeoutMs}ms. Debug info:\n${getDebugInfo()}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutP]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatDebug(engine: FakeWebLLMEngine, collected: unknown[]): string {
  return JSON.stringify(
    {
      requests: engine.requests,
      createCalls: engine.createCalls,
      interruptCalls: engine.interruptCalls,
      streams: engine.streams,
      totalReturnCalls: engine.totalReturnCalls,
      totalThrowCalls: engine.totalThrowCalls,
      locked: engine.lock.isLocked(),
      collected,
    },
    null,
    2,
  );
}

function assertCancelledCleanup(engine: FakeWebLLMEngine, expectedInterruptCalls: number) {
  expect(engine.lock.isLocked()).toBe(false);
  expect(engine.totalReturnCalls).toBe(0);
  expect(engine.totalThrowCalls).toBe(0);
  expect(engine.interruptCalls.length).toBe(expectedInterruptCalls);
}

const EXPECTED_FULL_CHUNKS: ProviderChunk[] = [
  { kind: "text", text: "가" },
  { kind: "text", text: "나" },
  { kind: "text", text: "다" },
  { kind: "usage", inputTokens: 3, outputTokens: 5 },
  { kind: "finish" },
];

describe("WebLLM 공급자 어댑터 계약 시험 (FE-08)", () => {
  const defaultConfig: ProviderConfig = { provider: "webllm", model: "display-model" };

  it("스트리밍: 가, 나, 다 내용 조각 및 usage 조각 후 finish 순서 확인", async () => {
    const engine = new FakeWebLLMEngine();
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });

    const chunks: ProviderChunk[] = [];
    await withTimeout(
      (async () => {
        for await (const chunk of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {})) {
          chunks.push(chunk);
        }
      })(),
      1000,
      () => formatDebug(engine, chunks),
    );

    expect(chunks).toEqual([
      { kind: "text", text: "가" },
      { kind: "text", text: "나" },
      { kind: "text", text: "다" },
      { kind: "usage", inputTokens: 3, outputTokens: 5 },
      { kind: "finish" },
    ]);
    expect(engine.lock.isLocked()).toBe(false);
    expect(engine.totalReturnCalls).toBe(0);
  });

  it("요청 모양: systemPrompt와 system 메시지 결합 및 config.model 무시 확인", async () => {
    const engine = new FakeWebLLMEngine();
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "actual-model" });

    const messages: ChatMessage[] = [
      { role: "system", content: "T" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
      { role: "user", content: "v" },
    ];

    await withTimeout(
      (async () => {
        for await (const _ of provider.chat(
          { provider: "webllm", model: "ignored-model" },
          messages,
          { systemPrompt: "S" },
        )) {
          // consume
        }
      })(),
      1000,
      () => formatDebug(engine, []),
    );

    expect(engine.requests.length).toBe(1);
    const req = engine.requests[0];
    expect(req.model).toBe("actual-model");
    expect(req.stream).toBe(true);
    expect(req.stream_options?.include_usage).toBe(true);
    expect(req.messages).toEqual([
      { role: "system", content: "S\n\nT" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
      { role: "user", content: "v" },
    ]);
  });

  it("생각 끄기: Qwen3 모델에서 enableThinking 설정 및 비-Qwen3/미지정 시 제외", async () => {
    // 1. Qwen3 with enableThinking: false
    const engine1 = new FakeWebLLMEngine();
    const provider1 = makeWebLLMProvider({
      getEngine: async () => engine1,
      model: "Qwen3-8B-q4f16_1-MLC",
    });
    for await (const _ of provider1.chat({ provider: "webllm", model: "m", enableThinking: false }, [], {})) {}
    expect(engine1.requests[0].extra_body).toEqual({ enable_thinking: false });

    // 2. Llama model
    const engine2 = new FakeWebLLMEngine();
    const provider2 = makeWebLLMProvider({
      getEngine: async () => engine2,
      model: "Llama-3.1-8B-Instruct-q4f16_1-MLC",
    });
    for await (const _ of provider2.chat({ provider: "webllm", model: "m", enableThinking: false }, [], {})) {}
    expect(engine2.requests[0].extra_body).toBeUndefined();

    // 3. Qwen3 without enableThinking
    const engine3 = new FakeWebLLMEngine();
    const provider3 = makeWebLLMProvider({
      getEngine: async () => engine3,
      model: "Qwen3-8B-q4f16_1-MLC",
    });
    for await (const _ of provider3.chat({ provider: "webllm", model: "m" }, [], {})) {}
    expect(engine3.requests[0].extra_body).toBeUndefined();
  });

  it("첫 조각 뒤 취소: 첫 조각 수신 후 abort 시 즉시 종료 및 잠금 해제", async () => {
    const engine = new FakeWebLLMEngine();
    let releaseBetweenGate!: () => void;
    engine.betweenChunksGate = new Promise<void>((resolve) => {
      releaseBetweenGate = resolve;
    });

    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });
    const ac = new AbortController();
    const chunks: ProviderChunk[] = [];

    await withTimeout(
      (async () => {
        for await (const chunk of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], { signal: ac.signal })) {
          chunks.push(chunk);
          if (chunk.kind === "text" && chunk.text === "가") {
            ac.abort();
            releaseBetweenGate();
          }
        }
      })(),
      1000,
      () => formatDebug(engine, chunks),
    );

    // 백그라운드 drainStream 소진 및 잠금 해제 대기 (상태 약속 1초 제한)
    await withTimeout(engine.reachedDone, 1000, () => formatDebug(engine, chunks));

    expect(chunks).toEqual([{ kind: "text", text: "가" }]);
    expect(engine.streams[0].finishReason).toBe("abort");
    expect(engine.streams[0].reachedDone).toBe(true);
    assertCancelledCleanup(engine, 1);
  });

  it("취소 후 같은 엔진 두 번째 요청 성공", async () => {
    const engine = new FakeWebLLMEngine();
    let releaseBetweenGate!: () => void;
    engine.betweenChunksGate = new Promise<void>((resolve) => {
      releaseBetweenGate = resolve;
    });

    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });
    const ac = new AbortController();

    // 첫 요청: 부분 수신 후 abort
    for await (const chunk of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], { signal: ac.signal })) {
      if (chunk.kind === "text") {
        ac.abort();
        releaseBetweenGate();
      }
    }

    // 첫 요청 소진 완료 대기
    await withTimeout(engine.reachedDone, 1000, () => formatDebug(engine, []));

    // 두 번째 요청: 정상 수신
    engine.betweenChunksGate = undefined;
    const chunks2: ProviderChunk[] = [];
    await withTimeout(
      (async () => {
        for await (const chunk of provider.chat(defaultConfig, [{ role: "user", content: "hi 2" }], {})) {
          chunks2.push(chunk);
        }
      })(),
      1000,
      () => formatDebug(engine, chunks2),
    );

    expect(chunks2).toEqual(EXPECTED_FULL_CHUNKS);
    assertCancelledCleanup(engine, 1);
  });

  it("첫 조각 전 취소: 스트림 본문 시작 후 표시 지운 뒤 interruptGenerate 호출 및 다음 요청 성공", async () => {
    const engine = new FakeWebLLMEngine();
    let releaseBeforeGate!: () => void;
    engine.beforeFirstChunkGate = new Promise<void>((resolve) => {
      releaseBeforeGate = resolve;
    });

    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });
    const ac = new AbortController();
    const it = provider.chat(defaultConfig, [{ role: "user", content: "hi" }], { signal: ac.signal })[Symbol.asyncIterator]();

    // 첫 next() 호출로 본문 시작 및 게이트 대기 유도
    const nextP = it.next();
    // 스트림 본문 시작 및 끊기 표시 지움 대기 (고정 지연 제거)
    await withTimeout(engine.bodyStarted, 1000, () => formatDebug(engine, []));
    ac.abort();
    releaseBeforeGate();

    const res = await withTimeout(nextP, 1000, () => formatDebug(engine, []));
    expect(res.done).toBe(true);

    // 가짜 엔진은 첫 조각을 실제로 냈지만 바깥은 받지 못했음을 단언
    expect(engine.streams[0].emittedChunks.some((c) => c.choices[0]?.delta?.content === "가")).toBe(true);

    // 백그라운드 소진 및 잠금 해제 대기
    await withTimeout(engine.reachedDone, 1000, () => formatDebug(engine, []));

    expect(engine.interruptCalls.length).toBe(1);
    expect(engine.interruptCalls[0].streamStarted).toBe(true);
    expect(engine.streams[0].finishReason).toBe("abort");
    expect(engine.streams[0].reachedDone).toBe(true);

    // 두 번째 요청 성공 확인
    engine.beforeFirstChunkGate = undefined;
    const chunks2: ProviderChunk[] = [];
    await withTimeout(
      (async () => {
        for await (const chunk of provider.chat(defaultConfig, [{ role: "user", content: "req2" }], {})) {
          chunks2.push(chunk);
        }
      })(),
      1000,
      () => formatDebug(engine, chunks2),
    );
    expect(chunks2).toEqual(EXPECTED_FULL_CHUNKS);
    assertCancelledCleanup(engine, 1);
  });

  it("create() 대기 중 취소: 늦게 돌아온 스트림 백그라운드 소진 및 다음 요청 성공", async () => {
    const engine = new FakeWebLLMEngine();
    let releaseCreateGate!: () => void;
    engine.createGate = new Promise<void>((resolve) => {
      releaseCreateGate = resolve;
    });

    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });
    const ac = new AbortController();
    const it = provider.chat(defaultConfig, [{ role: "user", content: "hi" }], { signal: ac.signal })[Symbol.asyncIterator]();

    const nextP = it.next();
    // create 진입 상태 약속 대기 (고정 지연 제거)
    await withTimeout(engine.createEntered, 1000, () => formatDebug(engine, []));
    ac.abort();

    const res = await withTimeout(nextP, 1000, () => formatDebug(engine, []));
    expect(res.done).toBe(true);

    // 문을 열면 늦게 돌아온 스트림이 시작되고 interruptGenerate 1회 호출 후 abort 종료
    releaseCreateGate();
    // 늦게 돌아온 스트림 소진 및 잠금 해제 대기 (고정 지연 제거)
    await withTimeout(engine.reachedDone, 1000, () => formatDebug(engine, []));

    expect(engine.interruptCalls.length).toBe(1);
    expect(engine.streams[0]?.finishReason).toBe("abort");
    expect(engine.streams[0]?.reachedDone).toBe(true);

    // 두 번째 요청 성공 확인
    engine.createGate = undefined;
    const chunks2: ProviderChunk[] = [];
    await withTimeout(
      (async () => {
        for await (const chunk of provider.chat(defaultConfig, [{ role: "user", content: "req2" }], {})) {
          chunks2.push(chunk);
        }
      })(),
      1000,
      () => formatDebug(engine, chunks2),
    );
    expect(chunks2).toEqual(EXPECTED_FULL_CHUNKS);
    assertCancelledCleanup(engine, 1);
  });

  it("대기 요청 취소가 활성 생성을 끊지 않음", async () => {
    const engine = new FakeWebLLMEngine();
    let releaseBetweenGate!: () => void;
    engine.betweenChunksGate = new Promise<void>((resolve) => {
      releaseBetweenGate = resolve;
    });

    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });

    // 요청 A 시작
    const itA = provider.chat(defaultConfig, [{ role: "user", content: "reqA" }], {})[Symbol.asyncIterator]();
    const firstA = await itA.next();
    expect(firstA.value).toEqual({ kind: "text", text: "가" });

    // 요청 B 시작 (슬롯 대기) 및 abort
    const acB = new AbortController();
    const itB = provider.chat(defaultConfig, [{ role: "user", content: "reqB" }], { signal: acB.signal })[Symbol.asyncIterator]();
    const nextBP = itB.next();
    acB.abort();

    const resB = await withTimeout(nextBP, 1000, () => formatDebug(engine, []));
    expect(resB.done).toBe(true);
    expect(engine.interruptCalls.length).toBe(0);
    expect(engine.createCalls).toBe(1);

    // A 게이트 열고 완료 확인
    releaseBetweenGate();
    const aChunks: ProviderChunk[] = [firstA.value as ProviderChunk];
    while (true) {
      const r = await itA.next();
      if (r.done) break;
      aChunks.push(r.value);
    }
    expect(aChunks).toEqual(EXPECTED_FULL_CHUNKS);

    // 요청 C 성공 확인 (1초 제한 및 정확한 배열 단언)
    engine.betweenChunksGate = undefined;
    const cChunks: ProviderChunk[] = [];
    await withTimeout(
      (async () => {
        for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "reqC" }], {})) {
          cChunks.push(c);
        }
      })(),
      1000,
      () => formatDebug(engine, cChunks),
    );
    expect(cChunks).toEqual(EXPECTED_FULL_CHUNKS);
    assertCancelledCleanup(engine, 0);
  });

  it("소비자 return(): yield에 멈춘 상태에서 return() 호출 시 즉시 완료 및 백그라운드 소진", async () => {
    const engine = new FakeWebLLMEngine();
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });
    const it = provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {})[Symbol.asyncIterator]();

    const first = await it.next();
    expect(first.value).toEqual({ kind: "text", text: "가" });

    // 다음 next() 안 부르고 return() 호출
    const retRes = await withTimeout(it.return!(), 1000, () => formatDebug(engine, []));
    expect(retRes.done).toBe(true);

    // 백그라운드 정리 대기 (고정 지연 제거)
    await withTimeout(engine.reachedDone, 1000, () => formatDebug(engine, []));
    expect(engine.interruptCalls.length).toBe(1);
    expect(engine.streams[0].reachedDone).toBe(true);

    // 다음 요청 성공 (1초 제한 및 정확한 배열 단언)
    const chunks2: ProviderChunk[] = [];
    await withTimeout(
      (async () => {
        for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi2" }], {})) {
          chunks2.push(c);
        }
      })(),
      1000,
      () => formatDebug(engine, chunks2),
    );
    expect(chunks2).toEqual(EXPECTED_FULL_CHUNKS);
    assertCancelledCleanup(engine, 1);
  });

  it("ChatTurnHandler 식 취소: next() 대기 중 abort 후 return() 동시 호출", async () => {
    const engine = new FakeWebLLMEngine();
    let releaseGate!: () => void;
    engine.betweenChunksGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });
    const ac = new AbortController();
    const it = provider.chat(defaultConfig, [{ role: "user", content: "hi" }], { signal: ac.signal })[Symbol.asyncIterator]();

    // 첫 조각 수신
    const first = await it.next();
    expect(first.value).toEqual({ kind: "text", text: "가" });

    // 두 번째 next() 호출(가짜 스트림은 게이트에서 멈춤)
    const pendingNext = it.next();
    // 기다리지 않고 abort 후 return() 호출
    ac.abort();
    void it.return?.();

    const res = await withTimeout(pendingNext, 1000, () => formatDebug(engine, []));
    expect(res.done).toBe(true);

    releaseGate();
    // 백그라운드 소진 대기 (고정 지연 제거)
    await withTimeout(engine.reachedDone, 1000, () => formatDebug(engine, []));

    // 다음 요청 성공 (1초 제한 및 정확한 배열 단언)
    engine.betweenChunksGate = undefined;
    const chunks2: ProviderChunk[] = [];
    await withTimeout(
      (async () => {
        for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "req2" }], {})) {
          chunks2.push(c);
        }
      })(),
      1000,
      () => formatDebug(engine, chunks2),
    );
    expect(chunks2).toEqual(EXPECTED_FULL_CHUNKS);
    assertCancelledCleanup(engine, 1);
  });

  it("엔진 준비 중 취소: getEngine 미해결 약속 상태에서 abort 및 슬롯 인계", async () => {
    const engine = new FakeWebLLMEngine();
    let calls = 0;
    const getEngine = async () => {
      calls++;
      if (calls === 1) {
        return new Promise<WebLLMEngineLike>(() => {});
      }
      return engine;
    };

    const provider = makeWebLLMProvider({ getEngine, model: "m" });
    const ac = new AbortController();
    const it = provider.chat(defaultConfig, [{ role: "user", content: "hi" }], { signal: ac.signal })[Symbol.asyncIterator]();

    const nextP = it.next();
    // 50ms 후 abort (지시서 예외 허용: 원 지시서 요구사항)
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();

    const res = await withTimeout(nextP, 1000, () => formatDebug(engine, []));
    expect(res.done).toBe(true);
    expect(engine.createCalls).toBe(0);

    // 두 번째 요청 슬롯 획득 및 성공 확인 (1초 제한 및 정확한 배열 단언)
    const chunks2: ProviderChunk[] = [];
    await withTimeout(
      (async () => {
        for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi2" }], {})) {
          chunks2.push(c);
        }
      })(),
      1000,
      () => formatDebug(engine, chunks2),
    );
    expect(chunks2).toEqual(EXPECTED_FULL_CHUNKS);
    assertCancelledCleanup(engine, 0);
  });

  it("시작 전 취소: 이미 끊긴 신호 전달 시 즉시 종료 및 getEngine 미호출", async () => {
    const engine = new FakeWebLLMEngine();
    let getEngineCalled = false;
    const provider = makeWebLLMProvider({
      getEngine: async () => {
        getEngineCalled = true;
        return engine;
      },
      model: "m",
    });

    const ac = new AbortController();
    ac.abort();

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], { signal: ac.signal })) {
      chunks.push(c);
    }

    expect(chunks).toEqual([]);
    expect(getEngineCalled).toBe(false);
    assertCancelledCleanup(engine, 0);
  });

  it("오류 매핑 세 가지: getEngine 실패, create 실패, 스트림 읽기 중 실패", async () => {
    // 1. getEngine 거부
    const p1 = makeWebLLMProvider({
      getEngine: async () => {
        throw new Error("엔진 다운로드 실패");
      },
      model: "m",
    });
    await expect(async () => {
      for await (const _ of p1.chat(defaultConfig, [{ role: "user", content: "hi" }], {})) {}
    }).rejects.toThrow(/webllm 엔진 준비 실패:.*엔진 다운로드 실패/);

    // 2. create 거부
    const p2Engine: WebLLMEngineLike = {
      chat: {
        completions: {
          create: async () => {
            throw new Error("WebGPU 미지원");
          },
        },
      },
      interruptGenerate: () => {},
    };
    const p2 = makeWebLLMProvider({ getEngine: async () => p2Engine, model: "m" });
    await expect(async () => {
      for await (const _ of p2.chat(defaultConfig, [{ role: "user", content: "hi" }], {})) {}
    }).rejects.toThrow(/webllm 요청 실패:.*WebGPU 미지원/);

    // 3. 한 조각 뒤 스트림 오류
    const p3Engine = new FakeWebLLMEngine();
    p3Engine.shouldThrowErrorOnNext = true;
    p3Engine.errorToThrow = new Error("디바이스 손실");
    const p3 = makeWebLLMProvider({ getEngine: async () => p3Engine, model: "m" });

    const it3 = p3.chat(defaultConfig, [{ role: "user", content: "hi" }], {})[Symbol.asyncIterator]();
    const first3 = await it3.next();
    expect(first3.value).toEqual({ kind: "text", text: "가" });
    await expect(it3.next()).rejects.toThrow(/webllm 스트림 오류:.*디바이스 손실/);
  });

  it("WO13A-K 지원하지 않는 메시지: inlineImages·attachments 거부", async () => {
    const engine = new FakeWebLLMEngine();
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });

    // user with inlineImages
    await expect(async () => {
      for await (const _ of provider.chat(
        defaultConfig,
        [{ role: "user", content: "img", inlineImages: [{ mimeType: "image/png", data: "abc" }] }],
        {},
      )) {}
    }).rejects.toThrow(/webllm: 지원하지 않는 메시지/);

    // user with attachments
    await expect(async () => {
      for await (const _ of provider.chat(
        defaultConfig,
        [{ role: "user", content: "att", attachments: [{ id: "1", kind: "image", mimeType: "image/png", sizeBytes: 10, localRef: "a" }] }],
        {},
      )) {}
    }).rejects.toThrow(/webllm: 지원하지 않는 메시지/);

    expect(engine.createCalls).toBe(0);
  });

  it("경로 해석: resolveProviderRoute, makeProviderResolver 주입 및 미주입 거부", async () => {
    expect(resolveProviderRoute({ provider: "webllm", model: "m" })).toBe("webllm");

    const fakeProvider = makeWebLLMProvider({ getEngine: async () => new FakeWebLLMEngine(), model: "m" });
    const resolver = makeProviderResolver({ webllm: fakeProvider });
    expect(resolver.resolve({ provider: "webllm", model: "m" })).toBe(fakeProvider);

    const uninjResolver = makeProviderResolver();
    const uninjProvider = uninjResolver.resolve({ provider: "webllm", model: "m" });
    const it = uninjProvider.chat({ provider: "webllm", model: "m" }, [], {})[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow(/webllm 공급자는 브라우저 Worker 에서만 쓸 수 있다\(엔진 미주입\)/);
  });

  it("브라우저 조립 루트를 거치는 끝단 통합 시험", async () => {
    const channel = new MessageChannel();
    const port1 = channel.port1;
    const port2 = channel.port2;
    const lines: string[] = [];

    port2.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        lines.push(ev.data);
      }
    };
    port2.start();

    const engine = new FakeWebLLMEngine();
    const agent = startBrowserAgent({
      port: port1,
      diag: { log: () => {}, debug: () => {} },
      provider: makeWebLLMProvider({ getEngine: async () => engine, model: "m" }),
    });

    const parseLine = (l: string) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    };

    const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`Timeout waiting for condition. Lines:\n${JSON.stringify(lines, null, 2)}`);
    };

    try {
      // 1. 정상 chat_request e1 전송
      port2.postMessage(
        JSON.stringify({
          type: "chat_request",
          requestId: "e1",
          provider: { provider: "webllm", model: "m" },
          messages: [{ role: "user", content: "안녕" }],
        }),
      );

      await waitFor(() => lines.some((l) => parseLine(l)?.requestId === "e1" && parseLine(l)?.type === "finish"));

      const e1Msgs = lines.map(parseLine).filter((m) => m?.requestId === "e1");
      const e1Texts = e1Msgs.filter((m) => m?.type === "text").map((m) => m?.text);
      expect(e1Texts).toEqual(["가", "나", "다"]);
      expect(e1Msgs[e1Msgs.length - 1].type).toBe("finish");

      // 2. 취소 시험: 첫 조각 뒤 문에서 멈춤
      let releaseBetweenGate!: () => void;
      engine.betweenChunksGate = new Promise<void>((resolve) => {
        releaseBetweenGate = resolve;
      });

      port2.postMessage(
        JSON.stringify({
          type: "chat_request",
          requestId: "c1",
          provider: { provider: "webllm", model: "m" },
          messages: [{ role: "user", content: "취소요청" }],
        }),
      );

      await waitFor(() => lines.some((l) => parseLine(l)?.requestId === "c1" && parseLine(l)?.type === "text"));

      // cancel_stream 전송
      port2.postMessage(
        JSON.stringify({
          type: "cancel_stream",
          requestId: "c1",
        }),
      );

      await waitFor(() => lines.some((l) => parseLine(l)?.requestId === "c1" && parseLine(l)?.type === "error"));

      const c1Msgs = lines.map(parseLine).filter((m) => m?.requestId === "c1");
      const c1Errors = c1Msgs.filter((m) => m?.type === "error" && m?.message === "cancelled");
      expect(c1Errors.length).toBe(1);
      const c1Finishes = c1Msgs.filter((m) => m?.type === "finish");
      expect(c1Finishes.length).toBe(0);
      expect(engine.interruptCalls.length).toBe(1);

      // 게이트 해제
      releaseBetweenGate();
      engine.betweenChunksGate = undefined;

      // 3. 같은 포트로 새 requestId(c2) 두 번째 chat_request 전송
      port2.postMessage(
        JSON.stringify({
          type: "chat_request",
          requestId: "c2",
          provider: { provider: "webllm", model: "m" },
          messages: [{ role: "user", content: "두번째요청" }],
        }),
      );

      await waitFor(() => lines.some((l) => parseLine(l)?.requestId === "c2" && parseLine(l)?.type === "finish"));

      const c2Msgs = lines.map(parseLine).filter((m) => m?.requestId === "c2");
      const c2Texts = c2Msgs.filter((m) => m?.type === "text").map((m) => m?.text);
      expect(c2Texts).toEqual(["가", "나", "다"]);
      expect(c2Msgs[c2Msgs.length - 1].type).toBe("finish");
    } finally {
      port1.close();
      port2.close();
      agent.stop();
    }
  });

  it("finish 뒤 추가 next 없이 다음 요청: 슬롯이 풀려 둘째 요청 성공", async () => {
    const engine = new FakeWebLLMEngine();
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });

    // 첫 요청: finish 까지만 받고 이터레이터 방치
    const it1 = provider.chat(defaultConfig, [{ role: "user", content: "req1" }], {})[Symbol.asyncIterator]();
    while (true) {
      const res = await it1.next();
      if (res.done) break;
      if (res.value.kind === "finish") {
        break; // finish 를 받고 더 이상 next() 나 return() 을 부르지 않음
      }
    }

    // 둘째 요청: 1초 안에 정확한 출력 배열 수신
    const chunks2: ProviderChunk[] = [];
    await withTimeout(
      (async () => {
        for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "req2" }], {})) {
          chunks2.push(c);
        }
      })(),
      1000,
      () => formatDebug(engine, chunks2),
    );

    expect(chunks2).toEqual(EXPECTED_FULL_CHUNKS);
    assertCancelledCleanup(engine, 0);
  });

  it("버려진 이전 요청의 신호: finish 후 방치된 이터레이터의 신호 A가 나중에 abort 되어도 둘째 요청에 무영향", async () => {
    const engine = new FakeWebLLMEngine();
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });

    const acA = new AbortController();
    const it1 = provider.chat(defaultConfig, [{ role: "user", content: "req1" }], { signal: acA.signal })[Symbol.asyncIterator]();
    while (true) {
      const res = await it1.next();
      if (res.done) break;
      if (res.value.kind === "finish") {
        break; // finish 까지만 받고 방치
      }
    }

    const acB = new AbortController();
    const it2 = provider.chat(defaultConfig, [{ role: "user", content: "req2" }], { signal: acB.signal })[Symbol.asyncIterator]();
    const chunks2: ProviderChunk[] = [];

    // 둘째 요청 첫 text 받은 뒤 신호 A abort
    await withTimeout(
      (async () => {
        const first = await it2.next();
        expect(first.done).toBe(false);
        chunks2.push(first.value);

        acA.abort(); // 신호 A abort!

        while (true) {
          const res = await it2.next();
          if (res.done) break;
          chunks2.push(res.value);
        }
      })(),
      1000,
      () => formatDebug(engine, chunks2),
    );

    expect(chunks2).toEqual(EXPECTED_FULL_CHUNKS);
    assertCancelledCleanup(engine, 0);
  });

  it("한 조각에 content 와 usage: text 수신 직후 abort 시 다음 next()에서 usage가 나오지 않고 done: true", async () => {
    const engine = new FakeWebLLMEngine();
    // 한 조각에 content 와 usage 를 함께 담음
    engine.chunksToSend = [
      {
        content: "가",
        usage: { prompt_tokens: 3, completion_tokens: 5 },
      },
    ];

    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });
    const ac = new AbortController();
    const it = provider.chat(defaultConfig, [{ role: "user", content: "hi" }], { signal: ac.signal })[Symbol.asyncIterator]();

    // 첫 next()로 text "가" 수신
    const res1 = await withTimeout(it.next(), 1000, () => formatDebug(engine, []));
    expect(res1.done).toBe(false);
    expect(res1.value).toEqual({ kind: "text", text: "가" });

    // 소비자가 text "가"를 받은 직후 abort
    ac.abort();

    // 그 뒤 next() 호출 시 usage가 나오지 않고 done: true
    const res2 = await withTimeout(it.next(), 1000, () => formatDebug(engine, []));
    expect(res2.done).toBe(true);

    // 정리 대기 및 확인
    await withTimeout(engine.reachedDone, 1000, () => formatDebug(engine, []));
    assertCancelledCleanup(engine, 1);
  });

  it("create 성공 직후, 첫 next 전 취소", async () => {
    const engine = new FakeWebLLMEngine();
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });
    const ac = new AbortController();

    const origCreate = engine.chat.completions.create.bind(engine.chat.completions);
    engine.chat.completions.create = (req: WebLLMChatRequest) => {
      const p = origCreate(req);
      p.then(() => queueMicrotask(() => ac.abort()));
      return p;
    };

    const it = provider.chat(defaultConfig, [{ role: "user", content: "hi" }], { signal: ac.signal })[Symbol.asyncIterator]();
    const chunks: ProviderChunk[] = [];
    while (true) {
      const res = await withTimeout(it.next(), 1000, () => formatDebug(engine, chunks));
      if (res.done) break;
      chunks.push(res.value);
    }
    expect(chunks).toEqual([]);

    await withTimeout(engine.reachedDone, 1000, () => formatDebug(engine, []));
    expect(engine.streams[0].reachedDone).toBe(true);

    expect(engine.interruptCalls.length).toBe(1);
    expect(engine.interruptCalls[0].streamStarted).toBe(true);
    expect(engine.streams[0].finishReason).toBe("abort");

    // 같은 공급자의 다음 요청이 1초 안에 정확한 출력 배열(가·나·다, usage, finish)을 받는다.
    const chunks2: ProviderChunk[] = [];
    await withTimeout(
      (async () => {
        for await (const chunk of provider.chat(defaultConfig, [{ role: "user", content: "req2" }], {})) {
          chunks2.push(chunk);
        }
      })(),
      1000,
      () => formatDebug(engine, chunks2),
    );
    expect(chunks2).toEqual(EXPECTED_FULL_CHUNKS);

    // 공통 정리 단언 함수(엔진 스트림 return()·throw() 0회 등)를 부른다.
    assertCancelledCleanup(engine, 1);
  });
});

function mergeNeighboringTexts(chunks: readonly ProviderChunk[]): ProviderChunk[] {
  const result: ProviderChunk[] = [];
  for (const chunk of chunks) {
    const last = result[result.length - 1];
    if (chunk.kind === "text" && last && last.kind === "text") {
      result[result.length - 1] = { kind: "text", text: last.text + chunk.text };
    } else {
      result.push(chunk);
    }
  }
  return result;
}

function mergeSameKindChunks(chunks: readonly ProviderChunk[]): ProviderChunk[] {
  const result: ProviderChunk[] = [];
  for (const chunk of chunks) {
    const last = result[result.length - 1];
    if (chunk.kind === "text" && last && last.kind === "text") {
      result[result.length - 1] = { kind: "text", text: last.text + chunk.text };
    } else if (chunk.kind === "thinking" && last && last.kind === "thinking") {
      result[result.length - 1] = { kind: "thinking", text: last.text + chunk.text };
    } else {
      result.push(chunk);
    }
  }
  return result;
}

function makeEngineWithChunks(chunks: Array<{ content?: string; usage?: { prompt_tokens: number; completion_tokens: number }; finish_reason?: string | null }>): {
  engine: WebLLMEngineLike;
  requests: WebLLMChatRequest[];
} {
  const requests: WebLLMChatRequest[] = [];
  const engine: WebLLMEngineLike = {
    chat: {
      completions: {
        create: async (req) => {
          requests.push(req);
          return (async function* () {
            for (const c of chunks) {
              yield {
                choices: [{ delta: { content: c.content }, finish_reason: c.finish_reason ?? null }],
                ...(c.usage ? { usage: c.usage } : {}),
              };
            }
          })();
        },
      },
    },
    interruptGenerate() {},
  };
  return { engine, requests };
}

describe("WO13A WebLLM provider tool-call protocol", () => {
  const defaultConfig: ProviderConfig = { provider: "webllm", model: "display-model" };

  beforeEach(() => {
    expect.hasAssertions();
  });

  it("WO13A-P1 toolNames 없이 opts.tools 주어도 원래대로 text 처리", async () => {
    const { engine, requests } = makeEngineWithChunks([
      { content: '<tool_call>{"name":"read_file","arguments":{"path":"AGENTS.md"}}</tool_call>' },
    ]);
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });
    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "desc", parameters: {} }],
    })) {
      chunks.push(c);
    }
    expect(requests[0]?.messages.some((m) => m.role === "system" && m.content.includes("<tools>"))).toBe(false);
    expect(chunks).toEqual([
      { kind: "text", text: '<tool_call>{"name":"read_file","arguments":{"path":"AGENTS.md"}}</tool_call>' },
      { kind: "finish" },
    ]);
  });

  it("WO13A-P2 toolNames 필터링 및 opts.tools 순서 보존", async () => {
    const { engine, requests } = makeEngineWithChunks([{ content: "ok" }]);
    const provider = makeWebLLMProvider({
      getEngine: async () => engine,
      model: "m",
      toolNames: ["list_dir", "read_file"],
    });

    const toolCS = { name: "continue_speaking", description: "cs", parameters: {} };
    const toolLD = { name: "list_dir", description: "ld", parameters: {} };
    const toolRF = { name: "read_file", description: "rf", parameters: {} };

    const expectedToolsBlock1 = `# Tools

You may call one or more functions to assist with the user specification.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
${JSON.stringify({ type: "function", function: { name: toolLD.name, description: toolLD.description, parameters: toolLD.parameters } })}
${JSON.stringify({ type: "function", function: { name: toolRF.name, description: toolRF.description, parameters: toolRF.parameters } })}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>

Always reply in the same language as the user's latest message, even when the files or tool results you read are in another language.`;

    const chunks1: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "system", content: "SYS" }, { role: "user", content: "1" }], {
      tools: [toolCS, toolLD, toolRF],
    })) {
      chunks1.push(c);
    }

    const sys1 = requests[0]?.messages.find((m) => m.role === "system")?.content;
    expect(sys1).toBe("SYS\n\n" + expectedToolsBlock1);
    expect(chunks1).toEqual([
      { kind: "text", text: "ok" },
      { kind: "finish" },
    ]);

    const expectedToolsBlock2 = `# Tools

You may call one or more functions to assist with the user specification.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
${JSON.stringify({ type: "function", function: { name: toolRF.name, description: toolRF.description, parameters: toolRF.parameters } })}
${JSON.stringify({ type: "function", function: { name: toolLD.name, description: toolLD.description, parameters: toolLD.parameters } })}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>

Always reply in the same language as the user's latest message, even when the files or tool results you read are in another language.`;

    const chunks2: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "system", content: "SYS" }, { role: "user", content: "2" }], {
      tools: [toolRF, toolCS, toolLD],
    })) {
      chunks2.push(c);
    }

    const sys2 = requests[1]?.messages.find((m) => m.role === "system")?.content;
    expect(sys2).toBe("SYS\n\n" + expectedToolsBlock2);
    expect(chunks2).toEqual([
      { kind: "text", text: "ok" },
      { kind: "finish" },
    ]);
  });

  it("WO13A-P3 merge-helper", () => {
    const sample: ProviderChunk[] = [
      { kind: "text", text: "a" },
      { kind: "usage", inputTokens: 1, outputTokens: 1 },
      { kind: "text", text: "b" },
    ];
    expect(mergeNeighboringTexts(sample)).toEqual(sample);
  });

  const BASE = "<think>\n\n</think>\n\n앞말 <tool_call>\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"AGENTS.md\"}}\n</tool_call>";
  const P3_SPLIT_CASES: Array<[number, string, string]> = [];
  for (let i = 1; i < BASE.length; i++) {
    P3_SPLIT_CASES.push([i, BASE.slice(0, i), BASE.slice(i)]);
  }

  it.each(P3_SPLIT_CASES)("WO13A-P3 split@%s", async (_idx, p1, p2) => {
    const { engine } = makeEngineWithChunks([{ content: p1 }, { content: p2 }]);
    const provider = makeWebLLMProvider({
      getEngine: async () => engine,
      model: "m",
      toolNames: ["read_file"],
    });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(mergeNeighboringTexts(chunks)).toEqual([
      { kind: "text", text: "\n\n앞말 " },
      { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
      { kind: "finish" },
    ]);
  });

  it("WO13A-P3 per-char", async () => {
    const charChunks = Array.from(BASE).map((ch) => ({ content: ch }));
    const { engine } = makeEngineWithChunks(charChunks);
    const provider = makeWebLLMProvider({
      getEngine: async () => engine,
      model: "m",
      toolNames: ["read_file"],
    });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(mergeNeighboringTexts(chunks)).toEqual([
      { kind: "text", text: "\n\n앞말 " },
      { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
      { kind: "finish" },
    ]);
  });

  it("WO13A-P4 생각 구간 안의 유효 호출만 있는 생각+답", async () => {
    const text = '<think><tool_call>{"name":"read_file","arguments":{"path":"AGENTS.md"}}</tool_call></think>답';
    const { engine } = makeEngineWithChunks([{ content: text }]);
    const provider = makeWebLLMProvider({
      getEngine: async () => engine,
      model: "m",
      toolNames: ["read_file"],
    });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(mergeNeighboringTexts(chunks)).toEqual([
      { kind: "thinking", text: '<tool_call>{"name":"read_file","arguments":{"path":"AGENTS.md"}}</tool_call>' },
      { kind: "text", text: "답" },
      { kind: "finish" },
    ]);
  });

  it("WO13A-P5 바깥 유효 호출 뒤에 생각 구간 안 유효 호출 무시", async () => {
    const c1 = '<tool_call>\n{"name":"read_file","arguments":{"path":"AGENTS.md"}}\n</tool_call>';
    const c2 = '<think><tool_call>\n{"name":"list_dir","arguments":{"path":"notes"}}\n</tool_call></think>';
    const { engine } = makeEngineWithChunks([{ content: c1 + c2 }]);
    const provider = makeWebLLMProvider({
      getEngine: async () => engine,
      model: "m",
      toolNames: ["read_file", "list_dir"],
    });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [
        { name: "read_file", description: "rf", parameters: {} },
        { name: "list_dir", description: "ld", parameters: {} },
      ],
    })) {
      chunks.push(c);
    }

    expect(chunks).toEqual([
      { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
      { kind: "finish" },
    ]);
  });

  it("WO13A-P6 바깥 유효 호출 둘(사이에 글 그리고)", async () => {
    const text = '<tool_call>\n{"name":"read_file","arguments":{"path":"AGENTS.md"}}\n</tool_call>그리고<tool_call>\n{"name":"list_dir","arguments":{"path":"notes"}}\n</tool_call>';
    const { engine } = makeEngineWithChunks([{ content: text }]);
    const provider = makeWebLLMProvider({
      getEngine: async () => engine,
      model: "m",
      toolNames: ["read_file", "list_dir"],
    });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [
        { name: "read_file", description: "rf", parameters: {} },
        { name: "list_dir", description: "ld", parameters: {} },
      ],
    })) {
      chunks.push(c);
    }

    expect(chunks).toEqual([
      { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
      { kind: "toolUse", id: "webllm-call-1-1", name: "list_dir", args: { path: "notes" } },
      { kind: "finish" },
    ]);
  });

  const P7_CASES = [
    ["WO13A-P7 bad-json", "<tool_call>bad json</tool_call>"],
    ["WO13A-P7 hidden-name", '<tool_call>{"name":"continue_speaking","arguments":{}}</tool_call>'],
    ["WO13A-P7 args-null", '<tool_call>{"name":"read_file","arguments":null}</tool_call>'],
    ["WO13A-P7 args-array", '<tool_call>{"name":"read_file","arguments":[1]}</tool_call>'],
    ["WO13A-P7 args-string", '<tool_call>{"name":"read_file","arguments":"str"}</tool_call>'],
    ["WO13A-P7 unclosed", '<tool_call>{"name":"read_file","arguments":{"path":"x"}}'],
    ["WO13A-P7 valid-plus-invalid", '<tool_call>{"name":"read_file","arguments":{"path":"x"}}</tool_call><tool_call>bad</tool_call>'],
    ["WO13A-P7 valid-then-unclosed", '<tool_call>{"name":"read_file","arguments":{"path":"x"}}</tool_call><tool_call>{"name":"list_dir"'],
    ["WO13A-P7 tag-in-string", '<tool_call>{"name":"read_file","arguments":{"path":"x</tool_call>y"}}</tool_call>'],
  ] as const;

  it.each(P7_CASES)("%s", async (_name, text) => {
    const { engine } = makeEngineWithChunks([{ content: text }]);
    const provider = makeWebLLMProvider({
      getEngine: async () => engine,
      model: "m",
      toolNames: ["read_file", "list_dir"],
    });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [
        { name: "read_file", description: "rf", parameters: {} },
        { name: "list_dir", description: "ld", parameters: {} },
        { name: "continue_speaking", description: "cs", parameters: {} },
      ],
    })) {
      chunks.push(c);
    }

    expect(chunks).toEqual([
      { kind: "text", text },
      { kind: "finish" },
    ]);
  });

  it("WO13A-P8 usage-same-chunk", async () => {
    const text = '앞말 <tool_call>\n{"name":"read_file","arguments":{"path":"AGENTS.md"}}\n</tool_call>';
    const { engine } = makeEngineWithChunks([
      { content: text, usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]);
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(chunks).toEqual([
      { kind: "text", text: "앞말 " },
      { kind: "usage", inputTokens: 10, outputTokens: 5 },
      { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
      { kind: "finish" },
    ]);
  });

  it("WO13A-P8 usage-first", async () => {
    const text = '앞말 <tool_call>\n{"name":"read_file","arguments":{"path":"AGENTS.md"}}\n</tool_call>';
    const { engine } = makeEngineWithChunks([
      { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { content: text },
    ]);
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(chunks).toEqual([
      { kind: "usage", inputTokens: 10, outputTokens: 5 },
      { kind: "text", text: "앞말 " },
      { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
      { kind: "finish" },
    ]);
  });

  it("WO13A-P8 usage-last-chunk", async () => {
    const text = '앞말 <tool_call>\n{"name":"read_file","arguments":{"path":"AGENTS.md"}}\n</tool_call>';
    const { engine } = makeEngineWithChunks([
      { content: text },
      { usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]);
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(chunks).toEqual([
      { kind: "text", text: "앞말 " },
      { kind: "usage", inputTokens: 10, outputTokens: 5 },
      { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
      { kind: "finish" },
    ]);
  });

  it("WO13A-P8 usage-between-text", async () => {
    const { engine } = makeEngineWithChunks([
      { content: "앞" },
      { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { content: '말 <tool_call>\n{"name":"read_file","arguments":{"path":"AGENTS.md"}}\n</tool_call>' },
    ]);
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(chunks).toEqual([
      { kind: "text", text: "앞" },
      { kind: "usage", inputTokens: 10, outputTokens: 5 },
      { kind: "text", text: "말 " },
      { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
      { kind: "finish" },
    ]);
  });

  const P9_CASES = [
    {
      name: "WO13A-P9 cancel-held-call",
      chunksBeforeAbort: [
        { content: '앞말 <tool_call>\n{"name":"read_file","arguments":{"path":"AGENTS.md"}}\n</tool_call>' },
      ],
      expectedBeforeAbort: [{ kind: "text", text: "앞말 " } as ProviderChunk],
      expectedTotal: [{ kind: "text", text: "앞말 " } as ProviderChunk],
    },
    {
      name: "WO13A-P9 cancel-after-usage",
      chunksBeforeAbort: [
        { content: "앞말 " },
        { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ],
      expectedBeforeAbort: [
        { kind: "text", text: "앞말 " } as ProviderChunk,
        { kind: "usage", inputTokens: 10, outputTokens: 5 } as ProviderChunk,
      ],
      expectedTotal: [
        { kind: "text", text: "앞말 " } as ProviderChunk,
        { kind: "usage", inputTokens: 10, outputTokens: 5 } as ProviderChunk,
      ],
    },
    {
      name: "WO13A-P9 cancel-partial-tag",
      chunksBeforeAbort: [
        { content: "앞말 <tool_" },
      ],
      expectedBeforeAbort: [{ kind: "text", text: "앞말 " } as ProviderChunk],
      expectedTotal: [{ kind: "text", text: "앞말 " } as ProviderChunk],
    },
  ];

  it.each(
    P9_CASES.map((c) => [c.name, c.chunksBeforeAbort, c.expectedBeforeAbort, c.expectedTotal] as const),
  )("%s", async (_name, chunksBeforeAbort, expectedBeforeAbort, expectedTotal) => {
    let unblockNext!: () => void;
    const nextWaitP = new Promise<void>((r) => { unblockNext = r; });

    const ac = new AbortController();

    async function* controllableEngineStream(): AsyncGenerator<WebLLMChatChunk, void, unknown> {
      for (const c of chunksBeforeAbort) {
        yield {
          choices: [{ delta: { content: c.content }, finish_reason: null }],
          ...(c.usage ? { usage: c.usage } : {}),
        };
      }
      await nextWaitP;
      yield { choices: [{ delta: { content: "끝" }, finish_reason: null }] };
    }

    const engine: WebLLMEngineLike = {
      chat: { completions: { create: async () => controllableEngineStream() } },
      interruptGenerate() {},
    };

    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });

    const it = provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      signal: ac.signal,
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })[Symbol.asyncIterator]();

    const beforeAbortChunks: ProviderChunk[] = [];
    for (let i = 0; i < expectedBeforeAbort.length; i++) {
      const res = await it.next();
      expect(res.done).toBe(false);
      beforeAbortChunks.push(res.value);
    }
    expect(beforeAbortChunks).toEqual(expectedBeforeAbort);

    ac.abort();
    unblockNext();

    const allChunks = [...beforeAbortChunks];
    while (true) {
      const res = await it.next();
      if (res.done) break;
      allChunks.push(res.value);
    }

    expect(allChunks).toEqual(expectedTotal);
  });

  it("WO13A-P11 think-split-after-capture", async () => {
    const chunk1 = '앞말 <tool_call>\n{"name":"read_file","arguments":{"path":"AGENTS.md"}}\n</tool_call><thi';
    const chunk2 = 'nk>x</think>';
    const { engine } = makeEngineWithChunks([{ content: chunk1 }, { content: chunk2 }]);
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(mergeNeighboringTexts(chunks)).toEqual([
      { kind: "text", text: "앞말 " },
      { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
      { kind: "finish" },
    ]);
  });

  it("WO13A-P11 usage-between-tag-pieces", async () => {
    const { engine } = makeEngineWithChunks([
      { content: "앞말 <tool_" },
      { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { content: 'call>\n{"name":"read_file","arguments":{"path":"AGENTS.md"}}\n</tool_call>' },
    ]);
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(mergeNeighboringTexts(chunks)).toEqual([
      { kind: "text", text: "앞말 " },
      { kind: "usage", inputTokens: 10, outputTokens: 5 },
      { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
      { kind: "finish" },
    ]);
  });

  it("WO13A-P12 escaped-tag", async () => {
    const text = '<tool_call>{"name":"read_file","arguments":{"path":"x<\\/tool_call>y"}}</tool_call>';
    const { engine } = makeEngineWithChunks([{ content: text }]);
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(chunks).toEqual([
      { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "x</tool_call>y" } },
      { kind: "finish" },
    ]);
  });

  it.each([
    ["WO13A-P9 cancel-after-first-tooluse keep-reading", "keep-reading" as const],
    ["WO13A-P9 cancel-after-first-tooluse return", "return" as const],
  ])("%s", async (_name, action) => {
    const text = '앞말 <tool_call>\n{"name":"read_file","arguments":{"path":"1"}}\n</tool_call><tool_call>\n{"name":"read_file","arguments":{"path":"2"}}\n</tool_call>';
    const { engine } = makeEngineWithChunks([{ content: text }]);
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });

    const ac = new AbortController();
    const it = provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      signal: ac.signal,
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })[Symbol.asyncIterator]();

    const chunks: ProviderChunk[] = [];
    const r1 = await it.next();
    chunks.push(r1.value);
    const r2 = await it.next();
    chunks.push(r2.value);

    ac.abort();

    if (action === "keep-reading") {
      const r3 = await it.next();
      chunks.push(r3.value);
      const r4 = await it.next();
      chunks.push(r4.value);
      expect(chunks).toEqual([
        { kind: "text", text: "앞말 " },
        { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "1" } },
        { kind: "toolUse", id: "webllm-call-1-1", name: "read_file", args: { path: "2" } },
        { kind: "finish" },
      ]);
      const r5 = await it.next();
      expect(r5).toEqual({ done: true, value: undefined });
    } else {
      const ret = await it.return!();
      expect(ret).toEqual({ done: true, value: undefined });
      expect(chunks).toEqual([
        { kind: "text", text: "앞말 " },
        { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "1" } },
      ]);
    }
  });

  it("WO13A-P14 eof-partial-open-tag", async () => {
    // 1. 앞말 <tool_
    {
      const { engine } = makeEngineWithChunks([{ content: "앞말 <tool_" }]);
      const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });
      const chunks: ProviderChunk[] = [];
      for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
        tools: [{ name: "read_file", description: "rf", parameters: {} }],
      })) {
        chunks.push(c);
      }
      expect(mergeNeighboringTexts(chunks)).toEqual([
        { kind: "text", text: "앞말 <tool_" },
        { kind: "finish" },
      ]);
    }

    // 2. 앞말 <tool_call>\n{"name":
    {
      const { engine } = makeEngineWithChunks([{ content: '앞말 <tool_call>\n{"name":' }]);
      const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });
      const chunks: ProviderChunk[] = [];
      for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
        tools: [{ name: "read_file", description: "rf", parameters: {} }],
      })) {
        chunks.push(c);
      }
      expect(mergeNeighboringTexts(chunks)).toEqual([
        { kind: "text", text: '앞말 <tool_call>\n{"name":' },
        { kind: "finish" },
      ]);
    }

    // 3. 앞말 <thi
    {
      const { engine } = makeEngineWithChunks([{ content: "앞말 <thi" }]);
      const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });
      const chunks: ProviderChunk[] = [];
      for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
        tools: [{ name: "read_file", description: "rf", parameters: {} }],
      })) {
        chunks.push(c);
      }
      expect(mergeNeighboringTexts(chunks)).toEqual([
        { kind: "text", text: "앞말 <thi" },
        { kind: "finish" },
      ]);
    }

    // 4. 앞말 <think>생각
    {
      const { engine } = makeEngineWithChunks([{ content: "앞말 <think>생각" }]);
      const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });
      const chunks: ProviderChunk[] = [];
      for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
        tools: [{ name: "read_file", description: "rf", parameters: {} }],
      })) {
        chunks.push(c);
      }
      expect(mergeNeighboringTexts(chunks)).toEqual([
        { kind: "text", text: "앞말 " },
        { kind: "thinking", text: "생각" },
        { kind: "finish" },
      ]);
    }

    // 5. 앞말 <tool_call>\n{유효 read_file}\n</tool_call><think>x</thi
    {
      const content = '앞말 <tool_call>\n{"name":"read_file","arguments":{"path":"AGENTS.md"}}\n</tool_call><think>x</thi';
      const { engine } = makeEngineWithChunks([{ content }]);
      const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });
      const chunks: ProviderChunk[] = [];
      for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
        tools: [{ name: "read_file", description: "rf", parameters: {} }],
      })) {
        chunks.push(c);
      }
      expect(mergeNeighboringTexts(chunks)).toEqual([
        { kind: "text", text: "앞말 " },
        { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
        { kind: "finish" },
      ]);
    }
  });

  const BASE2 = "앞말 <tool_call>\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"AGENTS.md\"}}\n</tool_call><think>x</think>";
  const P15_SPLIT_CASES: Array<[number, string, string]> = [];
  for (let i = 1; i < BASE2.length; i++) {
    P15_SPLIT_CASES.push([i, BASE2.slice(0, i), BASE2.slice(i)]);
  }

  it.each(P15_SPLIT_CASES)("WO13A-P15 split@%s", async (_idx, p1, p2) => {
    const { engine } = makeEngineWithChunks([{ content: p1 }, { content: p2 }]);
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(mergeNeighboringTexts(chunks)).toEqual([
      { kind: "text", text: "앞말 " },
      { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
      { kind: "finish" },
    ]);
  });

  it("WO13A-P16 think-tag-in-args", async () => {
    const text = '앞말 <tool_call>\n{"name":"read_file","arguments":{"path":"a<think>b"}}\n</tool_call><tool_call>\n{"name":"list_dir","arguments":{"path":"notes"}}\n</tool_call>';
    const { engine } = makeEngineWithChunks([{ content: text }]);
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file", "list_dir"] });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [
        { name: "read_file", description: "rf", parameters: {} },
        { name: "list_dir", description: "ld", parameters: {} },
      ],
    })) {
      chunks.push(c);
    }

    expect(mergeNeighboringTexts(chunks)).toEqual([
      { kind: "text", text: "앞말 " },
      { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "a<think>b" } },
      { kind: "toolUse", id: "webllm-call-1-1", name: "list_dir", args: { path: "notes" } },
      { kind: "finish" },
    ]);
  });

  it("WO13A-P17 cancel-at-eof", async () => {
    const controller = new AbortController();
    let eofReached = false;
    Object.defineProperty(controller.signal, "aborted", {
      get: () => eofReached,
    });

    async function* engineStream(): AsyncGenerator<WebLLMChatChunk, void, unknown> {
      yield {
        choices: [
          {
            delta: { content: '앞말 <tool_call>\n{"name":"read_file","arguments":{"path":"AGENTS.md"}}\n</tool_call>' },
            finish_reason: null,
          },
        ],
      };
      eofReached = true;
      return;
    }

    const engine: WebLLMEngineLike = {
      chat: { completions: { create: async () => engineStream() } },
      interruptGenerate() {},
    };

    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      signal: controller.signal,
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(chunks).toEqual([
      { kind: "text", text: "앞말 " },
    ]);
  });

  it("WO13A-P18 request-number", async () => {
    let callCount = 0;
    const engine: WebLLMEngineLike = {
      chat: {
        completions: {
          create: async () => {
            callCount++;
            return (async function* () {
              if (callCount === 3) {
                yield {
                  choices: [
                    {
                      delta: {
                        content: '<tool_call>{"name":"read_file","arguments":{"path":"1"}}</tool_call><tool_call>{"name":"read_file","arguments":{"path":"2"}}</tool_call>',
                      },
                      finish_reason: null,
                    },
                  ],
                };
              } else {
                yield {
                  choices: [
                    {
                      delta: { content: '<tool_call>{"name":"read_file","arguments":{"path":"AGENTS.md"}}</tool_call>' },
                      finish_reason: null,
                    },
                  ],
                };
              }
            })();
          },
        },
      },
      interruptGenerate() {},
    };

    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });

    const c1: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "1" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      c1.push(c);
    }
    expect(c1).toEqual([
      { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
      { kind: "finish" },
    ]);

    const c2: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "2" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      c2.push(c);
    }
    expect(c2).toEqual([
      { kind: "toolUse", id: "webllm-call-2-0", name: "read_file", args: { path: "AGENTS.md" } },
      { kind: "finish" },
    ]);

    const c3: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "3" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      c3.push(c);
    }
    expect(c3).toEqual([
      { kind: "toolUse", id: "webllm-call-3-0", name: "read_file", args: { path: "1" } },
      { kind: "toolUse", id: "webllm-call-3-1", name: "read_file", args: { path: "2" } },
      { kind: "finish" },
    ]);

    // (가) 이미 취소된 신호로 chat() 하고 끝까지 읽음
    const acCancelled = new AbortController();
    acCancelled.abort();
    const c4: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "4" }], {
      signal: acCancelled.signal,
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      c4.push(c);
    }
    expect(c4).toEqual([]);

    // (나) inlineImages 가 든 메시지로 chat() 해서 예외를 받음
    await expect(async () => {
      for await (const _ of provider.chat(
        defaultConfig,
        [{ role: "user", content: "5", inlineImages: [{ mimeType: "image/png", data: "abc" }] }],
        { tools: [{ name: "read_file", description: "rf", parameters: {} }] },
      )) {}
    }).rejects.toThrow();

    // (다) 유효 read_file 호출 하나를 흘리는 chat() 을 더하고, toolUse.id 가 webllm-call-6-0 인지 단언
    const c6: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "6" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      c6.push(c);
    }
    expect(c6).toEqual([
      { kind: "toolUse", id: "webllm-call-6-0", name: "read_file", args: { path: "AGENTS.md" } },
      { kind: "finish" },
    ]);
  });

  it("WO13A-P19 think-closed-inside-inner-call", async () => {
    const text = '<think><tool_call>\n{"name":"list_dir","arguments":{"path":"notes"}}\n</think>그다음 <tool_call>\n{"name":"read_file","arguments":{"path":"AGENTS.md"}}\n</tool_call>';
    const { engine } = makeEngineWithChunks([{ content: text }]);
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file", "list_dir"] });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [
        { name: "read_file", description: "rf", parameters: {} },
        { name: "list_dir", description: "ld", parameters: {} },
      ],
    })) {
      chunks.push(c);
    }

    expect(mergeNeighboringTexts(chunks)).toEqual([
      { kind: "thinking", text: '<tool_call>\n{"name":"list_dir","arguments":{"path":"notes"}}\n' },
      { kind: "text", text: "그다음 " },
      { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
      { kind: "finish" },
    ]);
  });

  it("WO13A-P20 no-system-message", async () => {
    const { engine, requests } = makeEngineWithChunks([{ content: "ok" }]);
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["list_dir", "read_file"] });

    const t1 = { name: "list_dir", description: "List files and folders at a path in the user's ADK workspace.", parameters: { type: "object", properties: { path: { type: "string", description: "Path relative to the workspace root, for example AGENTS.md or notes/hello.md. Use exact names; hidden folders start with a dot." } }, required: ["path"] } };
    const t2 = { name: "read_file", description: "Read a text file in the user's ADK workspace.", parameters: { type: "object", properties: { path: { type: "string", description: "Path relative to the workspace root, for example AGENTS.md or notes/hello.md. Use exact names; hidden folders start with a dot." } }, required: ["path"] } };

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [t1, t2],
    })) {
      chunks.push(c);
    }

    const expectedToolsBlock = `# Tools

You may call one or more functions to assist with the user specification.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
${JSON.stringify({ type: "function", function: { name: t1.name, description: t1.description, parameters: t1.parameters } })}
${JSON.stringify({ type: "function", function: { name: t2.name, description: t2.description, parameters: t2.parameters } })}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>

Always reply in the same language as the user's latest message, even when the files or tool results you read are in another language.`;

    expect(requests[0]?.messages[0]).toEqual({
      role: "system",
      content: expectedToolsBlock,
    });
    expect(chunks).toEqual([
      { kind: "text", text: "ok" },
      { kind: "finish" },
    ]);
  });

  it("WO13A-P21 no-overlap", async () => {
    const text = '앞말 <tool_call>\n{"name":"read_file","arguments":{"path":"AGENTS.md"}}\n</tool_call>';
    const { engine, requests } = makeEngineWithChunks([{ content: text }]);
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["list_dir", "read_file"] });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "continue_speaking", description: "cs", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(requests[0]?.messages.some((m) => m.content.includes("<tools>"))).toBe(false);
    expect(mergeNeighboringTexts(chunks)).toEqual([
      { kind: "text", text },
      { kind: "finish" },
    ]);
  });

  it("WO13A-P10 대화 히스토리 변환 assistant(toolCalls) 및 tool 연속 메시지", async () => {
    const { engine, requests } = makeEngineWithChunks([{ content: "ok" }]);

    const history: ChatMessage[] = [
      { role: "user", content: "질문" },
      {
        role: "assistant",
        content: "생각",
        toolCalls: [
          { id: "call1", name: "list_dir", args: { path: "notes" } },
          { id: "call2", name: "read_file", args: { path: "AGENTS.md" } },
        ],
      },
      { role: "tool", toolCallId: "call1", content: "f a.md\nf b.md" },
      { role: "tool", toolCallId: "call2", content: "# Hello" },
    ];

    const expectedMessages = [
      { role: "user", content: "질문" },
      {
        role: "assistant",
        content: '생각\n<tool_call>\n{"name":"list_dir","arguments":{"path":"notes"}}\n</tool_call>\n<tool_call>\n{"name":"read_file","arguments":{"path":"AGENTS.md"}}\n</tool_call>',
      },
      {
        role: "user",
        content: '<tool_response>\nf a.md\nf b.md\n</tool_response>\n<tool_response>\n# Hello\n</tool_response>',
      },
    ];

    // 1. toolNames 없음
    const providerWithout = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });
    const chunksWithout: ProviderChunk[] = [];
    for await (const c of providerWithout.chat(defaultConfig, history, {})) {
      chunksWithout.push(c);
    }
    expect(requests[0]?.messages).toEqual(expectedMessages);
    expect(chunksWithout).toEqual([
      { kind: "text", text: "ok" },
      { kind: "finish" },
    ]);

    // 2. toolNames: BROWSER_READ_TOOL_NAMES 있음
    const providerWith = makeWebLLMProvider({
      getEngine: async () => engine,
      model: "m",
      toolNames: BROWSER_READ_TOOL_NAMES,
    });
    const chunksWith: ProviderChunk[] = [];
    for await (const c of providerWith.chat(defaultConfig, history, {})) {
      chunksWith.push(c);
    }
    expect(requests[1]?.messages).toEqual(expectedMessages);
    expect(chunksWith).toEqual([
      { kind: "text", text: "ok" },
      { kind: "finish" },
    ]);
  });

  it("WO13C-A1 tools-prompt-language", async () => {
    // 1. 도구가 있는 요청: 첫 system 메시지가 1-1 문장으로 끝남
    const { engine: engine1, requests: reqs1 } = makeEngineWithChunks([{ content: "ok" }]);
    const provider1 = makeWebLLMProvider({
      getEngine: async () => engine1,
      model: "m",
      toolNames: ["list_dir", "read_file"],
    });
    for await (const _ of provider1.chat(defaultConfig, [{ role: "user", content: "안녕" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {}
    const sys1 = reqs1[0]?.messages.find((m) => m.role === "system")?.content;
    expect(sys1).toBeDefined();
    expect(
      sys1?.endsWith(
        "Always reply in the same language as the user's latest message, even when the files or tool results you read are in another language.",
      ),
    ).toBe(true);

    // 2. 도구가 없는 요청: system 메시지에 그 문장이 없음
    const { engine: engine2, requests: reqs2 } = makeEngineWithChunks([{ content: "ok" }]);
    const provider2 = makeWebLLMProvider({
      getEngine: async () => engine2,
      model: "m",
      toolNames: ["list_dir", "read_file"],
    });
    for await (const _ of provider2.chat(
      defaultConfig,
      [{ role: "system", content: "당신은 도우미입니다." }, { role: "user", content: "안녕" }],
      {},
    )) {}
    const sys2 = reqs2[0]?.messages.find((m) => m.role === "system")?.content;
    expect(sys2).toBeDefined();
    expect(
      sys2?.includes(
        "Always reply in the same language as the user's latest message, even when the files or tool results you read are in another language.",
      ),
    ).toBe(false);
  });

  it("WO13D-K1 empty-think-dropped", async () => {
    const { engine } = makeEngineWithChunks([{ content: "<think>\n\n</think>\n\n답" }]);
    const provider = makeWebLLMProvider({
      getEngine: async () => engine,
      model: "m",
      toolNames: ["read_file"],
    });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(mergeSameKindChunks(chunks)).toEqual([
      { kind: "text", text: "\n\n답" },
      { kind: "finish" },
    ]);
    for (const c of chunks) {
      if (c.kind === "text" || c.kind === "thinking") {
        expect(c.text).not.toContain("<think>");
        expect(c.text).not.toContain("</think>");
      }
    }
  });

  it("WO13D-K2 think-to-thinking", async () => {
    const { engine } = makeEngineWithChunks([{ content: "<think>생각</think>답" }]);
    const provider = makeWebLLMProvider({
      getEngine: async () => engine,
      model: "m",
      toolNames: ["read_file"],
    });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(mergeSameKindChunks(chunks)).toEqual([
      { kind: "thinking", text: "생각" },
      { kind: "text", text: "답" },
      { kind: "finish" },
    ]);
  });

  const K3_BASE = "<think>\n생각\n</think>\n\n앞말 <tool_call>\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"AGENTS.md\"}}\n</tool_call>";
  const K3_SPLIT_CASES: Array<[number, string, string]> = [];
  for (let i = 1; i < K3_BASE.length; i++) {
    K3_SPLIT_CASES.push([i, K3_BASE.slice(0, i), K3_BASE.slice(i)]);
  }

  it.each(K3_SPLIT_CASES)("WO13D-K3 split@%s", async (_idx, p1, p2) => {
    const { engine } = makeEngineWithChunks([{ content: p1 }, { content: p2 }]);
    const provider = makeWebLLMProvider({
      getEngine: async () => engine,
      model: "m",
      toolNames: ["read_file"],
    });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(mergeSameKindChunks(chunks)).toEqual([
      { kind: "thinking", text: "\n생각\n" },
      { kind: "text", text: "\n\n앞말 " },
      { kind: "toolUse", id: "webllm-call-1-0", name: "read_file", args: { path: "AGENTS.md" } },
      { kind: "finish" },
    ]);
  });

  it("WO13D-K4 whitespace-then-text-in-think", async () => {
    const { engine } = makeEngineWithChunks([
      { content: "<think>\n\n" },
      { content: "  생각" },
      { content: "</think>답" },
    ]);
    const provider = makeWebLLMProvider({
      getEngine: async () => engine,
      model: "m",
      toolNames: ["read_file"],
    });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(mergeSameKindChunks(chunks)).toEqual([
      { kind: "thinking", text: "\n\n  생각" },
      { kind: "text", text: "답" },
      { kind: "finish" },
    ]);
  });

  it("WO13D-K5 no-tools-path", async () => {
    // 1. <think>\n\n</think>\n\n답
    {
      const { engine } = makeEngineWithChunks([{ content: "<think>\n\n</think>\n\n답" }]);
      const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });
      const chunks: ProviderChunk[] = [];
      for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {})) {
        chunks.push(c);
      }
      expect(mergeSameKindChunks(chunks)).toEqual([
        { kind: "text", text: "\n\n답" },
        { kind: "finish" },
      ]);
    }

    // 2. <think>생각</think>답
    {
      const { engine } = makeEngineWithChunks([{ content: "<think>생각</think>답" }]);
      const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });
      const chunks: ProviderChunk[] = [];
      for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {})) {
        chunks.push(c);
      }
      expect(mergeSameKindChunks(chunks)).toEqual([
        { kind: "thinking", text: "생각" },
        { kind: "text", text: "답" },
        { kind: "finish" },
      ]);
    }
  });

  it("WO13D-K6 stray-tags", async () => {
    const { engine } = makeEngineWithChunks([{ content: "<think>가<think>나</think>다</think>라" }]);
    const provider = makeWebLLMProvider({
      getEngine: async () => engine,
      model: "m",
      toolNames: ["read_file"],
    });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(mergeSameKindChunks(chunks)).toEqual([
      { kind: "thinking", text: "가나" },
      { kind: "text", text: "다라" },
      { kind: "finish" },
    ]);
  });

  it("WO13D-K7 unclosed-at-eof", async () => {
    // 1. 도구 있음: 앞<think>생각
    {
      const { engine } = makeEngineWithChunks([{ content: "앞<think>생각" }]);
      const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });
      const chunks: ProviderChunk[] = [];
      for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
        tools: [{ name: "read_file", description: "rf", parameters: {} }],
      })) {
        chunks.push(c);
      }
      expect(mergeSameKindChunks(chunks)).toEqual([
        { kind: "text", text: "앞" },
        { kind: "thinking", text: "생각" },
        { kind: "finish" },
      ]);
    }

    // 2. 도구 있음: 앞<think>  
    {
      const { engine } = makeEngineWithChunks([{ content: "앞<think>  " }]);
      const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m", toolNames: ["read_file"] });
      const chunks: ProviderChunk[] = [];
      for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
        tools: [{ name: "read_file", description: "rf", parameters: {} }],
      })) {
        chunks.push(c);
      }
      expect(mergeSameKindChunks(chunks)).toEqual([
        { kind: "text", text: "앞" },
        { kind: "finish" },
      ]);
    }

    // 3. 도구 없음: 앞<think>생각
    {
      const { engine } = makeEngineWithChunks([{ content: "앞<think>생각" }]);
      const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });
      const chunks: ProviderChunk[] = [];
      for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {})) {
        chunks.push(c);
      }
      expect(mergeSameKindChunks(chunks)).toEqual([
        { kind: "text", text: "앞" },
        { kind: "thinking", text: "생각" },
        { kind: "finish" },
      ]);
    }

    // 4. 도구 없음: 앞<think>  
    {
      const { engine } = makeEngineWithChunks([{ content: "앞<think>  " }]);
      const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });
      const chunks: ProviderChunk[] = [];
      for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {})) {
        chunks.push(c);
      }
      expect(mergeSameKindChunks(chunks)).toEqual([
        { kind: "text", text: "앞" },
        { kind: "finish" },
      ]);
    }
  });

  it("WO13D-K8 bracket-tag-untouched", async () => {
    const { engine } = makeEngineWithChunks([{ content: "[THINK]\n답" }]);
    const provider = makeWebLLMProvider({
      getEngine: async () => engine,
      model: "m",
      toolNames: ["read_file"],
    });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(mergeSameKindChunks(chunks)).toEqual([
      { kind: "text", text: "[THINK]\n답" },
      { kind: "finish" },
    ]);
  });

  const K9_BASE = "<think>\n생각\n</think>\n\n답";
  const K9_SPLIT_CASES: Array<[number, string, string]> = [];
  for (let i = 1; i < K9_BASE.length; i++) {
    K9_SPLIT_CASES.push([i, K9_BASE.slice(0, i), K9_BASE.slice(i)]);
  }

  it.each(K9_SPLIT_CASES)("WO13D-K9 split@%s", async (_idx, p1, p2) => {
    const { engine } = makeEngineWithChunks([{ content: p1 }, { content: p2 }]);
    const provider = makeWebLLMProvider({
      getEngine: async () => engine,
      model: "m",
    });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {})) {
      chunks.push(c);
    }

    expect(mergeSameKindChunks(chunks)).toEqual([
      { kind: "thinking", text: "\n생각\n" },
      { kind: "text", text: "\n\n답" },
      { kind: "finish" },
    ]);
  });

  it("WO13D-K10 parse-fail-fallback", async () => {
    const { engine } = makeEngineWithChunks([{ content: "<tool_call>bad</tool_call><think>x</think>" }]);
    const provider = makeWebLLMProvider({
      getEngine: async () => engine,
      model: "m",
      toolNames: ["read_file"],
    });

    const chunks: ProviderChunk[] = [];
    for await (const c of provider.chat(defaultConfig, [{ role: "user", content: "hi" }], {
      tools: [{ name: "read_file", description: "rf", parameters: {} }],
    })) {
      chunks.push(c);
    }

    expect(mergeSameKindChunks(chunks)).toEqual([
      { kind: "text", text: "<tool_call>bad</tool_call>" },
      { kind: "thinking", text: "x" },
      { kind: "finish" },
    ]);
    for (const c of chunks) {
      if (c.kind === "text" || c.kind === "thinking") {
        expect(c.text).not.toContain("<think>");
        expect(c.text).not.toContain("</think>");
      }
    }
  });
});


