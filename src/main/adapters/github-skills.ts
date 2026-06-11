// adapters/github-skills — S23 github 스킬 ToolExecutorPort(읽기 전용). 외부 auth(token 주입) 패턴 — S24-25/gateway 기반.
// §E 동일 규약: 통합 no-throw 경계(arg/fetch/format 단일 try, abort만 reject, fail-safe msg), abort 2가드(진입/await후), arg/결과 검증.
import type { ToolExecutorPort } from "../ports/uc1.js";
import type { ToolSpec, ToolCall } from "../domain/chat.js";
import { isAborted } from "./signal-util.js";

type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface GithubDeps { token?: string; fetch?: FetchLike; baseUrl?: string; }

const TOOLS: readonly ToolSpec[] = [
  { name: "github_list_issues", description: "repo 이슈 목록(읽기). 인자: {owner, repo, state?:'open'|'closed'|'all'}", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" } }, required: ["owner", "repo"] } },
  { name: "github_get_issue", description: "이슈 1건 조회(읽기). 인자: {owner, repo, number}", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, number: { type: "number" } }, required: ["owner", "repo", "number"] } },
];

const ok = (output: string) => ({ output });
const err = (output: string) => ({ output, isError: true });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function safeMsg(e: unknown): string {
  try { if (e !== null && typeof e === "object") { const m = (e as { message?: unknown }).message; if (typeof m === "string") return m; } } catch { /* getter throw */ }
  try { return String(e); } catch { return "tool error"; }
}
// 경로 인젝션 방지: owner/repo 는 github 식별자 문자(영숫자·-·_·.)만. number 는 양의 정수.
const SEG = /^[A-Za-z0-9_.-]+$/;

export function makeGithubSkillsExecutor(deps: GithubDeps = {}): ToolExecutorPort {
  const doFetch: FetchLike | undefined = deps.fetch ?? (typeof globalThis.fetch === "function" ? (globalThis.fetch as unknown as FetchLike) : undefined);
  const base = (deps.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const headers = (): Record<string, string> => ({ Authorization: `Bearer ${deps.token}`, Accept: "application/vnd.github+json", "User-Agent": "naia-agent", "X-GitHub-Api-Version": "2022-11-28" });

  return {
    specs: () => TOOLS,
    async execute(call: ToolCall, opts: { signal?: AbortSignal }): Promise<{ output: string; isError?: boolean }> {
      let signal: AbortSignal | undefined; // ⚠️ try 안에서 읽음 — malformed opts/throwing getter 도 catch→isError(NO-THROW)
      let aborted = false; // 결정론 abort 추적(catch 에서 signal 재독 의존 안 함)
      const abortGuard = () => { if (isAborted(signal)) { aborted = true; throw new Error("aborted"); } };
      try {
        signal = opts?.signal;
        abortGuard(); // (진입 가드)
        if (!deps.token || !doFetch) return err("github unavailable (token/fetch)");
        if (!isObj(call.args)) return err("args must be object");
        const a = call.args;
        const owner = a.owner, repo = a.repo;
        if (typeof owner !== "string" || !SEG.test(owner)) return err("owner invalid");
        if (typeof repo !== "string" || !SEG.test(repo)) return err("repo invalid");
        const enc = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

        if (call.name === "github_list_issues") {
          let state = "open";
          if (a.state !== undefined) { if (a.state !== "open" && a.state !== "closed" && a.state !== "all") return err("state must be open|closed|all"); state = a.state; }
          const r = await doFetch(`${base}/repos/${enc}/issues?state=${state}&per_page=20`, { headers: headers(), ...(signal ? { signal } : {}) });
          abortGuard(); // (await 후 가드)
          if (!r.ok) return err(`github HTTP ${r.status}`);
          const j = await r.json();
          abortGuard(); // (json await 후 가드)
          if (!Array.isArray(j) || !j.every(isObj)) return err("malformed github response"); // 모든 항목 객체(strict — 손상 silent drop 금지)
          const arr = j as Record<string, unknown>[];
          // pull_request: 없음(issue) | 객체(PR) 만 정상. null·string 등 그 외 타입 = 손상 → error(silent drop 금지, strict).
          if (!arr.every((it) => it.pull_request === undefined || isObj(it.pull_request))) return err("malformed github response");
          const issues = arr.filter((it) => it.pull_request === undefined); // ⚠️ github /issues 는 PR 포함 — PR(객체) 제외
          // 남은 issue 전부 number+title 검증(하나라도 손상이면 silent drop 아닌 error)
          if (!issues.every((it) => typeof it.number === "number" && Number.isInteger(it.number) && (it.number as number) > 0 && typeof it.title === "string")) return err("malformed github response");
          const lines = issues.map((it) => `#${it.number as number} ${it.title as string} (${typeof it.state === "string" ? it.state : "?"})`);
          return ok(lines.length ? lines.join("\n") : "(이슈 없음)");
        }
        if (call.name === "github_get_issue") {
          const num = a.number;
          if (typeof num !== "number" || !Number.isInteger(num) || num <= 0) return err("number must be positive integer");
          const r = await doFetch(`${base}/repos/${enc}/issues/${num}`, { headers: headers(), ...(signal ? { signal } : {}) });
          abortGuard();
          if (!r.ok) return err(`github HTTP ${r.status}`);
          const j = await r.json();
          abortGuard(); // (json await 후 가드)
          if (!isObj(j) || typeof j.title !== "string") return err("malformed github response");
          if (j.pull_request !== undefined) return err("not an issue (pull request)"); // ⚠️ /issues/{n} 는 PR 도 반환(번호공간 공유) — list_issues 와 일관되게 issue 만(pull_request 부재)
          const body = typeof j.body === "string" ? j.body : "";
          return ok(`#${num} ${j.title as string} (${typeof j.state === "string" ? j.state : "?"})\n\n${body.slice(0, 2000)}`);
        }
        return err(`unknown tool: ${call.name}`);
      } catch (e) {
        if (aborted || isAborted(signal)) throw e instanceof Error ? e : new Error("aborted"); // abort(flag 우선) → reject
        return err(safeMsg(e));
      }
    },
  };
}
