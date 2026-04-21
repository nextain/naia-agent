import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  LLMContentBlock,
  StopReason,
} from "@nextain/agent-types";

export interface MockScript {
  /**
   * A scripted response per `generate()`/`stream()` call. Indexed by call
   * count (0-based). If fewer scripts than calls, the last is reused.
   */
  turns: MockTurn[];
}

export interface MockTurn {
  /** Blocks to emit. text → single text block; array → pass through. */
  blocks: string | LLMContentBlock[];
  /** stopReason for this turn. Default "end_turn". */
  stopReason?: StopReason;
  /** Usage for this turn. Defaults to tiny fake numbers. */
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * MockLLMClient — fully scripted LLMClient. Useful for tests and examples.
 * Does NOT actually call any network. Respects AbortSignal.
 */
export class MockLLMClient implements LLMClient {
  readonly #script: MockScript;
  #callCount = 0;

  constructor(script: MockScript) {
    this.#script = script;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    void request;
    const turn = this.#nextTurn();
    return {
      id: `mock-${this.#callCount}`,
      model: request.model ?? "mock-model",
      content: this.#materializeBlocks(turn.blocks),
      stopReason: turn.stopReason ?? "end_turn",
      usage: turn.usage ?? { inputTokens: 10, outputTokens: 5 },
    };
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    if (request.signal?.aborted) return;
    const turn = this.#nextTurn();
    const blocks = this.#materializeBlocks(turn.blocks);
    const stopReason = turn.stopReason ?? "end_turn";
    const usage = turn.usage ?? { inputTokens: 10, outputTokens: 5 };

    yield { type: "start", id: `mock-${this.#callCount}`, model: request.model ?? "mock-model" };

    for (let i = 0; i < blocks.length; i++) {
      if (request.signal?.aborted) return;
      const block = blocks[i];
      if (!block) continue;
      yield { type: "content_block_start", index: i, block };
      if (block.type === "text") {
        // Single chunk — tests do not need fine-grained simulation.
        yield { type: "content_block_delta", index: i, delta: { type: "text_delta", text: "" } };
      } else if (block.type === "tool_use") {
        yield {
          type: "content_block_delta",
          index: i,
          delta: { type: "input_json_delta", partialJson: JSON.stringify(block.input) },
        };
      }
      yield { type: "content_block_stop", index: i };
    }

    yield { type: "end", stopReason, usage };
  }

  #nextTurn(): MockTurn {
    const idx = Math.min(this.#callCount, this.#script.turns.length - 1);
    this.#callCount++;
    const turn = this.#script.turns[idx];
    if (!turn) throw new Error("MockLLMClient: empty script");
    return turn;
  }

  #materializeBlocks(blocks: string | LLMContentBlock[]): LLMContentBlock[] {
    if (typeof blocks === "string") return [{ type: "text", text: blocks }];
    return blocks;
  }
}
