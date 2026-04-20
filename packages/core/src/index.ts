export interface LLMClient {
  generate(request: unknown): Promise<unknown>;
}

export const VERSION = "0.0.0";
