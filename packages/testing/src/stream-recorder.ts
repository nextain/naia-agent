import type { LLMClient, LLMRequest, LLMResponse, LLMStreamChunk } from "@nextain/agent-types";
import type { StreamPlayerFixture } from "./stream-player.js";

export interface StreamRecorderOptions {
  llm: LLMClient;
  meta?: StreamPlayerFixture["meta"];
}

export class StreamRecorder implements LLMClient {
  readonly #inner: LLMClient;
  readonly #meta: StreamPlayerFixture["meta"];
  #recordings: StreamPlayerFixture[] = [];

  constructor(opts: StreamRecorderOptions) {
    this.#inner = opts.llm;
    this.#meta = opts.meta;
  }

  get recordings(): readonly StreamPlayerFixture[] {
    return this.#recordings;
  }

  get lastRecording(): StreamPlayerFixture | undefined {
    return this.#recordings[this.#recordings.length - 1];
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const response = await this.#inner.generate(request);
    this.#recordings.push({
      chunks: [],
      response,
      meta: { ...this.#meta, recordedAt: new Date().toISOString() },
    });
    return response;
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of this.#inner.stream(request)) {
      chunks.push(chunk);
      yield chunk;
    }
    this.#recordings.push({
      chunks,
      meta: { ...this.#meta, recordedAt: new Date().toISOString() },
    });
  }

  toJSON(): StreamPlayerFixture[] {
    return this.#recordings;
  }

  reset(): void {
    this.#recordings = [];
  }
}
