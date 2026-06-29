// adapters/fs-tools — UC-FS-TOOLS: 에이전트 직접 파일도구(list_dir·read_file·write_file) ToolExecutorPort.
//
// ★ 보안 최우선(이 워크스페이스엔 실제 키/시크릿 존재). 모든 경로는:
//   (1) domain validatePath(순수: allow-root·탈출차단·env확장·널바이트·denylist) 통과 후
//   (2) **주입 realpath 로 실제 경로 resolve → validatePath 재검증**(TOCTOU/symlink·junction 탈출, GLM f) 후에만
//   실행기(주입 fs) 호출. 한 군데도 raw 경로 직접 사용 금지(sandbox 우회 = 보안구멍).
//
// §E/§F no-throw 규약: 실패/거부/sandbox위반 = { output, isError:true }(throw 금지 — 루프 안정). abort 만 reject.
// tier: read_file/list_dir="fs-read"(gated 감사) · write_file="fs-write". write 는 enableWrite=true 일 때만 spec 노출(opt-in).
//
// ⚠️ **잔존 TOCTOU race(정직 표기)**: validatePath→realpath 재검증과 실제 read/write 사이에 경로가 swap 될
//   여지가 남는다(Node 고수준 path API 한계 — 검증과 I/O 가 같은 핸들이 아님). write 는 추가로 **대상이 symlink 면
//   거부**(lstat)해 link-follow 덮어쓰기를 막지만, 검증↔쓰기 사이에 부모가 교체되는 race 는 완전히 닫지 못한다.
//   완전 방어는 OS-level(O_NOFOLLOW/dir-fd 기반 openat)이 필요하며 Node 표준 API 로는 불가 — opt-in(기본 off) +
//   승인 게이트 + denylist 로 **완화**한다(난도 높은 잔존 위험, 요구사항 NFR-SEC 에 명시).
//
// ⚠️ 코어 순수 — node:fs 직접 import 안 함. FsLike 주입(compose-agent-deps 가 node:fs 제공, 테스트는 fake).
import type { ToolExecutorPort } from "../ports/uc1.js";
import type { ToolSpec, ToolCall } from "../domain/chat.js";
import { validatePath, type SandboxPolicy } from "../domain/fs-sandbox.js";
import { isAborted } from "./signal-util.js";

/** fs-tools 가 쓰는 최소 fs(node:fs 부분집합). realpathSync 는 **TOCTOU 재검증의 핵심**(symlink/junction 해소). */
export interface FsToolsFsLike {
  existsSync(path: string): boolean;
  /** 실제 경로(symlink/junction 해소) — 재검증용. 대상 부재 시 throw(존재 검사 후 호출). */
  realpathSync(path: string): string;
  /** 링크를 따라가지 않는 stat — write 대상이 symlink 인지 판정(symlink follow 덮어쓰기 차단). */
  lstatSync(path: string): { isSymbolicLink(): boolean };
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string, opts: { withFileTypes: true }): readonly { name: string; isDirectory(): boolean; isFile(): boolean }[];
  writeFileSync(path: string, data: string, opts: { encoding: "utf8"; mode?: number }): void;
  statSync(path: string): { isDirectory(): boolean; isFile(): boolean; size: number };
}

export interface FsToolsDeps {
  readonly fs: FsToolsFsLike;
  /** allow-root(절대 adkPath). 모든 경로가 이 하위로 resolve 돼야 함. */
  readonly allowRoots: readonly string[];
  /** write_file 등록 여부(opt-in). false = read/list 만(write spec 미노출). */
  readonly enableWrite?: boolean;
}

const MAX_FILE = 1024 * 1024;   // read 상한(1MB) — 메모리 폭발 차단.
const MAX_OUT = 16000;          // 출력 절단(컨텍스트 폭주 차단).
const MAX_WRITE = 1024 * 1024;  // write 상한(1MB).
const MAX_LIST = 1000;          // list 엔트리 상한.

const ok = (output: string): { output: string } => ({ output });
const err = (output: string): { output: string; isError: boolean } => ({ output, isError: true });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function safeMsg(e: unknown): string {
  try { if (e !== null && typeof e === "object") { const m = (e as { message?: unknown }).message; if (typeof m === "string") return m; } } catch { /* getter throw */ }
  try { return String(e); } catch { return "tool error"; }
}

const READ_TOOLS: readonly ToolSpec[] = [
  { name: "list_dir", description: "워크스페이스 내 디렉터리의 항목 목록(이름+종류). 인자: {path} (워크스페이스 상대 또는 워크스페이스 내 절대).", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, tier: "fs-read" },
  { name: "read_file", description: "워크스페이스 내 파일 내용 읽기(텍스트, ≤1MB). 인자: {path}. 민감경로(.keys/.env/키 등)는 거부됨.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, tier: "fs-read" },
];
const WRITE_TOOL: ToolSpec =
  { name: "write_file", description: "워크스페이스 내 파일 쓰기(텍스트, ≤1MB, 승인 필요). 인자: {path, content}. 민감경로/워크스페이스 밖은 거부.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }, tier: "fs-write" };

/**
 * UC-FS-TOOLS ToolExecutorPort. 모든 fs 접근은 **이중 검증**(domain validatePath → realpath → validatePath 재검증)
 * 통과 후에만. enableWrite=false(기본) 면 write_file 은 specs 에 없음(opt-in, NAIA_SHELL_TOOL=1 에서만 host 가 켬).
 *
 * @future per-request capability — 현재 opt-in 은 env-var 게이트(GLM: 자식 상속으로 약함). 핵심 보안은
 *   sandbox/denylist/argv 가 담당. 미래 강화 = chat_request 별 capability 토큰(요구사항 NFR-SEC 노트).
 */
export function makeFsTools(deps: FsToolsDeps): ToolExecutorPort {
  const { fs, allowRoots, enableWrite = false } = deps;
  const policy: SandboxPolicy = { allowRoots };
  const tools: readonly ToolSpec[] = enableWrite ? [...READ_TOOLS, WRITE_TOOL] : READ_TOOLS;

  /**
   * ★ 보안 핵심 — 2단계 검증 후 실제 경로 반환. 한 곳에서만 fs 경로를 산출(우회 불가).
   *  1) domain validatePath(rawPath) — 순수 정책(탈출/denylist).
   *  2) existsSync → (write=lstat symlink 거부) → realpathSync(symlink/junction 해소) → validatePath(realpath)
   *     **재검증**(TOCTOU, GLM f). 부재 파일이면 realpath 불가 → write 는 부모 디렉터리 realpath 로 검증, read/list 는 "not found".
   * 반환: { ok:true, real } | { ok:false, reason }. realpath 가 allow-root 밖/denylist 면 거부.
   *
   * ⚠️ **잔존 race(정직)**: 이 함수가 산출한 real 과 호출처의 read/write 사이에 경로가 swap 될 여지가 남는다
   *   (Node path API 는 검증·I/O 가 같은 fd 가 아님). write 는 symlink 거부로 link-follow 를 막지만, 검증↔쓰기
   *   사이의 부모 swap 은 못 막는다. 완전 방어 = O_NOFOLLOW/dir-fd(openat) — Node 표준 미지원. opt-in+승인으로 완화.
   */
  const resolveSafe = (rawPath: unknown, opts: { forWrite: boolean }): { ok: true; real: string } | { ok: false; reason: string } => {
    if (typeof rawPath !== "string") return { ok: false, reason: "path must be string" };
    const v1 = validatePath(rawPath, policy); // 1단계: 순수 정책
    if (!v1.ok) return { ok: false, reason: v1.reason };

    // 2단계: 실제 경로 resolve 후 재검증(symlink/junction swap·TOCTOU 방지).
    if (fs.existsSync(v1.normalized)) {
      // write 대상이 *기존 symlink* 면 거부 — writeFileSync 가 링크를 따라가 외부 파일을 덮어쓰는 것 차단(TOCTOU 완화).
      //   read/list 는 realpath 재검증(아래)으로 충분(링크 해소 후 allow-root/denylist 판정).
      if (opts.forWrite) {
        try { if (fs.lstatSync(v1.normalized).isSymbolicLink()) return { ok: false, reason: "write target is a symlink (refused)" }; }
        catch (e) { return { ok: false, reason: `lstat failed: ${safeMsg(e)}` }; }
      }
      let real: string;
      try { real = fs.realpathSync(v1.normalized); } catch (e) { return { ok: false, reason: `realpath failed: ${safeMsg(e)}` }; }
      const v2 = validatePath(real, policy); // realpath 재검증 — 링크가 allow-root 밖/민감경로 가리키면 거부
      if (!v2.ok) return { ok: false, reason: `realpath rejected: ${v2.reason}` };
      return { ok: true, real: v2.normalized };
    }

    // 대상 부재: write 는 부모 디렉터리를 realpath 재검증(부모가 symlink 로 탈출하는 새 파일 생성 차단).
    if (opts.forWrite) {
      const idx = Math.max(v1.normalized.lastIndexOf("/"), v1.normalized.lastIndexOf("\\"));
      const parent = idx > 0 ? v1.normalized.slice(0, idx) : v1.normalized;
      const child = idx > 0 ? v1.normalized.slice(idx + 1) : "";
      if (!child) return { ok: false, reason: "invalid write target (no filename)" };
      if (fs.existsSync(parent)) {
        let realParent: string;
        try { realParent = fs.realpathSync(parent); } catch (e) { return { ok: false, reason: `realpath(parent) failed: ${safeMsg(e)}` }; }
        const vp = validatePath(realParent, policy);
        if (!vp.ok) return { ok: false, reason: `parent realpath rejected: ${vp.reason}` };
        // 부모 realpath + 자식명으로 최종 경로 재구성 후 한 번 더 denylist/컨테인먼트(자식명이 민감하면 거부).
        const finalPath = `${vp.normalized}/${child}`;
        const vf = validatePath(finalPath, policy);
        if (!vf.ok) return { ok: false, reason: vf.reason };
        return { ok: true, real: vf.normalized };
      }
      // 부모도 없음 — 디렉터리 자동생성 안 함(명시 거부, 의도치 않은 트리 생성 방지).
      return { ok: false, reason: "parent directory does not exist" };
    }
    return { ok: false, reason: "path not found" };
  };

  return {
    specs: () => tools,
    async execute(call: ToolCall, opts: { signal?: AbortSignal }): Promise<{ output: string; isError?: boolean }> {
      let signal: AbortSignal | undefined; // ⚠️ try 안에서 읽음 — malformed opts 도 catch→isError(NO-THROW)
      let aborted = false;
      const abortGuard = () => { if (isAborted(signal)) { aborted = true; throw new Error("aborted"); } };
      try {
        signal = opts?.signal;
        abortGuard(); // (진입 가드)
        if (!isObj(call.args)) return err("args must be object");
        const a = call.args;

        switch (call.name) {
          case "list_dir": {
            const safe = resolveSafe(a.path, { forWrite: false });
            if (!safe.ok) return err(`denied: ${safe.reason}`);
            abortGuard(); // (fs 호출 전 가드)
            const st = fs.statSync(safe.real);
            abortGuard();
            if (!st.isDirectory()) return err("not a directory");
            const ents = fs.readdirSync(safe.real, { withFileTypes: true });
            abortGuard();
            if (!Array.isArray(ents)) return err("malformed dir listing");
            const lines: string[] = [];
            let more = false;
            for (const e of ents) {
              if (lines.length >= MAX_LIST) { more = true; break; }
              if (!e || typeof e.name !== "string" || e.name.includes("\0")) continue;
              lines.push(`${e.isDirectory() ? "d" : "f"} ${e.name}`);
            }
            lines.sort();
            if (!lines.length) return ok(more ? "(비어있음 — 한도 도달)" : "(비어있음)");
            return ok(lines.join("\n") + (more ? "\n…(한도 도달 — 더 있음)" : ""));
          }
          case "read_file": {
            const safe = resolveSafe(a.path, { forWrite: false });
            if (!safe.ok) return err(`denied: ${safe.reason}`);
            abortGuard();
            const st = fs.statSync(safe.real);
            abortGuard();
            if (!st.isFile()) return err("not a file");
            if (st.size > MAX_FILE) return err("file too large (>1MB)");
            const body = fs.readFileSync(safe.real, "utf8");
            abortGuard();
            if (typeof body !== "string") return err("malformed file content");
            return ok(body.length > MAX_OUT ? body.slice(0, MAX_OUT) + "\n…(생략)" : body);
          }
          case "write_file": {
            if (!enableWrite) return err("write_file disabled (set NAIA_SHELL_TOOL=1 to enable)");
            if (typeof a.content !== "string") return err("content must be string");
            if (a.content.length > MAX_WRITE) return err("content too large (>1MB)");
            const safe = resolveSafe(a.path, { forWrite: true });
            if (!safe.ok) return err(`denied: ${safe.reason}`);
            abortGuard(); // (mutate 전 가드)
            fs.writeFileSync(safe.real, a.content, { encoding: "utf8", mode: 0o600 });
            return ok(`작성됨: ${safe.real} (${a.content.length} bytes)`);
          }
          default:
            return err(`unknown tool: ${call.name}`);
        }
      } catch (e) {
        if (aborted || isAborted(signal)) throw e instanceof Error ? e : new Error("aborted"); // abort → reject
        return err(safeMsg(e)); // 비-abort = isError(no-throw)
      }
    },
  };
}
