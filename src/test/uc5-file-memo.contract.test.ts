// file-memo-store 계약 테스트 — fake in-memory FsLike(실 fs 0).
import { describe, it, expect } from "vitest";
import { makeFileMemoStore, type FsLike } from "../main/adapters/file-memo-store.js";

function fakeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const fs: FsLike = {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => { const v = files.get(p); if (v === undefined) throw new Error("ENOENT"); return v; },
    writeFileSync: (p, d) => { files.set(p, d); },
    renameSync: (a, b) => { const v = files.get(a); if (v === undefined) throw new Error("ENOENT"); files.set(b, v); files.delete(a); },
    mkdirSync: () => {},
  };
  return { files, fs };
}
const P = "/x/memos.json";

describe("makeFileMemoStore (§E memo 영속)", () => {
  it("save → 파일 기록(atomic) + get/list", () => {
    const { files, fs } = fakeFs();
    const s = makeFileMemoStore({ path: P, fs, dir: "/x" });
    s.save("t1", "hello");
    expect(s.get("t1")).toBe("hello");
    expect(s.list()).toEqual(["t1"]);
    expect(JSON.parse(files.get(P)!)).toEqual({ t1: "hello" }); // 본 파일에 기록
    expect(files.has(P + ".tmp")).toBe(false); // temp rename 됨(atomic)
  });
  it("기존 파일 로드 → 채워짐(영속)", () => {
    const { fs } = fakeFs({ [P]: JSON.stringify({ a: "1", b: "2" }) });
    const s = makeFileMemoStore({ path: P, fs, dir: "/x" });
    expect(s.get("a")).toBe("1");
    expect([...s.list()].sort()).toEqual(["a", "b"]);
  });
  it("손상 파일 → 빈 맵 degrade(no-throw)", () => {
    const { fs } = fakeFs({ [P]: "{not json" });
    const s = makeFileMemoStore({ path: P, fs, dir: "/x" });
    expect(s.list()).toEqual([]);
    expect(s.get("a")).toBeNull();
  });
  it("비-string 값 → skip", () => {
    const { fs } = fakeFs({ [P]: JSON.stringify({ a: "ok", b: 123, c: null }) });
    const s = makeFileMemoStore({ path: P, fs, dir: "/x" });
    expect(s.get("a")).toBe("ok");
    expect(s.get("b")).toBeNull();
    expect(s.get("c")).toBeNull();
  });
  it("persist 실패 → map 롤백 + throw(desync 없음)", () => {
    const { fs } = fakeFs();
    fs.writeFileSync = () => { throw new Error("disk full"); };
    const s = makeFileMemoStore({ path: P, fs, dir: "/x" });
    expect(() => s.save("t", "v")).toThrow(/disk full/);
    expect(s.get("t")).toBeNull(); // 신규 항목 롤백
  });
  it("덮어쓰기 persist 실패 → 이전 값 복원", () => {
    const { fs } = fakeFs({ [P]: JSON.stringify({ t: "old" }) });
    const s = makeFileMemoStore({ path: P, fs, dir: "/x" });
    fs.writeFileSync = () => { throw new Error("disk full"); };
    expect(() => s.save("t", "new")).toThrow();
    expect(s.get("t")).toBe("old"); // 이전 값 복원
  });
  it("배열/null 루트 → 빈 맵", () => {
    expect(makeFileMemoStore({ path: P, fs: fakeFs({ [P]: "[1,2]" }).fs, dir: "/x" }).list()).toEqual([]);
    expect(makeFileMemoStore({ path: P, fs: fakeFs({ [P]: "null" }).fs, dir: "/x" }).list()).toEqual([]);
  });
});

// @ts-expect-error runtime MJS composition has no declarations.
import { resolveMemoStorage, prepareMemoStorage, composeAgentRuntimeDeps } from "../../scripts/builds/compose-agent-deps.mjs";
import * as disk from "node:fs";
import { posix, win32, join } from "node:path";
import { tmpdir } from "node:os";

describe("FR-AX-026.14 데이터 홈 경로/이관", () => {
  it.each([
    [posix, "/users/준", "/data/naia dev", "/data/naia dev/memos.json"],
    [win32, "C:\\Users\\준", "D:\\Naia Dev", "D:\\Naia Dev\\memos.json"],
    [win32, "C:\\Users\\준", "\\\\server\\share\\Naia", "\\\\server\\share\\Naia\\memos.json"],
  ])("data home follows injected OS paths (%s)", (pathApi, homeDir, dataHome, expected) => {
    expect(resolveMemoStorage({ env: { NAIA_HOME: ` ${dataHome} ` }, homeDir, pathApi }).path).toBe(expected);
    expect(resolveMemoStorage({ env: { NAIA_HOME: " \t" }, homeDir, pathApi }).path).toBe(pathApi.join(homeDir, ".naia", "memos.json"));
    expect(resolveMemoStorage({ env: { NAIA_HOME: dataHome, NAIA_MEMO_PATH: " " }, homeDir, pathApi }).path).toBe(expected);
    expect(resolveMemoStorage({ env: { NAIA_HOME: dataHome, NAIA_MEMO_PATH: " custom.json " }, homeDir, pathApi })).toMatchObject({ path: "custom.json", migrate: false });
  });

  it("Windows migration passes drive/UNC paths unchanged to filesystem", () => {
    for (const dataHome of ["D:\\Naia Dev", "\\\\server\\share\\Naia"]) {
      const homeDir = "C:\\Users\\준";
      const calls: unknown[] = [];
      const legacy = win32.join(homeDir, ".naia-agent", "memos.json");
      const target = win32.join(dataHome, "memos.json");
      const fs = {
        existsSync: (p: string) => p === legacy,
        mkdirSync: (p: string, opts: unknown) => calls.push(["mkdir", p, opts]),
        copyFileSync: (a: string, b: string, flag: number) => calls.push(["copy", a, b, flag]),
      };
      expect(prepareMemoStorage({ env: { NAIA_HOME: dataHome }, homeDir, fs, pathApi: win32 })).toBe(target);
      expect(calls).toEqual([
        ["mkdir", dataHome, { recursive: true }],
        ["copy", legacy, target, disk.constants.COPYFILE_EXCL],
      ]);
    }
  });

  function layout() {
    const root = disk.mkdtempSync(join(tmpdir(), "r8-memo-"));
    const homeDir = join(root, "home");
    const env = { NAIA_HOME: join(root, "data home") };
    const legacy = join(homeDir, ".naia-agent", "memos.json");
    disk.mkdirSync(join(homeDir, ".naia-agent"), { recursive: true });
    disk.writeFileSync(legacy, JSON.stringify({ old: "합성 메모" }));
    return { root, homeDir, env, legacy };
  }

  it("copies bytes, retains source, restarts without overwriting newer data", () => {
    const l = layout();
    try {
      const target = prepareMemoStorage(l);
      expect(disk.readFileSync(target, "utf8")).toBe(disk.readFileSync(l.legacy, "utf8"));
      disk.writeFileSync(target, '{"new":"newer"}');
      prepareMemoStorage(l);
      expect(disk.readFileSync(target, "utf8")).toBe('{"new":"newer"}');
      expect(JSON.parse(disk.readFileSync(l.legacy, "utf8"))).toEqual({ old: "합성 메모" });
    } finally { disk.rmSync(l.root, { recursive: true, force: true }); }
  });

  it("explicit override never imports legacy data; missing legacy creates no file", () => {
    const l = layout();
    try {
      const target = join(l.root, "explicit.json");
      expect(prepareMemoStorage({ ...l, env: { ...l.env, NAIA_MEMO_PATH: target } })).toBe(target);
      expect(disk.existsSync(target)).toBe(false);
      disk.unlinkSync(l.legacy);
      const fresh = prepareMemoStorage(l);
      expect(disk.existsSync(fresh)).toBe(false);
    } finally { disk.rmSync(l.root, { recursive: true, force: true }); }
  });

  it("copy uses exclusive flag, handles EEXIST race, and surfaces permission failures", () => {
    const copyFileSync = (_a: string, _b: string, flag: number) => {
      expect(flag).toBe(disk.constants.COPYFILE_EXCL);
      throw Object.assign(new Error("race"), { code: "EEXIST" });
    };
    const fs = { existsSync: (p: string) => p.includes(".naia-agent"), mkdirSync: () => {}, copyFileSync };
    expect(prepareMemoStorage({ env: {}, homeDir: "/h", pathApi: posix, fs })).toBe("/h/.naia/memos.json");
    fs.copyFileSync = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
    expect(() => prepareMemoStorage({ env: {}, homeDir: "/h", pathApi: posix, fs })).toThrow("memo storage migration failed");
  });

  it("shared runtime reads migrated memo and saves only to selected data home", async () => {
    const l = layout();
    let deps: Awaited<ReturnType<typeof composeAgentRuntimeDeps>> = undefined;
    try {
      deps = await composeAgentRuntimeDeps({ homeDir: l.homeDir, env: {
        ...l.env, AGENT_PROVIDER: "fake", NAIA_AGENT_MEMORY: "off", NAIA_AGENT_TRANSCRIPT: "off",
      } });
      const call = (name: string, args: object) => deps.toolExecutor.execute({ id: "r8", name, args }, new AbortController().signal);
      expect(await call("memo_get", { title: "old" })).toMatchObject({ output: "합성 메모" });
      expect(await call("memo_save", { title: "new", content: "new content" })).not.toMatchObject({ isError: true });
      expect(await call("memo_list", {})).toMatchObject({ output: "old\nnew" });
      expect(JSON.parse(disk.readFileSync(join(l.env.NAIA_HOME, "memos.json"), "utf8"))).toEqual({ old: "합성 메모", new: "new content" });
      expect(JSON.parse(disk.readFileSync(l.legacy, "utf8"))).toEqual({ old: "합성 메모" });
    } finally {
      for (const cleanup of deps?.cleanupFns ?? []) await cleanup();
      disk.rmSync(l.root, { recursive: true, force: true });
    }
  });
});
