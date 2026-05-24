import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "@nextain/agent-types";

export interface StreamPlayerFixture {
  chunks: LLMStreamChunk[];
  response?: LLMResponse;
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
