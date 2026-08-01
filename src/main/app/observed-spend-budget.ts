import type { ActorReceipt } from "../domain/issue-orchestration.js";
import { IssueActorResultError } from "../ports/issue-orchestration.js";

export class ObservedSpendBudget {
  readonly #chargedReceipts = new Set<string>();
  #observedSpendUsd = 0;
  #paidCalls = 0;

  constructor(
    readonly maxUsd: number,
    readonly reservedCallUsd: number,
    readonly maxPaidCalls: number,
  ) {}

  get observedSpendUsd(): number { return this.#observedSpendUsd; }
  get paidCalls(): number { return this.#paidCalls; }

  reserve(method: string, paid: boolean): void {
    if (!paid) return;
    if (this.#paidCalls >= this.maxPaidCalls) throw new Error(`benchmark paid-call limit reached before ${method}`);
    if (this.#observedSpendUsd + this.reservedCallUsd > this.maxUsd) {
      throw new Error(`benchmark reserved call budget unavailable before ${method}`);
    }
    this.#paidCalls += 1;
  }

  record(receipt: ActorReceipt | undefined, method: string, paid: boolean): void {
    if (!receipt || receipt.cost.state !== "measured" || !Number.isFinite(receipt.cost.usd) || receipt.cost.usd < 0) {
      throw new Error(`benchmark ${method} cost unavailable`);
    }
    const receiptKey = `${receipt.role}:${receipt.idempotencyKey}:${receipt.executionId}`;
    if (!this.#chargedReceipts.has(receiptKey)) {
      this.#chargedReceipts.add(receiptKey);
      this.#observedSpendUsd += receipt.cost.usd;
    }
    if (paid && receipt.cost.usd > this.reservedCallUsd) {
      throw new IssueActorResultError(`benchmark ${method} exceeded its reserved call budget`, receipt);
    }
    if (this.#observedSpendUsd > this.maxUsd) {
      throw new IssueActorResultError(`benchmark observed-spend threshold exceeded after ${method}`, receipt);
    }
  }
}

type ActorMethodResult = { readonly receipt: ActorReceipt };
type ActorMethod = (input: unknown) => Promise<ActorMethodResult>;

export function makeBudgetedActorPort<T extends object>(port: T, method: keyof T, budget: ObservedSpendBudget, paid = true): T {
  const actor = port[method];
  if (typeof actor !== "function") throw new Error(`benchmark actor method unavailable: ${String(method)}`);
  return {
    ...port,
    async [method](input: unknown): Promise<ActorMethodResult> {
      budget.reserve(String(method), paid);
      try {
        const result = await (actor as ActorMethod).call(port, input);
        budget.record(result.receipt, String(method), paid);
        return result;
      } catch (error) {
        if (paid && error instanceof IssueActorResultError) budget.record(error.receipt, String(method), paid);
        throw error;
      }
    },
  } as T;
}
