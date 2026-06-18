// adapters/adk-skill-loader — naia-adk 워크스페이스의 SKILL.md 스킬을 ToolExecutorPort 로 노출(동적).
// 성격 구분(루크): 스킬 *정의*(SKILL.md)=naia-adk 워크스페이스 / 스킬 *실행 엔진*=agent 런타임.
// naia-adk SKILL.md = narrative(서술형 절차) — frontmatter(name/description/tier) + Markdown 본문(워크플로우).
//   skill-spec 은 tool-agnostic(type/command 필드 없음)이고 new-naia 는 gateway 없음 → 실행 = 본문(절차)을
//   도구 output 으로 제공(프롬프트 주입형). LLM 이 skill_<name> 호출 → 절차 수신 → 표준 도구(builtin/browser/…)로
//   수행(메타). 부작용은 표준 도구가, 절차/지식은 SKILL.md 가 담당.
// ⚠️ src/main 순수: 파일 스캔/읽기는 .mjs 진입점이 수행(parseSkillMd 결과 배열을 주입). 이 어댑터는 파싱(순수)+executor.
import type { ToolExecutorPort } from "../ports/uc1.js";
import type { ToolSpec, ToolCall } from "../domain/chat.js";
import { isAborted } from "./signal-util.js";

/** 파싱된 naia-adk 스킬(SKILL.md frontmatter + 본문). */
export interface AdkSkill {
  readonly name: string;
  readonly description: string;
  readonly tier: string;
  readonly body: string;
}

const ok = (output: string) => ({ output });
const err = (output: string) => ({ output, isError: true });

/**
 * SKILL.md 파싱(순수). frontmatter(--- ... ---) 의 name/description/tier 만 추출 + 본문.
 * YAML 의존 없이 단순 라인 파싱(naia-adk frontmatter 는 평탄 — input_schema 등 중첩은 1차 생략, 빈 parameters).
 * 필수(name/description) 없으면 null(정직 — 잘못된 SKILL.md 는 스킵).
 */
export function parseSkillMd(markdown: string): AdkSkill | null {
  const m = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = m[1];
  const body = m[2];
  const field = (key: string): string | undefined => {
    const r = fm.match(new RegExp(`^${key}\\s*:\\s*(.+?)\\s*$`, "m"));
    return r ? r[1].replace(/^["']|["']$/g, "") : undefined; // 양끝 따옴표 제거
  };
  const name = field("name");
  const description = field("description");
  if (!name || !description) return null; // 필수 누락 = 스킵
  const tier = field("tier") ?? "ask"; // SKILL.md tier(T0~T3) > 기본 ask(외부 절차 = 승인 게이트)
  return { name, description, tier, body: body.trim() };
}

/** 스킬명 → 도구명(skill_<sanitized>). 영숫자/_/- 외 치환(도구명 안전). */
export function toolNameFor(skillName: string): string {
  return `skill_${skillName.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/**
 * naia-adk SKILL.md 스킬 executor. skills = .mjs 가 {adkPath}/.agents/skills/**\/SKILL.md 스캔+parseSkillMd 한 배열 주입.
 * 도구명 = skill_<name>(중복 = 첫 등록 우선). execute = 본문(절차)을 output 으로 반환(프롬프트 주입형).
 */
export function makeAdkSkillExecutor(skills: readonly AdkSkill[]): ToolExecutorPort {
  const byTool = new Map<string, AdkSkill>();
  const specs: ToolSpec[] = [];
  for (const s of skills) {
    const toolName = toolNameFor(s.name);
    if (byTool.has(toolName)) continue; // 중복 drop(첫 등록 우선 — composite 와 동일 규약)
    byTool.set(toolName, s);
    specs.push({
      name: toolName,
      description: s.description,
      parameters: { type: "object", properties: {}, additionalProperties: true }, // input_schema 1차 생략 → 자유 args
      tier: s.tier,
    });
  }
  return {
    specs: () => specs,
    async execute(call: ToolCall, opts: { signal?: AbortSignal }): Promise<{ output: string; isError?: boolean }> {
      try {
        if (isAborted(opts?.signal)) throw new Error("aborted");
        const skill = byTool.get(call.name);
        if (!skill) return err(`unknown adk skill: ${call.name}`);
        const argStr = call.args && typeof call.args === "object" ? `\n\n[입력 args]\n${JSON.stringify(call.args)}` : "";
        // 절차(본문) 제공 — LLM 이 읽고 표준 도구로 수행. 이 스킬 자체는 부작용 없음(절차 안내).
        return ok(`[naia-adk 스킬: ${skill.name}]\n아래 절차를 따라 수행하세요(필요 동작은 표준 도구 사용):\n\n${skill.body}${argStr}`);
      } catch (e) {
        if (opts?.signal && isAborted(opts.signal)) throw e; // abort 만 reject(no-throw 계약)
        return err(`adk skill error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
