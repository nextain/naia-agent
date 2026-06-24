// adapters/composite-tool-executor — 여러 ToolExecutorPort 를 하나로 합성(builtin + github + panel + …).
// specs 병합(name 충돌=첫 등록 우선, 후순위 중복 drop), execute 는 name 소유 executor 로 위임.
//
// ⚠️ 동적(H1 fix): child(panel-tool-executor 등)가 런타임에 specs 를 바꾼다(RegisterPanelSkills). 구축 시점에
//   owner/specs 를 스냅샷하면 — entry 가 panel 등록 *전*에 composite 를 합성하므로 — panel 도구가 영영
//   LLM 에 안 보이고 execute 도 "unknown tool" 로 떨어진다(panel skill 0% 동작). 따라서 specs()/execute()
//   호출마다 child specs() 를 **재집계**한다(child 가 정적이면 결과 동일 = builtin 무회귀).
import type { ToolExecutorPort } from "../ports/uc1.js";
import type { ToolSpec, ToolCall } from "../domain/chat.js";

/** executors 순서 = 우선순위(앞이 우선). 같은 tool name 중복 시 첫 executor 가 소유. */
export function makeCompositeToolExecutor(executors: readonly ToolExecutorPort[]): ToolExecutorPort {
  // tier 보수성: gated(none 아님)=1 > none/미설정=0. 중복 시 가장 보수적 tier 채택(gated→auto 조용히 강등 금지, UC5 §D.1).
  const tierRank = (t?: string): number => (t !== undefined && t !== "none" ? 1 : 0);
  // 호출 시점 재집계 — name → 소유 executor(첫 등록), specs 병합(중복 name drop, tier 는 보수적 승격).
  const resolve = (): { owner: Map<string, ToolExecutorPort>; merged: ToolSpec[] } => {
    const owner = new Map<string, ToolExecutorPort>();
    const merged: ToolSpec[] = [];
    for (const ex of executors) {
      for (const s of ex.specs()) {
        const idx = merged.findIndex((m) => m.name === s.name);
        if (idx >= 0) {
          if (tierRank(s.tier) > tierRank(merged[idx].tier)) merged[idx] = { ...merged[idx], tier: s.tier }; // 소유 불변, tier 승격만
          continue;
        }
        owner.set(s.name, ex);
        merged.push(s);
      }
    }
    return { owner, merged };
  };
  return {
    specs: () => resolve().merged,
    execute(call: ToolCall, opts: { signal?: AbortSignal; requestId?: string }): Promise<{ output: string; isError?: boolean }> {
      const ex = resolve().owner.get(call.name);
      if (!ex) return Promise.resolve({ output: `unknown tool: ${call.name}`, isError: true }); // no-throw
      return ex.execute(call, opts); // 위임(child 의 no-throw/abort 계약 그대로 전파). requestId=panel 위임용(builtin 무시).
    },
  };
}
