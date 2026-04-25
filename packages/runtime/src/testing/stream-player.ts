// Slice 1b sub-5 — StreamPlayer (minimal fixture-replay).
//
// Plays back a recorded LLM stream as an LLMClient. Used in tests to make
// agent behavior deterministic without real network calls (matrix C21 →
// formal package in Slice 5; this is the minimal pin to unblock 1b).
//
// Fixture format (JSON-serializable): { chunks: LLMStreamChunk[]; response?: LLMResponse }.
// `generate()` is supported when `response` is provided; otherwise throws.

import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "@nextain/agent-types";

export interface StreamPlayerFixture {
  /** Sequential chunks emitted by stream(). Order preserved exactly. */
  chunks: LLMStreamChunk[];
  /** Optional non-stream response (for generate()). Most tests use stream. */
  response?: LLMResponse;
  /** Optional metadata — not consumed by Player, useful for debugging. */
  meta?: {
    recordedAt?: string;
    sdkVersion?: string;
    model?: string;
    notes?: string;
  };
}

export class StreamPlayer implements LLMClient {
  readonly #fixture: StreamPlayerFixture;
  #callCount = 0;

  constructor(fixture: StreamPlayerFixture) {
    this.#fixture = fixture;
  }

  get callCount(): number {
    return this.#callCount;
  }

  async generate(_request: LLMRequest): Promise<LLMResponse> {
    void _request;
    this.#callCount++;
    if (!this.#fixture.response) {
      throw new Error(
        "StreamPlayer.generate(): fixture has no `response`. Use stream() or provide a response.",
      );
    }
    return this.#fixture.response;
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    this.#callCount++;
    for (const chunk of this.#fixture.chunks) {
      if (request.signal?.aborted) return;
      yield chunk;
    }
  }
}
