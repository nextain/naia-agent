/**
 * adapters/webllm-provider — WebLLM 엔진을 주입받는 ProviderPort 어댑터 (FE-08).
 *
 * 모델 식별자 정책:
 * - config.model 은 셸 UI 표시용이며 실제 요청에는 쓰이지 않는다. 실제 요청의 model 은
 *   어댑터 생성 시 deps.model 로 지정된 값이 사용된다 (웹 환경에는 로컬 엔진 인스턴스가
 *   하나뿐이며 이미 엔진에 올라간 모델 id 를 전송해야 함).
 *
 * 직렬화 및 단일 인스턴스 정책:
 * - 같은 WebLLM 엔진을 쓰는 공급자 인스턴스는 하나여야 한다.
 * - WebLLM 엔진의 interruptGenerate() 는 엔진 전체에 적용되는 단일 인터럽트 플래그를 세우므로,
 *   요청 간 취소 간섭을 방지하기 위해 공급자 내부에서 단일 실행 슬롯(SlotLock)으로 요청을
 *   들어온 순서대로 직렬화한다.
 */

import type { ProviderConfig, ChatMessage, ProviderChunk } from "../domain/chat.js";
import type { ProviderPort, ProviderChatOpts } from "../ports/uc1.js";

export interface WebLLMChatMessage { readonly role: "system" | "user" | "assistant"; readonly content: string }
export interface WebLLMChatRequest {
  readonly model?: string;
  readonly messages: WebLLMChatMessage[];
  readonly stream: true;
  readonly stream_options?: { readonly include_usage: boolean };
  readonly temperature?: number;
  readonly extra_body?: { readonly enable_thinking?: boolean };
}
export interface WebLLMChatChunk {
  readonly choices: ReadonlyArray<{ readonly delta: { readonly content?: string | null }; readonly finish_reason: string | null }>;
  readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number } | null;
}
export interface WebLLMEngineLike {
  readonly chat: { readonly completions: { create(req: WebLLMChatRequest): Promise<AsyncIterable<WebLLMChatChunk>> } };
  interruptGenerate(): void | Promise<void>;
}

class SlotLock {
  private tail: Promise<void> = Promise.resolve();

  async acquire(signal?: AbortSignal): Promise<{ release: () => void; acquired: boolean }> {
    if (signal?.aborted) {
      return { release: () => {}, acquired: false };
    }

    let releaseSlot!: () => void;
    let isReleased = false;
    const nextPromise = new Promise<void>((resolve) => {
      releaseSlot = () => {
        if (!isReleased) {
          isReleased = true;
          resolve();
        }
      };
    });

    const previousTail = this.tail;
    this.tail = nextPromise;

    if (!signal) {
      await previousTail;
      return { release: releaseSlot, acquired: true };
    }

    let abortListener: (() => void) | undefined;
    const abortPromise = new Promise<"aborted">((resolve) => {
      abortListener = () => resolve("aborted");
      signal.addEventListener("abort", abortListener, { once: true });
    });

    const result = await Promise.race([
      previousTail.then(() => "acquired" as const),
      abortPromise,
    ]);

    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }

    if (result === "aborted") {
      void previousTail.finally(() => {
        releaseSlot();
      });
      return { release: () => {}, acquired: false };
    }

    return { release: releaseSlot, acquired: true };
  }
}

export function makeWebLLMProvider(deps: {
  getEngine: () => Promise<WebLLMEngineLike>;
  model: string;
}): ProviderPort {
  const slotLock = new SlotLock();

  return {
    async *chat(
      config: ProviderConfig,
      messages: readonly ChatMessage[],
      opts: ProviderChatOpts,
    ): AsyncIterable<ProviderChunk> {
      // 1. 지원하지 않는 입력 사전 검증
      for (const m of messages) {
        if (m.role === "tool") {
          throw new Error("webllm: 지원하지 않는 메시지(tool)");
        }
        if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
          throw new Error("webllm: 지원하지 않는 메시지(toolCalls)");
        }
        if ((m.inlineImages && m.inlineImages.length > 0) || (m.attachments && m.attachments.length > 0)) {
          throw new Error("webllm: 지원하지 않는 메시지(inlineImages)");
        }
      }

      // 2. 시작 전 취소 확인
      if (opts.signal?.aborted) {
        return;
      }

      // 3. 메시지 변환
      const systemParts: string[] = [];
      if (opts.systemPrompt !== undefined && opts.systemPrompt !== "") {
        systemParts.push(opts.systemPrompt);
      }
      for (const m of messages) {
        if (m.role === "system" && m.content) {
          systemParts.push(m.content);
        }
      }

      const convertedMessages: WebLLMChatMessage[] = [];
      if (systemParts.length > 0) {
        convertedMessages.push({
          role: "system",
          content: systemParts.join("\n\n"),
        });
      }
      for (const m of messages) {
        if (m.role === "user" || m.role === "assistant") {
          convertedMessages.push({
            role: m.role,
            content: m.content,
          });
        }
      }

      // 4. 요청 객체 조립
      const extra_body = (config.enableThinking !== undefined && deps.model.startsWith("Qwen3"))
        ? { enable_thinking: config.enableThinking }
        : undefined;

      const req: WebLLMChatRequest = {
        model: deps.model,
        messages: convertedMessages,
        stream: true,
        stream_options: { include_usage: true },
        ...(extra_body !== undefined ? { extra_body } : {}),
      };

      // 5. 실행 슬롯 획득
      const { release, acquired } = await slotLock.acquire(opts.signal);
      if (!acquired) {
        return;
      }

      let slotReleased = false;
      const releaseSlotOnce = () => {
        if (!slotReleased) {
          slotReleased = true;
          release();
        }
      };

      const ABORTED = Symbol("aborted");
      let abortResolver: (() => void) | undefined;
      const abortP = new Promise<typeof ABORTED>((resolve) => {
        if (opts.signal?.aborted) {
          resolve(ABORTED);
          return;
        }
        abortResolver = () => resolve(ABORTED);
        opts.signal?.addEventListener("abort", abortResolver, { once: true });
      });

      const removeAbortListener = () => {
        if (abortResolver && opts.signal) {
          opts.signal.removeEventListener("abort", abortResolver);
          abortResolver = undefined;
        }
      };

      // 6. 엔진 획득
      let enginePromise: Promise<WebLLMEngineLike>;
      try {
        enginePromise = deps.getEngine();
      } catch (err: unknown) {
        removeAbortListener();
        releaseSlotOnce();
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`webllm 엔진 준비 실패: ${msg}`);
      }

      const engineRace = await Promise.race([
        enginePromise.then(
          (eng) => ({ ok: true as const, eng }),
          (err: unknown) => ({ ok: false as const, err }),
        ),
        abortP,
      ]);

      if (engineRace === ABORTED) {
        removeAbortListener();
        releaseSlotOnce();
        return;
      }

      if (!engineRace.ok) {
        removeAbortListener();
        releaseSlotOnce();
        const msg = engineRace.err instanceof Error ? engineRace.err.message : String(engineRace.err);
        throw new Error(`webllm 엔진 준비 실패: ${msg}`);
      }

      const engine = engineRace.eng;

      // 7. create() 호출
      let createPromise: Promise<AsyncIterable<WebLLMChatChunk>>;
      try {
        createPromise = engine.chat.completions.create(req);
      } catch (err: unknown) {
        removeAbortListener();
        releaseSlotOnce();
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`webllm 요청 실패: ${msg}`);
      }

      const createRace = await Promise.race([
        createPromise.then(
          (stream) => ({ ok: true as const, stream }),
          (err: unknown) => ({ ok: false as const, err }),
        ),
        abortP,
      ]);

      if (createRace === ABORTED) {
        removeAbortListener();
        void (async () => {
          try {
            const lateStream = await createPromise;
            const lateIt = lateStream[Symbol.asyncIterator]();
            await drainStream(engine, lateIt, false, false, null);
          } catch {
            // create 거부 시 오류 버림
          } finally {
            releaseSlotOnce();
          }
        })();
        return;
      }

      if (!createRace.ok) {
        removeAbortListener();
        releaseSlotOnce();
        const msg = createRace.err instanceof Error ? createRace.err.message : String(createRace.err);
        throw new Error(`webllm 요청 실패: ${msg}`);
      }

      const stream = createRace.stream;
      const engineIt = stream[Symbol.asyncIterator]();

      // 8. 스트림 소비 및 정리
      let engineNextCalled = false;
      let interruptCalled = false;
      let pendingEngineNext: Promise<IteratorResult<WebLLMChatChunk>> | null = null;

      const callInterruptOnce = () => {
        if (!interruptCalled) {
          interruptCalled = true;
          try {
            void engine.interruptGenerate();
          } catch {
            // ignore
          }
        }
      };

      const onAbortSignal = () => {
        if (engineNextCalled) {
          callInterruptOnce();
        }
      };
      opts.signal?.addEventListener("abort", onAbortSignal);

      async function drainStream(
        eng: WebLLMEngineLike,
        it: AsyncIterator<WebLLMChatChunk>,
        initialNextCalled: boolean,
        initialInterruptCalled: boolean,
        pendingNext: Promise<IteratorResult<WebLLMChatChunk>> | null,
      ): Promise<void> {
        let nCalled = initialNextCalled;
        let iCalled = initialInterruptCalled;
        let curPending = pendingNext;

        if (!nCalled) {
          nCalled = true;
          try {
            curPending = it.next();
          } catch {
            return;
          }
        }

        if (!iCalled) {
          iCalled = true;
          try {
            void eng.interruptGenerate();
          } catch {
            // ignore
          }
        }

        try {
          if (curPending) {
            const res = await curPending;
            if (res.done) return;
          }
          while (true) {
            const res = await it.next();
            if (res.done) break;
          }
        } catch {
          // 소진 중 오류 무시
        }
      }

      let normalDone = false;
      try {
        while (true) {
          if (opts.signal?.aborted) {
            return;
          }

          engineNextCalled = true;
          const nextP = engineIt.next();
          pendingEngineNext = nextP;

          const nextRace = await Promise.race([
            nextP.then(
              (res) => ({ ok: true as const, res }),
              (err: unknown) => ({ ok: false as const, err }),
            ),
            abortP,
          ]);

          if (nextRace === ABORTED) {
            callInterruptOnce();
            return;
          }

          pendingEngineNext = null;

          if (!nextRace.ok) {
            releaseSlotOnce();
            const msg = nextRace.err instanceof Error ? nextRace.err.message : String(nextRace.err);
            throw new Error(`webllm 스트림 오류: ${msg}`);
          }

          const { done, value } = nextRace.res;
          if (done) {
            normalDone = true;
            yield { kind: "finish" };
            return;
          }

          const choice = value.choices?.[0];
          const content = choice?.delta?.content;
          if (content !== undefined && content !== null && content !== "") {
            yield { kind: "text", text: content };
          }

          if (value.usage) {
            yield {
              kind: "usage",
              inputTokens: value.usage.prompt_tokens,
              outputTokens: value.usage.completion_tokens,
            };
          }
        }
      } finally {
        removeAbortListener();
        opts.signal?.removeEventListener("abort", onAbortSignal);

        if (normalDone || slotReleased) {
          if (!slotReleased) {
            releaseSlotOnce();
          }
        } else {
          const curNext = pendingEngineNext;
          const nCalled = engineNextCalled;
          const iCalled = interruptCalled;
          void (async () => {
            try {
              await drainStream(engine, engineIt, nCalled, iCalled, curNext);
            } finally {
              releaseSlotOnce();
            }
          })();
        }
      }
    },
  };
}
