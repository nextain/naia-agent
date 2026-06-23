// UC-CLI workspace-git 어댑터 계약(2c) — WorkspacePort 실 어댑터를 FAKE git runner 로 결정론 검증.
// (1) git status --porcelain 분류(A · ?? · ' M' · ' D' · 'R ' rename) (2) 폴링이 변경 시 새 스냅샷 yield + 동일 de-dupe
// (3) signal.abort() 가 스트림 종결(인터벌 누수 0). + classifyPorcelain 순수 단위 + stub-detector.
import { describe, it, expect } from "vitest";
import { makeGitWorkspace, classifyPorcelain, type GitRunner } from "../main/adapters/workspace-git.js";
import type { WorkspaceChange } from "../main/domain/orchestration.js";

function sortedChange(c: WorkspaceChange): { added: string[]; modified: string[]; deleted: string[] } {
  return { added: [...c.added].sort(), modified: [...c.modified].sort(), deleted: [...c.deleted].sort() };
}

describe("classifyPorcelain 순수 분류 계약 (2c)", () => {
  it("A / ?? → added, ' M'/'MM' → modified, ' D'/'D ' → deleted, 'R ' rename → 새 경로 added + old deleted", () => {
    const porcelain = [
      "A  staged-new.ts",   // index added
      "?? untracked.ts",    // untracked
      " M worktree-mod.ts", // worktree modified
      "MM both-mod.ts",     // index+worktree modified
      " D worktree-del.ts", // worktree deleted
      "D  staged-del.ts",   // index deleted
      "R  old.ts -> renamed-new.ts", // rename → 새 경로 added + old 경로 deleted(정직보고)
    ].join("\n");
    const c = sortedChange(classifyPorcelain(porcelain));
    expect(c.added).toEqual(["renamed-new.ts", "staged-new.ts", "untracked.ts"]);
    expect(c.modified).toEqual(["both-mod.ts", "worktree-mod.ts"]);
    expect(c.deleted).toEqual(["old.ts", "staged-del.ts", "worktree-del.ts"]); // rename old.ts 포함(P3-a)
  });

  it("빈 출력 → 빈 변경(crash 없음)", () => {
    expect(classifyPorcelain("")).toEqual({ added: [], modified: [], deleted: [] });
  });

  it("우선순위 dedup — 같은 경로는 deleted > added > modified 단일 분류", () => {
    // ' D' 줄과 (가상의) modified 줄이 같은 경로면 deleted 만 남아야 함.
    const c = sortedChange(classifyPorcelain([" D dup.ts", " M dup.ts"].join("\n")));
    expect(c.deleted).toEqual(["dup.ts"]);
    expect(c.modified).toEqual([]);
    expect(c.added).toEqual([]);
  });

  it("따옴표 경로 unquote (공백/특수문자 경로)", () => {
    const c = sortedChange(classifyPorcelain("?? \"has space.ts\""));
    expect(c.added).toEqual(["has space.ts"]);
  });

  it("한글/비-ASCII 경로 — git C-quoting(8진 escape) 디코드(적대리뷰 P2-b)", () => {
    // git 은 core.quotePath 로 비-ASCII 를 따옴표+8진 바이트로 출력. 실 UTF-8 바이트에서 git 방식대로
    // quoted 입력을 구성(self-verifying — 손계산 8진 오류 방지): ASCII 는 리터럴, 비-ASCII 는 \nnn.
    const name = "한글파일.ts";
    const octal = Array.from(Buffer.from(name, "utf8"))
      .map((b) => (b < 0x80 ? String.fromCharCode(b) : "\\" + b.toString(8).padStart(3, "0")))
      .join("");
    const c = classifyPorcelain(`?? "${octal}"`);
    expect(c.added).toEqual([name]); // 8진 바이트 → UTF-8 한글 정상 복원(\nnn 잔재 0)
  });

  it("rename 한글 old/new 도 디코드 + old deleted", () => {
    // "구.ts" -> "신.ts" (둘 다 ASCII 가정 — 디코드는 위에서 검증, 여기선 rename old→deleted 경로)
    const c = sortedChange(classifyPorcelain("R  gu.ts -> sin.ts"));
    expect(c.added).toEqual(["sin.ts"]);
    expect(c.deleted).toEqual(["gu.ts"]);
  });
});

describe("UC-CLI workspace-git 어댑터 계약 (2c, fake git runner — 폴링/abort)", () => {
  /** 호출마다 다음 porcelain 출력을 반환하는 fake runner(마지막 값으로 고정). 호출 횟수 기록. */
  function scriptedRunner(outputs: readonly string[]) {
    const calls: string[][] = [];
    let i = 0;
    const runGit: GitRunner = async (_workdir, args) => {
      calls.push([...args]);
      const out = outputs[Math.min(i, outputs.length - 1)] ?? "";
      i++;
      return out;
    };
    return { runGit, calls };
  }

  async function takeN(it: AsyncIterable<WorkspaceChange>, n: number): Promise<WorkspaceChange[]> {
    const out: WorkspaceChange[] = [];
    for await (const c of it) {
      out.push(c);
      if (out.length >= n) break; // break → iterator.return() → 인터벌 정리
    }
    return out;
  }

  it("git status 분류 — porcelain 출력이 added/modified/deleted 로 정확히 분류된 스냅샷 yield", async () => {
    const { runGit, calls } = scriptedRunner(["A  new.ts\n M mod.ts\n D del.ts\n"]);
    const ws = makeGitWorkspace({ pollMs: 10, runGit });
    const ac = new AbortController();
    const [snap] = await takeN(ws.changes("/repo", ac.signal), 1);
    ac.abort();
    expect(sortedChange(snap)).toEqual({ added: ["new.ts"], modified: ["mod.ts"], deleted: ["del.ts"] });
    expect(calls[0]).toEqual(["status", "--porcelain"]); // 실제로 git status --porcelain 폴링
  });

  it("폴링 — git 출력이 바뀌면 새 스냅샷 yield, 동일하면 de-dupe(불변 시 추가 yield 없음)", async () => {
    // 출력: [A] → [A] (동일, de-dupe) → [A,M] (변경, 새 스냅샷). 2개만 yield 돼야 함.
    const { runGit } = scriptedRunner([
      "A  a.ts\n",
      "A  a.ts\n",        // 동일 → de-dupe
      "A  a.ts\n M b.ts\n", // 변경 → 새 스냅샷
    ]);
    const ws = makeGitWorkspace({ pollMs: 5, runGit });
    const ac = new AbortController();
    const snaps = await takeN(ws.changes("/repo", ac.signal), 2);
    ac.abort();
    expect(snaps).toHaveLength(2);
    expect(sortedChange(snaps[0])).toEqual({ added: ["a.ts"], modified: [], deleted: [] });
    expect(sortedChange(snaps[1])).toEqual({ added: ["a.ts"], modified: ["b.ts"], deleted: [] }); // 동일 스냅샷은 건너뜀
  });

  it("signal.abort() → 스트림 종결(async iterable 이 done) — 인터벌 누수 없음", async () => {
    const { runGit } = scriptedRunner(["A  x.ts\n"]); // 이후 변경 없음 → 첫 스냅샷 후 영구 대기였을 것
    const ws = makeGitWorkspace({ pollMs: 5, runGit });
    const ac = new AbortController();
    const it = ws.changes("/repo", ac.signal)[Symbol.asyncIterator]();

    const first = await it.next();
    expect(first.done).toBe(false);
    expect(sortedChange(first.value)).toEqual({ added: ["x.ts"], modified: [], deleted: [] });

    // 변경이 더 없으므로 next() 는 pending — abort 가 그것을 done 으로 풀어야 함(누수면 영구 hang).
    const pending = it.next();
    ac.abort();
    const after = await pending;
    expect(after.done).toBe(true); // abort → 스트림 종결(누수 0 증명: hang 안 함)
  });

  it("abort 후 시작 = 즉시 빈 스트림(crash 없음)", async () => {
    const { runGit } = scriptedRunner(["A  x.ts\n"]);
    const ws = makeGitWorkspace({ pollMs: 5, runGit });
    const ac = new AbortController();
    ac.abort(); // iterate 전 이미 abort
    const out = await takeN(ws.changes("/repo", ac.signal), 5);
    expect(out).toEqual([]); // 즉시 done
  });

  it("git 실패(runner throw) → 폴링이 깨지지 않고 빈 스냅샷으로 계속(never-throws)", async () => {
    let calls = 0;
    const runGit: GitRunner = async () => {
      calls++;
      if (calls === 1) throw new Error("not a git repo"); // 첫 poll throw
      return "A  recovered.ts\n"; // 둘째 poll 정상
    };
    const ws = makeGitWorkspace({ pollMs: 5, runGit });
    const ac = new AbortController();
    const [snap] = await takeN(ws.changes("/repo", ac.signal), 1); // throw 를 흡수하고 둘째 poll 의 스냅샷
    ac.abort();
    expect(sortedChange(snap)).toEqual({ added: ["recovered.ts"], modified: [], deleted: [] });
  });

  // ── stub-detector: fake runner 의 출력이 실제로 스냅샷을 좌우하는가 ──
  it("stub-detector — runner 가 실제로 호출되고 그 출력이 분류 결과로 관통(seam 살아있음)", async () => {
    let invoked = false;
    const SENTINEL = "SENTINEL_FILE_ZZZ.ts";
    const runGit: GitRunner = async () => { invoked = true; return `?? ${SENTINEL}\n`; };
    const ws = makeGitWorkspace({ pollMs: 5, runGit });
    const ac = new AbortController();
    const [snap] = await takeN(ws.changes("/repo", ac.signal), 1);
    ac.abort();
    expect(invoked).toBe(true);                  // runGit 이 실제로 불림
    expect(snap.added).toContain(SENTINEL);      // fake 출력이 분류 결과로 관통(항상참 아님)
  });
});
