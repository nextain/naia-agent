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

const WATCH_TAGS = ["<tool_call>", "</tool_call>", "<think>", "</think>"] as const;
const MAX_TAG_LEN = 12;

function findTrailingPartialTag(str: string): number {
  const maxCheck = Math.min(str.length, MAX_TAG_LEN - 1);
  for (let len = maxCheck; len >= 1; len--) {
    const sub = str.slice(str.length - len);
    for (const tag of WATCH_TAGS) {
      if (tag.startsWith(sub) && sub !== tag) {
        return str.length - len;
      }
    }
  }
  return -1;
}

interface ParsedCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

function parseCapturedCalls(
  held: string,
  allowedNames: readonly string[],
): { readonly success: true; readonly calls: readonly ParsedCall[] } | { readonly success: false } {
  let idx = 0;
  let inThinking = false;
  let hasUnclosed = false;
  const outsideBlocks: string[] = [];

  while (idx < held.length) {
    if (!inThinking) {
      const nextToolCall = held.indexOf("<tool_call>", idx);
      const nextThink = held.indexOf("<think>", idx);
      const nextCloseThink = held.indexOf("</think>", idx);

      const candidates = [
        { type: "tool_call" as const, pos: nextToolCall },
        { type: "think" as const, pos: nextThink },
        { type: "close_think" as const, pos: nextCloseThink },
      ]
        .filter((c) => c.pos !== -1)
        .sort((a, b) => a.pos - b.pos);

      if (candidates.length === 0) {
        break;
      }

      const first = candidates[0]!;
      if (first.type === "tool_call") {
        const closeIdx = held.indexOf("</tool_call>", first.pos + 11);
        if (closeIdx === -1) {
          hasUnclosed = true;
          break;
        }
        const body = held.slice(first.pos + 11, closeIdx);
        outsideBlocks.push(body);
        idx = closeIdx + 12;
      } else if (first.type === "think") {
        inThinking = true;
        idx = first.pos + 7;
      } else if (first.type === "close_think") {
        idx = first.pos + 8;
      }
    } else {
      const nextCloseThink = held.indexOf("</think>", idx);
      if (nextCloseThink === -1) {
        break;
      }
      inThinking = false;
      idx = nextCloseThink + 8;
    }
  }

  if (hasUnclosed || outsideBlocks.length === 0) {
    return { success: false };
  }

  const calls: ParsedCall[] = [];
  for (const block of outsideBlocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      return { success: false };
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { success: false };
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.name !== "string" || !allowedNames.includes(obj.name)) {
      return { success: false };
    }
    if (
      typeof obj.arguments !== "object" ||
      obj.arguments === null ||
      Array.isArray(obj.arguments)
    ) {
      return { success: false };
    }
    calls.push({ name: obj.name, args: obj.arguments as Record<string, unknown> });
  }

  return { success: true, calls };
}

export function makeWebLLMProvider(deps: {
  getEngine: () => Promise<WebLLMEngineLike>;
  model: string;
  toolNames?: readonly string[];
}): ProviderPort {
  const slotLock = new SlotLock();
  let requestCounter = 0;

  return {
    async *chat(
      config: ProviderConfig,
      messages: readonly ChatMessage[],
      opts: ProviderChatOpts,
    ): AsyncIterable<ProviderChunk> {
      const requestNumber = ++requestCounter;

      // 1. 지원하지 않는 입력 사전 검증 (inlineImages / attachments 만 거부)
      for (const m of messages) {
        if ((m.inlineImages && m.inlineImages.length > 0) || (m.attachments && m.attachments.length > 0)) {
          throw new Error("webllm: 지원하지 않는 메시지(inlineImages)");
        }
      }

      // 2. 시작 전 취소 확인
      if (opts.signal?.aborted) {
        return;
      }

      // 쓸 도구 집합: opts.tools 가운데 이름이 toolNames 에 든 것뿐 (순서는 opts.tools 순서)
      const activeTools = (deps.toolNames && deps.toolNames.length > 0 && opts.tools && opts.tools.length > 0)
        ? opts.tools.filter((t) => deps.toolNames!.includes(t.name))
        : [];

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

      if (activeTools.length > 0) {
        const toolLines = activeTools.map((t) =>
          JSON.stringify({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })
        ).join("\n");

        const toolsPrompt = `# Tools

You may call one or more functions to assist with the user specification.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
${toolLines}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>

Always reply in the same language as the user's latest message, even when the files or tool results you read are in another language.`;

        systemParts.push(toolsPrompt);
      }

      const convertedMessages: WebLLMChatMessage[] = [];
      if (systemParts.length > 0) {
        convertedMessages.push({
          role: "system",
          content: systemParts.join("\n\n"),
        });
      }

      let msgIdx = 0;
      while (msgIdx < messages.length) {
        const m = messages[msgIdx]!;
        if (m.role === "system") {
          msgIdx++;
          continue;
        }
        if (m.role === "user") {
          convertedMessages.push({
            role: "user",
            content: m.content,
          });
          msgIdx++;
          continue;
        }
        if (m.role === "assistant") {
          let content = m.content ?? "";
          if (m.toolCalls && m.toolCalls.length > 0) {
            for (const call of m.toolCalls) {
              content += `\n<tool_call>\n${JSON.stringify({ name: call.name, arguments: call.args })}\n</tool_call>`;
            }
          }
          convertedMessages.push({
            role: "assistant",
            content,
          });
          msgIdx++;
          continue;
        }
        if (m.role === "tool") {
          const toolBlocks: string[] = [];
          while (msgIdx < messages.length && messages[msgIdx]!.role === "tool") {
            const tm = messages[msgIdx]!;
            toolBlocks.push(`<tool_response>\n${tm.content}\n</tool_response>`);
            msgIdx++;
          }
          convertedMessages.push({
            role: "user",
            content: toolBlocks.join("\n"),
          });
          continue;
        }
        msgIdx++;
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
        if (!engineNextCalled) {
          return;
        }
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

      let abortListenersRemoved = false;
      const removeAllAbortListeners = () => {
        if (!abortListenersRemoved) {
          abortListenersRemoved = true;
          removeAbortListener();
          if (opts.signal) {
            opts.signal.removeEventListener("abort", onAbortSignal);
          }
        }
      };

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

      let inThinking = false;
      let capturing = false;
      let pendingBuffer = "";
      let heldContent = "";
      const allowedToolNames = activeTools.map((t) => t.name);

      function* feedDelta(delta: string): Generator<ProviderChunk> {
        if (capturing) {
          heldContent += delta;
          return;
        }

        pendingBuffer += delta;

        while (pendingBuffer.length > 0) {
          if (!inThinking) {
            const idxTool = pendingBuffer.indexOf("<tool_call>");
            const idxThink = pendingBuffer.indexOf("<think>");
            const idxCloseThink = pendingBuffer.indexOf("</think>");

            const candidates = [
              { type: "tool_call" as const, pos: idxTool },
              { type: "think" as const, pos: idxThink },
              { type: "close_think" as const, pos: idxCloseThink },
            ]
              .filter((c) => c.pos !== -1)
              .sort((a, b) => a.pos - b.pos);

            if (candidates.length > 0) {
              const first = candidates[0]!;
              if (first.type === "tool_call") {
                if (first.pos > 0) {
                  yield { kind: "text", text: pendingBuffer.slice(0, first.pos) };
                }
                capturing = true;
                heldContent = pendingBuffer.slice(first.pos);
                pendingBuffer = "";
                return;
              } else if (first.type === "think") {
                const endPos = first.pos + 7;
                yield { kind: "text", text: pendingBuffer.slice(0, endPos) };
                inThinking = true;
                pendingBuffer = pendingBuffer.slice(endPos);
                continue;
              } else if (first.type === "close_think") {
                const endPos = first.pos + 8;
                yield { kind: "text", text: pendingBuffer.slice(0, endPos) };
                inThinking = false;
                pendingBuffer = pendingBuffer.slice(endPos);
                continue;
              }
            }

            const partialIdx = findTrailingPartialTag(pendingBuffer);
            if (partialIdx !== -1) {
              if (partialIdx > 0) {
                yield { kind: "text", text: pendingBuffer.slice(0, partialIdx) };
                pendingBuffer = pendingBuffer.slice(partialIdx);
              }
              return;
            } else {
              yield { kind: "text", text: pendingBuffer };
              pendingBuffer = "";
              return;
            }
          } else {
            const idxCloseThink = pendingBuffer.indexOf("</think>");
            const idxThink = pendingBuffer.indexOf("<think>");

            const candidates = [
              { type: "close_think" as const, pos: idxCloseThink },
              { type: "think" as const, pos: idxThink },
            ]
              .filter((c) => c.pos !== -1)
              .sort((a, b) => a.pos - b.pos);

            if (candidates.length > 0) {
              const first = candidates[0]!;
              if (first.type === "close_think") {
                const endPos = first.pos + 8;
                yield { kind: "text", text: pendingBuffer.slice(0, endPos) };
                inThinking = false;
                pendingBuffer = pendingBuffer.slice(endPos);
                continue;
              } else if (first.type === "think") {
                const endPos = first.pos + 7;
                yield { kind: "text", text: pendingBuffer.slice(0, endPos) };
                pendingBuffer = pendingBuffer.slice(endPos);
                continue;
              }
            }

            const partialIdx = findTrailingPartialTag(pendingBuffer);
            if (partialIdx !== -1) {
              if (partialIdx > 0) {
                yield { kind: "text", text: pendingBuffer.slice(0, partialIdx) };
                pendingBuffer = pendingBuffer.slice(partialIdx);
              }
              return;
            } else {
              yield { kind: "text", text: pendingBuffer };
              pendingBuffer = "";
              return;
            }
          }
        }
      }

      let normalDone = false;
      try {
        while (true) {
          if (opts.signal?.aborted) {
            callInterruptOnce();
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
            removeAllAbortListeners();
            releaseSlotOnce();
            if (opts.signal?.aborted) {
              return;
            }

            if (activeTools.length === 0) {
              yield { kind: "finish" };
              return;
            }

            if (!capturing) {
              if (pendingBuffer.length > 0) {
                yield { kind: "text", text: pendingBuffer };
              }
              yield { kind: "finish" };
              return;
            }

            const parsed = parseCapturedCalls(heldContent, allowedToolNames);
            if (parsed.success) {
              for (let bIdx = 0; bIdx < parsed.calls.length; bIdx++) {
                const call = parsed.calls[bIdx]!;
                yield {
                  kind: "toolUse",
                  id: `webllm-call-${requestNumber}-${bIdx}`,
                  name: call.name,
                  args: call.args,
                };
              }
            } else {
              yield { kind: "text", text: heldContent };
            }

            yield { kind: "finish" };
            return;
          }

          const choice = value.choices?.[0];
          const content = choice?.delta?.content;
          if (content !== undefined && content !== null && content !== "") {
            if (activeTools.length === 0) {
              if (opts.signal?.aborted) {
                callInterruptOnce();
                return;
              }
              yield { kind: "text", text: content };
            } else {
              for (const chunk of feedDelta(content)) {
                if (opts.signal?.aborted) {
                  callInterruptOnce();
                  return;
                }
                yield chunk;
              }
            }
          }

          if (value.usage) {
            if (opts.signal?.aborted) {
              callInterruptOnce();
              return;
            }
            yield {
              kind: "usage",
              inputTokens: value.usage.prompt_tokens,
              outputTokens: value.usage.completion_tokens,
            };
          }
        }
      } finally {
        removeAllAbortListeners();

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
