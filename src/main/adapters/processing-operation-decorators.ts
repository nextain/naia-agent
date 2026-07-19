import { AsyncLocalStorage } from "node:async_hooks";
import type { ProviderChunk } from "../domain/chat.js";
import type {
  ProviderPort,
  ProviderResolverPort,
  ToolExecutorPort,
} from "../ports/uc1.js";
import type {
  ProcessingOperation,
  ProcessingRequestContext,
} from "../ports/processing.js";

const requestContext = new AsyncLocalStorage<ProcessingRequestContext>();

/** Bind authorization only for the lifetime of one request's async call tree. */
export function runWithProcessingRequestContext<T>(
  context: ProcessingRequestContext,
  action: () => Promise<T>,
): Promise<T> {
  return requestContext.run(context, action);
}

/** External/background work without a bound request fails closed. */
export function ensureCurrentProcessingAuthorized(
  operation: ProcessingOperation,
): Promise<void> {
  const context = requestContext.getStore();
  return context
    ? context.ensureAuthorized(operation)
    : Promise.reject(new Error("PROCESSING_REQUEST_CONTEXT_REQUIRED"));
}

export interface TrustedProviderOperation {
  readonly endpointUrl: string;
  readonly endpointZone: "unverified" | "private_managed";
  readonly requiresConsent: boolean;
}

/**
 * The provider adapter, not ChatTurnHandler, declares main_llm metadata.
 * Authorization occurs when iteration begins, immediately before delegate.chat.
 */
export function makeProcessingAwareProvider(
  delegate: ProviderPort,
  trusted: TrustedProviderOperation,
  nextOperationKey?: () => string,
): ProviderPort {
  let callSequence = 0;
  return {
    async *chat(config, messages, opts): AsyncIterable<ProviderChunk> {
      await ensureCurrentProcessingAuthorized({
        operationKey: opts.processingOperationKey
          ?? nextOperationKey?.()
          ?? `main_llm:call:${++callSequence}`,
        workload: "main_llm",
        provider: config.provider,
        model: config.model,
        ...trusted,
      });
      yield* delegate.chat(config, messages, opts);
    },
  };
}

/** Resolver metadata is derived from trusted provider-route/settings state. */
export function makeProcessingAwareResolver(
  delegate: ProviderResolverPort,
  resolveTrusted: (config: Parameters<ProviderResolverPort["resolve"]>[0]) => TrustedProviderOperation,
): ProviderResolverPort {
  let callSequence = 0;
  return {
    resolve(config) {
      return makeProcessingAwareProvider(
        delegate.resolve(config),
        resolveTrusted(config),
        () => `main_llm:resolver-call:${++callSequence}`,
      );
    },
  };
}

/** Only tools with trusted per-call metadata are guarded; local tools emit no disclosure. */
export function makeProcessingAwareToolExecutor(
  delegate: ToolExecutorPort,
  resolveTrusted: (
    call: Parameters<ToolExecutorPort["execute"]>[0],
  ) => ProcessingOperation | undefined,
): ToolExecutorPort {
  let callSequence = 0;
  return {
    specs: () => delegate.specs(),
    async execute(call, opts) {
      const operation = resolveTrusted(call);
      if (operation) await ensureCurrentProcessingAuthorized({
        ...operation,
        operationKey: `network_tool:call:${++callSequence}`,
      });
      return delegate.execute(call, opts);
    },
  };
}

type EmbeddingLike = {
  readonly dims: number;
  readonly name: string;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
};

/** Guard the actual network embedding delegate; offline embedding is not wrapped. */
export function makeProcessingAwareEmbedding<T extends EmbeddingLike>(
  delegate: T,
  operation: Omit<ProcessingOperation, "operationKey" | "workload">,
): T {
  let callSequence = 0;
  return {
    ...delegate,
    dims: delegate.dims,
    name: delegate.name,
    async embed(text: string) {
      await ensureCurrentProcessingAuthorized({
        ...operation, workload: "embedding", operationKey: `embedding:call:${++callSequence}`,
      });
      return delegate.embed(text);
    },
    async embedBatch(texts: string[]) {
      await ensureCurrentProcessingAuthorized({
        ...operation, workload: "embedding", operationKey: `embedding:call:${++callSequence}`,
      });
      return delegate.embedBatch(texts);
    },
  } as T;
}

/** Guard fact extraction/summarization immediately before the network LLM delegate. */
export function makeProcessingAwareMemoryLlm<TArgs extends readonly unknown[], TResult>(
  delegate: (...args: TArgs) => Promise<TResult>,
  operation: Omit<ProcessingOperation, "operationKey" | "workload"> & {
    readonly purpose: "fact_extractor" | "summarizer" | "contradiction_filter";
  },
): (...args: TArgs) => Promise<TResult> {
  let callSequence = 0;
  return async (...args) => {
    await ensureCurrentProcessingAuthorized({
      ...operation,
      workload: "memory_llm",
      operationKey: `memory_llm:${operation.purpose}:call:${++callSequence}`,
    });
    return delegate(...args);
  };
}
