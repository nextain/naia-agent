/**
 * src/test/webllm-provider.contract.test.ts
 * WebLLM 공급자 어댑터 계약 및 동작 검증 시험 (FE-08, FE-10).
 */

import { describe, it, expect } from "vitest";
import {
  makeWebLLMProvider,
  type WebLLMEngineLike,
  type WebLLMChatRequest,
  type WebLLMChatChunk,
} from "../main/adapters/webllm-provider.js";
import { resolveProviderRoute } from "../main/domain/provider-route.js";
import { makeProviderResolver } from "../main/adapters/provider-resolver.js";
import { startBrowserAgent } from "../main/composition/browser-agent.js";
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

  it("지원하지 않는 메시지: tool role, toolCalls, inlineImages 각각 거부", async () => {
    const engine = new FakeWebLLMEngine();
    const provider = makeWebLLMProvider({ getEngine: async () => engine, model: "m" });

    // role: "tool"
    await expect(async () => {
      for await (const _ of provider.chat(defaultConfig, [{ role: "tool", content: "res" }], {})) {}
    }).rejects.toThrow(/webllm: 지원하지 않는 메시지/);

    // assistant with toolCalls
    await expect(async () => {
      for await (const _ of provider.chat(
        defaultConfig,
        [{ role: "assistant", content: "", toolCalls: [{ id: "1", name: "f", args: {} }] }],
        {},
      )) {}
    }).rejects.toThrow(/webllm: 지원하지 않는 메시지/);

    // user with inlineImages
    await expect(async () => {
      for await (const _ of provider.chat(
        defaultConfig,
        [{ role: "user", content: "img", inlineImages: [{ mimeType: "image/png", data: "abc" }] }],
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
});
