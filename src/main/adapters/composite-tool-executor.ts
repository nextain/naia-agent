// adapters/composite-tool-executor — 여러 ToolExecutorPort 를 하나로 합성(builtin + github + …).
// specs 병합(name 충돌=첫 등록 우선, 후순위 중복 drop), execute 는 name 소유 executor 로 위임.
import type { ToolExecutorPort } from "../ports/uc1.js";
import type { ToolSpec, ToolCall } from "../domain/chat.js";

/** executors 순서 = 우선순위(앞이 우선). 같은 tool name 중복 시 첫 executor 가 소유. */
export function makeCompositeToolExecutor(executors: readonly ToolExecutorPort[]): ToolExecutorPort {
  // name → 소유 executor(첫 등록). specs 도 첫 등록 것만(중복 name drop).
  const owner = new Map<string, ToolExecutorPort>();
  const mergedSpecs: ToolSpec[] = [];
  // tier 보수성: gated(none 아님)=1 > none/미설정=0. 중복 시 가장 보수적 tier 채택(gated→auto 조용히 강등 금지, UC5 §D.1 리뷰 fix).
  const tierRank = (t?: string): number => (t !== undefined && t !== "none" ? 1 : 0);
  for (const ex of executors) {
    for (const s of ex.specs()) {
      const idx = mergedSpecs.findIndex((m) => m.name === s.name);
      if (idx >= 0) {
        // 실행 소유는 첫 executor 유지(owner 불변). 단 tier 는 더 보수적이면 승격(gated 유실 방지).
        if (tierRank(s.tier) > tierRank(mergedSpecs[idx].tier)) mergedSpecs[idx] = { ...mergedSpecs[idx], tier: s.tier };
        continue;
      }
      owner.set(s.name, ex);
      mergedSpecs.push(s);
    }
  }
  return {
    specs: () => mergedSpecs,
    execute(call: ToolCall, opts: { signal?: AbortSignal }): Promise<{ output: string; isError?: boolean }> {
      const ex = owner.get(call.name);
      if (!ex) return Promise.resolve({ output: `unknown tool: ${call.name}`, isError: true }); // no-throw
      return ex.execute(call, opts); // 위임(child 의 no-throw/abort 계약 그대로 전파)
    },
  };
}
