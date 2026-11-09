// adapters/composite-tool-executor — 여러 ToolExecutorPort 를 하나로 합성(builtin + github + app + …).
// specs 병합(name 충돌=첫 등록 우선, 후순위 중복 drop), execute 는 name 소유 executor 로 위임.
//
// ⚠️ 동적(H1 fix): child(app-tool-executor 등)가 런타임에 specs 를 바꾼다(RegisterAppSkills). 구축 시점에
//   owner/specs 를 스냅샷하면 — entry 가 app 등록 *전*에 composite 를 합성하므로 — app 도구가 영영
//   LLM 에 안 보이고 execute 도 "unknown tool" 로 떨어진다(app skill 0% 동작). 따라서 specs()/execute()
//   호출마다 child specs() 를 **재집계**한다(child 가 정적이면 결과 동일 = builtin 무회귀).
import type { ToolExecutorPort } from "../ports/uc1.js";
import {
  isGatedToolTier,
  normalizeExternalToolSpec,
  resolveEffectiveToolTier,
  type ToolSpec,
  type ToolCall,
} from "../domain/chat.js";

/**
 * 바깥(비내장) ToolExecutorPort를 한 곳에서 감싸 specs() 반환 시마다 normalizeExternalToolSpec을 강제한다.
 * 개별 어댑터가 tier 정규화를 빠뜨리거나 런타임에 동적으로 도구를 등록하더라도,
 * 미지정(undefined/빈 문자열) 및 비표준 tier(T1/T2 등)가 구조적으로 "ask" 승인 게이트로 수렴한다.
 */
export function wrapExternalToolExecutor(
  executor: ToolExecutorPort,
  allowedTiers?: ReadonlySet<string>,
): ToolExecutorPort {
  return {
    specs: () => executor.specs().map((s) => normalizeExternalToolSpec(s, allowedTiers)),
    execute: (call, opts) => executor.execute(call, opts),
  };
}

/**
 * 조립 단계에서 내장(builtin) 실행기와 바깥(external) 실행기를 분리해 합성한다:
 * - 내장 실행기는 도메인 계약(domain/chat.ts:38 — tier 미지정/"none"=자동 실행)을 그대로 유지한다.
 * - 바깥 실행기는 모두 wrapExternalToolExecutor로 감싸 normalizeExternalToolSpec을 강제한 뒤 합성한다.
 * - 내장 실행기가 앞 순위를 가져 바깥 도구가 내장 도구 소유권을 덮어쓰지 못하며, 이름 충돌 시 tier는 보수적으로 승격된다.
 */
export function composeBuiltinAndExternalToolExecutors(opts: {
  readonly builtin?: readonly (ToolExecutorPort | undefined)[];
  readonly external?: readonly (ToolExecutorPort | undefined)[];
  readonly allowedExternalTiers?: ReadonlySet<string>;
}): ToolExecutorPort | undefined {
  const builtinList = (opts.builtin ?? []).filter((ex): ex is ToolExecutorPort => ex !== undefined);
  const externalList = (opts.external ?? [])
    .filter((ex): ex is ToolExecutorPort => ex !== undefined)
    .map((ex) => wrapExternalToolExecutor(ex, opts.allowedExternalTiers));
  const all = [...builtinList, ...externalList];
  if (all.length === 0) return undefined;
  if (builtinList.length === 1 && externalList.length === 0) return builtinList[0];
  return makeCompositeToolExecutor(all);
}

/** executors 순서 = 우선순위(앞이 우선). 같은 tool name 중복 시 첫 executor 가 소유. */
export function makeCompositeToolExecutor(executors: readonly ToolExecutorPort[]): ToolExecutorPort {
  // tier 보수성: 도메인 계약(resolveEffectiveToolTier / isGatedToolTier)과 동일하게 gated(none/미설정 아님)=1 > none/미설정=0. 중복 시 가장 보수적 tier 채택(gated→auto 조용히 강등 금지, UC5 §D.1).
  const tierRank = (t?: string): number => (isGatedToolTier(t) ? 1 : 0);
  // 호출 시점 재집계 — name → 소유 executor(첫 등록), specs 병합(중복 name drop, tier 는 보수적 승격).
  const resolve = (): { owner: Map<string, ToolExecutorPort>; merged: ToolSpec[] } => {
    const owner = new Map<string, ToolExecutorPort>();
    const merged: ToolSpec[] = [];
    for (const ex of executors) {
      for (const s of ex.specs()) {
        const idx = merged.findIndex((m) => m.name === s.name);
        if (idx >= 0) {
          if (tierRank(s.tier) > tierRank(merged[idx].tier)) merged[idx] = { ...merged[idx], tier: resolveEffectiveToolTier(s) }; // 소유 불변, tier 승격만
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
    execute(call: ToolCall, opts: Parameters<ToolExecutorPort["execute"]>[1]): Promise<{ output: string; isError?: boolean }> {
      const ex = resolve().owner.get(call.name);
      if (!ex) return Promise.resolve({ output: `unknown tool: ${call.name}`, isError: true }); // no-throw
      return ex.execute(call, opts); // 위임(child 의 no-throw/abort 계약 그대로 전파). requestId=app 위임용(builtin 무시).
    },
  };
}
