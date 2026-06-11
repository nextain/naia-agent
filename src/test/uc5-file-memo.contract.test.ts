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
