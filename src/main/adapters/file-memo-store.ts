// adapters/file-memo-store — MemoStore 의 파일영속 구현(§E memo). 재시작 후 메모 유지.
// ⚠️ 코어 순수 유지 — node:fs 직접 import 안 함. FsLike 주입(entry 가 node:fs 제공, 테스트는 fake).
import type { MemoStore } from "./builtin-skills.js";

export interface FsLike {
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string): void;
  renameSync(oldPath: string, newPath: string): void;
  mkdirSync(path: string, opts: { recursive: true }): void;
  existsSync(path: string): boolean;
}

/**
 * title→content JSON 파일 백업 MemoStore. 로드 실패=빈 in-memory(degraded, no-throw). save=atomic(temp+rename).
 * ⚠️ `dir` = `path` 의 부모 디렉터리(필수) — persist 가 항상 `mkdirSync(dir,{recursive})` 로 보장(부모 부재 시 ENOENT 방지). 호출자(entry)가 dirname(path) 주입.
 */
export function makeFileMemoStore(deps: { path: string; fs: FsLike; dir: string }): MemoStore {
  const { path, fs } = deps;
  const m = new Map<string, string>();

  // 로드: 파일 있으면 파싱(실패/손상=빈 맵으로 degrade, throw 금지 — 손상 파일은 다음 save 가 덮어씀).
  try {
    if (fs.existsSync(path)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string") m.set(k, v); // string 값만 채택(손상 항목 skip)
        }
      }
    }
  } catch { /* 로드 실패 = 빈 맵 degrade */ }

  const persist = (): void => {
    // atomic: temp 쓰고 rename(부분쓰기/크래시 시 기존 파일 보존). dir 보장.
    fs.mkdirSync(deps.dir, { recursive: true }); // 항상 부모 보장. recursive=기존엔 no-throw; 실 실패(권한 등) 전파→skill isError
    const tmp = `${path}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(m)));
    fs.renameSync(tmp, path);
  };

  return {
    save: (title, content) => {
      // ⚠️ persist 실패 시 in-memory↔디스크 desync 방지: 실패하면 map 롤백 + rethrow(skill catch→isError).
      const had = m.has(title); const prev = m.get(title);
      m.set(title, content);
      try { persist(); }
      catch (e) { if (had) m.set(title, prev!); else m.delete(title); throw e; } // 이전 상태 복원
    },
    list: () => [...m.keys()],
    get: (title) => (m.has(title) ? m.get(title)! : null),
  };
}
