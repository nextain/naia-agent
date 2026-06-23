// adapters/workspace-git — WorkspacePort 의 **실 어댑터**(구 workspace/git-diff.ts + chokidar-watcher.ts 이식, 단계 2c).
//
// changes(workdir, signal) 는 `git status --porcelain` 출력을 added/modified/deleted 로 분류한 WorkspaceChange
// 스냅샷을 **폴링**(기본 500ms)으로 산출한다 — git 출력이 바뀔 때마다 새 스냅샷을 yield(동일 스냅샷은 de-dupe).
// signal.aborted 시 스트림 종료(인터벌 정리). chokidar/fs-watch 의존 없음 — git 폴링만(신규 npm dep 0).
//
// ⚠️ child_process 는 adapter 안에서만(import-boundary 강제). git 포맷·exec 메커니즘은 여기서 끝난다.
//    domain/ports/app 은 WorkspaceChange(added/modified/deleted 경로) semantic 만 본다.
//
// 구판과의 차이(2c, Karpathy 최소): chokidar fs-watch + debounce 버킷 + diff()/stats() 제거 — 신규 dep 금지
//    제약에 맞춰 `git status --porcelain` 폴링 1경로로 단순화. 변경 *요약 스냅샷* 스트림만(포트 계약 그대로).
import { execFile } from "node:child_process";
import type { WorkspaceChange } from "../domain/orchestration.js";
import type { WorkspacePort } from "../ports/orchestration.js";

const DEFAULT_POLL_MS = 500; // 폴링 간격. git status 가 바뀔 때만 yield(busy-loop 아님).
const MAX_BUFFER = 16 * 1024 * 1024; // git 출력 상한(대형 워크트리 대비, 구 git-diff.ts 와 동일).

/** git 실행 시그니처 — workdir 에서 git <args> 실행 후 stdout 반환. 실패(비-0 exit/없는 git/비-repo)는 "" 로 흡수.
 *  spawnFn 대신 이 seam 으로 주입(테스트가 스냅샷 시퀀스를 스크립팅) — 폴링 어댑터엔 줄단위 스트림 머신이 과함. */
export type GitRunner = (workdir: string, args: readonly string[]) => Promise<string>;

const defaultGitRunner: GitRunner = (workdir, args) =>
  new Promise<string>((resolve) => {
    execFile("git", [...args], { cwd: workdir, maxBuffer: MAX_BUFFER }, (err, stdout) => {
      // git 실패(비-repo, 권한, 비-0 exit) = 빈 출력으로 흡수(throw 아님 — 폴링이 계속 돈다).
      if (err) { resolve(""); return; }
      resolve(stdout);
    });
  });

export interface GitWorkspaceOptions {
  /** 폴링 간격(ms). 기본 500. */
  readonly pollMs?: number;
  /** git 실행 주입(테스트). 미주입 = execFile("git", …). */
  readonly runGit?: GitRunner;
}

/** WorkspacePort 실 어댑터. git status --porcelain 폴링으로 변경 요약 스냅샷 스트림 산출. */
export function makeGitWorkspace(opts: GitWorkspaceOptions = {}): WorkspacePort {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const runGit = opts.runGit ?? defaultGitRunner;

  return {
    changes(workdir: string, signal: AbortSignal): AsyncIterable<WorkspaceChange> {
      return pollChanges(runGit, workdir, signal, pollMs);
    },
  };
}

/** porcelain 폴링 → WorkspaceChange 스냅샷 async iterable. signal.aborted 시 종결, 인터벌 정리(누수 0). */
function pollChanges(
  runGit: GitRunner,
  workdir: string,
  signal: AbortSignal,
  pollMs: number,
): AsyncIterable<WorkspaceChange> {
  const queue: WorkspaceChange[] = [];
  const waiters: Array<(r: IteratorResult<WorkspaceChange>) => void> = [];
  let closed = false;
  let lastKey: string | undefined; // 직전 스냅샷 직렬화 — 동일하면 de-dupe(yield 안 함).
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false; // 재진입 가드 — 직전 poll 이 안 끝났으면 skip(felt-overlap 방지).

  const push = (c: WorkspaceChange): void => {
    const w = waiters.shift();
    if (w) w({ value: c, done: false });
    else queue.push(c);
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer) { clearInterval(timer); timer = undefined; }
    for (const w of waiters.splice(0)) w({ value: undefined as never, done: true });
  };

  const poll = async (): Promise<void> => {
    if (closed || polling) return;
    polling = true;
    try {
      const out = await runGit(workdir, ["status", "--porcelain"]);
      if (closed) return; // poll 진행 중 abort — 결과 버림
      const change = classifyPorcelain(out);
      const key = snapshotKey(change);
      if (key !== lastKey) {
        lastKey = key;
        push(change);
      }
    } catch {
      // runGit 은 흡수하도록 작성됐으나(paranoid backstop) — 어떤 throw 도 폴링을 깨지 않는다.
    } finally {
      polling = false;
    }
  };

  const start = (): void => {
    if (signal.aborted) { close(); return; }
    signal.addEventListener("abort", close, { once: true });
    void poll(); // 즉시 1회(초기 스냅샷) — 인터벌 첫 tick 대기 없이.
    timer = setInterval(() => { void poll(); }, pollMs);
  };

  let started = false;
  return {
    [Symbol.asyncIterator](): AsyncIterator<WorkspaceChange> {
      if (!started) { started = true; start(); } // lazy — iterate 시작 시 폴링 개시.
      return {
        next(): Promise<IteratorResult<WorkspaceChange>> {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
        return(): Promise<IteratorResult<WorkspaceChange>> {
          close(); // consumer break/return → 폴링 정리(인터벌 누수 0).
          return Promise.resolve({ value: undefined as never, done: true });
        },
      };
    },
  };
}

/** WorkspaceChange 직렬화 키(de-dupe 용) — 정렬된 경로 목록. 동일 변경 집합 = 동일 키. */
function snapshotKey(c: WorkspaceChange): string {
  return JSON.stringify([[...c.added].sort(), [...c.modified].sort(), [...c.deleted].sort()]);
}

/**
 * `git status --porcelain` 출력 → WorkspaceChange. 각 줄은 `XY <path>`(또는 rename `XY old -> new`).
 * XY = 2자 status(index X + worktree Y). 분류 규칙:
 *   - `??`            → untracked → added
 *   - X 또는 Y 가 'A' → added(스테이지된 신규)
 *   - X 또는 Y 가 'D' → deleted(단, R 이면 rename 으로 별도 처리)
 *   - X 또는 Y 가 'R' → rename → 새 경로(-> 뒤)를 added
 *   - 그 외 'M'/'MM'/'MD' 등 수정 → modified
 * 동일 경로가 여러 카테고리에 걸치면 우선순위 deleted > added > modified 로 단일 분류(중복 yield 방지).
 */
export function classifyPorcelain(out: string): WorkspaceChange {
  const added = new Set<string>();
  const modified = new Set<string>();
  const deleted = new Set<string>();

  for (const rawLine of out.split("\n")) {
    if (rawLine.length === 0) continue;
    // porcelain v1: 첫 2자 = XY status, 3자째 공백, 4자째부터 경로.
    const xy = rawLine.slice(0, 2);
    const rest = rawLine.slice(3);
    if (rest.length === 0) continue;
    const x = xy[0];
    const y = xy[1];

    if (xy === "??") { added.add(unquote(rest)); continue; }

    // rename(R) / copy(C) — "old -> new". 새 경로 added; rename 은 old 경로가 사라지므로 deleted(정직보고 — 적대리뷰 P3-a).
    if (x === "R" || y === "R" || x === "C" || y === "C") {
      const { oldPath, newPath } = renamePaths(rest);
      added.add(newPath);
      if ((x === "R" || y === "R") && oldPath.length > 0) deleted.add(oldPath); // copy 는 원본 유지 → deleted 아님
      continue;
    }

    const path = unquote(rest);
    if (x === "D" || y === "D") { deleted.add(path); continue; }
    if (x === "A" || y === "A") { added.add(path); continue; }
    // 그 외(M/T/U 등 내용 변경) = modified.
    modified.add(path);
  }

  // 우선순위 dedup: deleted > added > modified(한 경로는 한 카테고리만).
  for (const p of deleted) { added.delete(p); modified.delete(p); }
  for (const p of added) { modified.delete(p); }

  return {
    added: [...added],
    modified: [...modified],
    deleted: [...deleted],
  };
}

/** rename/copy 줄("old -> new")에서 old·new 경로 추출. ` -> ` 구분자. 각각 unquote. */
function renamePaths(rest: string): { oldPath: string; newPath: string } {
  const idx = rest.indexOf(" -> ");
  if (idx < 0) return { oldPath: "", newPath: unquote(rest) };
  return { oldPath: unquote(rest.slice(0, idx)), newPath: unquote(rest.slice(idx + 4)) };
}

const C_ESCAPES: Record<string, number> = { a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d, '"': 0x22, "\\": 0x5c };

/**
 * porcelain 은 비-ASCII/특수문자 경로를 "..." 로 감싸고 C-스타일 이스케이프(\nnn 8진 바이트·\t\n\"\\ 등)한다.
 * 따옴표 안을 디코드 → 바이트 → UTF-8(한글 등 다국어 경로 정상 복원, 적대리뷰 P2-b). 비-따옴표 경로는 그대로.
 */
function unquote(p: string): string {
  if (!(p.length >= 2 && p.startsWith("\"") && p.endsWith("\""))) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") { bytes.push(body.charCodeAt(i) & 0xff); continue; }
    const next = body[i + 1];
    if (next !== undefined && next >= "0" && next <= "7") {
      let oct = "";
      let j = i + 1;
      while (j < body.length && j < i + 4 && body[j] >= "0" && body[j] <= "7") { oct += body[j]; j++; }
      bytes.push(parseInt(oct, 8) & 0xff);
      i = j - 1;
      continue;
    }
    if (next !== undefined && next in C_ESCAPES) { bytes.push(C_ESCAPES[next]); i++; continue; }
    if (next !== undefined) { bytes.push(next.charCodeAt(0) & 0xff); i++; continue; } // 미지 이스케이프 = 리터럴
  }
  return Buffer.from(bytes).toString("utf8");
}
