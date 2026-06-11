// adapters/obsidian-skills — S24 obsidian 로컬 vault 읽기 ToolExecutorPort(읽기 전용). naia-agent RAG·context 책임.
// §E/§F 규약: 통합 no-throw 경계(arg/path/fs/format 단일 try, abort만 reject, fail-safe msg), abort 2가드(진입/fs후), strict 검증 + 파일시스템 경로 격리(safeRel).
import type { ToolExecutorPort } from "../ports/uc1.js";
import type { ToolSpec, ToolCall } from "../domain/chat.js";
import { isAborted } from "./signal-util.js";

// 읽기 subset (코어 순수 — node:fs 직접 import 안 함; entry 가 node:fs 주입, 테스트는 fake).
export interface ObsidianFsLike {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string): string[];
  statSync(path: string): { isDirectory(): boolean; isFile(): boolean; size: number };
}

export interface ObsidianDeps { vaultDir?: string; fs?: ObsidianFsLike; }

const TOOLS: readonly ToolSpec[] = [
  { name: "obsidian_list_notes", description: "vault(또는 하위 folder)의 .md 노트 상대경로 목록(읽기). 인자: {folder?}", parameters: { type: "object", properties: { folder: { type: "string" } } } },
  { name: "obsidian_read_note", description: "노트 1개 내용 조회(읽기, .md). 인자: {path}", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "obsidian_search", description: "내용에 query 포함 노트 경로 목록(읽기). 인자: {query, folder?}", parameters: { type: "object", properties: { query: { type: "string" }, folder: { type: "string" } }, required: ["query"] } },
];

const MAX_LIST = 500, MAX_SEARCH = 100, MAX_FILE = 1024 * 1024, MAX_OUT = 8000, MAX_SCAN = 5000, MAX_QUERY = 1000;
const ok = (output: string) => ({ output });
const err = (output: string) => ({ output, isError: true });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function safeMsg(e: unknown): string {
  try { if (e !== null && typeof e === "object") { const m = (e as { message?: unknown }).message; if (typeof m === "string") return m; } } catch { /* getter throw */ }
  try { return String(e); } catch { return "tool error"; }
}
// 경로 격리: 상대경로를 검증된 세그먼트 배열로. 위반(절대/상위참조/단일dot/빈세그먼트/null byte/루트표기)이면 null.
// ⚠️ 루트("" "." "/")는 명시 거부 — 루트 열거는 folder 생략(folderSegs=[])으로만(safeSegs 거치지 않음). 일관성: "." 단일/세그먼트 모두 거부.
function safeSegs(rel: string): string[] | null {
  if (typeof rel !== "string" || rel.includes("\0")) return null;
  // ⚠️ trim 안 함 — 공백 가공은 요청과 다른 파일 접근 유발(" note.md" → "note.md"). 원문 그대로 검증/조립.
  if (rel === "" || rel === "." || rel === "/" || rel === "\\") return null; // 빈/현재/루트표기 거부
  if (rel.startsWith("/") || rel.startsWith("\\")) return null; // 절대경로 거부
  const segs = rel.split(/[/\\]/); // collapse 안 함 — 빈 세그먼트(연속 슬래시/후행 슬래시)도 거부 대상
  const out: string[] = [];
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") return null; // 빈/현재/상위참조 거부
    out.push(s);
  }
  return out;
}

/** §F ToolExecutorPort 구현. vaultDir/fs 주입. 전부 읽기(tier none). */
export function makeObsidianSkillsExecutor(deps: ObsidianDeps = {}): ToolExecutorPort {
  const join = (segs: readonly string[]): string => [deps.vaultDir, ...segs].join("/");

  return {
    specs: () => TOOLS,
    async execute(call: ToolCall, opts: { signal?: AbortSignal }): Promise<{ output: string; isError?: boolean }> {
      let signal: AbortSignal | undefined; // ⚠️ try 안에서 읽음 — malformed opts/throwing getter 도 catch→isError(NO-THROW)
      let aborted = false; // 결정론 abort 추적(catch 에서 signal 재독 의존 안 함 — getter flip 무관)
      const abortGuard = () => { if (isAborted(signal)) { aborted = true; throw new Error("aborted"); } };
      try {
        signal = opts?.signal;
        abortGuard(); // (진입 가드)
        const { vaultDir, fs } = deps;
        if (!vaultDir || !fs) return err("obsidian unavailable (vault/fs)");
        if (!isObj(call.args)) return err("args must be object");
        const a = call.args;

        // folder(옵션) 검증 — 모든 도구 공통
        let folderSegs: string[] = [];
        if (a.folder !== undefined) {
          if (typeof a.folder !== "string") return err("folder must be string");
          const fs2 = safeSegs(a.folder);
          if (fs2 === null) return err("folder invalid (path containment)");
          folderSegs = fs2;
        }

        // vault(또는 하위 folder) 의 .md 노트 상대경로 재귀 수집. 결과 cap + fs 스캔 노드 cap(둘 다) — fs-work 폭발 차단.
        // 매 fs 호출(readdir/stat) 직전 abort 가드. 정확 잔여수 계산 안 함(more bool 만 — 전체순회 불요).
        const collect = (cap: number): { rels: string[]; more: boolean } => {
          const rels: string[] = [];
          let more = false;
          let scan = 0; // 방문 노드(readdir+stat) 수 — MAX_SCAN hard cap
          const walk = (segs: string[]): void => {
            if (rels.length >= cap || scan >= MAX_SCAN) { more = true; return; }
            abortGuard();
            scan++;
            const names = fs.readdirSync(join(segs)); // ⚠️ fs throw 는 잡지 않음 — 외부 catch 로 전파(non-abort=isError, 단일 에러경계)
            abortGuard(); // (fs 호출 직후 가드 — 마지막 readdir 후 abort 도 reject)
            for (const name of names) {
              if (rels.length >= cap || scan >= MAX_SCAN) { more = true; return; }
              if (typeof name !== "string" || name === "" || name.includes("\0") || name === "." || name === "..") continue;
              const child = [...segs, name];
              abortGuard();
              scan++;
              const st = fs.statSync(join(child)); // fs throw 전파(isError)
              abortGuard(); // (fs 호출 직후 가드 — 마지막 stat 후 abort 도 reject)
              if (st.isDirectory()) walk(child);
              else if (st.isFile() && name.toLowerCase().endsWith(".md")) {
                if (rels.length >= cap) { more = true; return; }
                rels.push(child.join("/"));
              }
            }
          };
          walk(folderSegs);
          return { rels, more };
        };

        switch (call.name) {
          case "obsidian_list_notes": {
            const { rels, more } = collect(MAX_LIST);
            // ⚠️ more 면 rels 비어도 truncation 마커(scan cap 이 .md 발견 전 걸린 경우 — silent "노트 없음" 금지, F-I5)
            if (!rels.length) return ok(more ? "(노트 없음 — 스캔 한도 도달, 더 있을 수 있음)" : "(노트 없음)");
            return ok(rels.join("\n") + (more ? `\n…(한도 도달 — 더 있음)` : ""));
          }
          case "obsidian_read_note": {
            if (typeof a.path !== "string") return err("path must be string");
            const segs = safeSegs(a.path);
            if (segs === null || segs.length === 0) return err("path invalid (path containment)");
            const last = segs[segs.length - 1];
            if (!last.toLowerCase().endsWith(".md")) return err("not a note (.md only)");
            const full = join(segs);
            abortGuard(); // (fs 호출 전 가드 — existsSync 도 fs 호출)
            const exists = fs.existsSync(full);
            abortGuard(); // (직후 가드 — existsSync 가 false 여도 abort 면 분기 전에 reject)
            if (!exists) return err("note not found");
            const st = fs.statSync(full);
            abortGuard();
            if (!st.isFile()) return err("not a file");
            if (st.size > MAX_FILE) return err("note too large (>1MB)");
            const body = fs.readFileSync(full, "utf8");
            abortGuard();
            if (typeof body !== "string") return err("malformed note content");
            return ok(body.length > MAX_OUT ? body.slice(0, MAX_OUT) + "\n…(생략)" : body);
          }
          case "obsidian_search": {
            if (typeof a.query !== "string" || a.query === "") return err("query must be non-empty string");
            if (a.query.length > MAX_QUERY) return err(`query too long (>${MAX_QUERY})`); // ⚠️ LLM-통제 거대 query 차단(fs 호출 전)
            const q = a.query.toLowerCase();
            // 후보 .md 수집 = scan-node cap(MAX_SCAN)까지(결과수 아닌 스캔 작업량으로 bound) — search 는 500개에 묶이면 안 됨(false negative).
            const { rels, more: candMore } = collect(MAX_SCAN);
            const hits: string[] = [];
            for (const rel of rels) {
              if (hits.length >= MAX_SEARCH) break;
              abortGuard();
              const segs = safeSegs(rel);
              if (segs === null) continue; // collect 결과는 안전하나 방어
              const full = join(segs);
              const st = fs.statSync(full); // fs throw 전파(isError, 단일 에러경계)
              abortGuard();
              if (!st.isFile() || st.size > MAX_FILE) continue; // ⚠️ per-note 1MB 초과 = read 생략(메모리 폭발 차단, stat 으로 판정)
              const body = fs.readFileSync(full, "utf8"); // fs throw 전파(isError)
              abortGuard(); // (fs 호출 직후 가드 — 마지막 read 후 abort 도 reject)
              if (typeof body === "string" && body.toLowerCase().includes(q)) hits.push(rel);
            }
            // truncation = 결과 cap 도달 OR 후보 스캔 절단(candMore) — 둘 다 "더 있을 수 있음" 명시(silent 금지)
            const more = hits.length >= MAX_SEARCH || candMore;
            if (!hits.length) return ok(more ? "(일치 노트 없음 — 스캔 한도 도달, 더 있을 수 있음)" : "(일치 노트 없음)");
            return ok(hits.join("\n") + (more ? `\n…(한도 도달 — 더 있을 수 있음)` : ""));
          }
          default:
            return err(`unknown tool: ${call.name}`);
        }
      } catch (e) {
        if (aborted || isAborted(signal)) throw e instanceof Error ? e : new Error("aborted"); // abort(flag 우선) → reject
        return err(safeMsg(e)); // 비-abort = isError(no-throw)
      }
    },
  };
}
