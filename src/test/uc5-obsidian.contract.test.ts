// obsidian-skills 계약 테스트(§F) — 주입 fake fs(실 파일시스템 0). 경로격리·cap·no-throw·abort.
import { describe, it, expect } from "vitest";
import { makeObsidianSkillsExecutor, type ObsidianFsLike } from "../main/adapters/obsidian-skills.js";
import type { ToolCall } from "../main/domain/chat.js";

const CALL = (name: string, args: unknown): ToolCall => ({ id: "c", name, args });

// 메모리 vault: { "rel/path.md": "content" }. 디렉터리는 경로 prefix 로 추론.
function fakeFs(files: Record<string, string>, opts: { sizes?: Record<string, number>; calls?: { readdir: string[]; stat: string[]; readFile: string[] } } = {}): ObsidianFsLike {
  const VAULT = "/vault";
  const rel = (p: string): string | null => (p === VAULT ? "" : p.startsWith(VAULT + "/") ? p.slice(VAULT.length + 1) : null);
  const allRels = Object.keys(files);
  const calls = opts.calls;
  return {
    existsSync: (p) => { const r = rel(p); return r !== null && (r === "" || r in files || allRels.some((k) => k.startsWith(r + "/"))); },
    readFileSync: (p) => { calls?.readFile.push(p); const r = rel(p); if (r === null || !(r in files)) throw new Error("ENOENT"); return files[r]; },
    readdirSync: (p) => {
      calls?.readdir.push(p); const r = rel(p);
      if (r === null) throw new Error("ENOENT");
      const prefix = r === "" ? "" : r + "/";
      const names = new Set<string>();
      for (const k of allRels) { if (k.startsWith(prefix)) { const rest = k.slice(prefix.length); names.add(rest.split("/")[0]); } }
      if (!names.size && r !== "") throw new Error("ENOTDIR");
      return [...names];
    },
    statSync: (p) => {
      calls?.stat.push(p); const r = rel(p);
      if (r === null) throw new Error("ENOENT");
      const isFile = r in files;
      const isDir = r === "" || allRels.some((k) => k.startsWith(r + "/"));
      if (!isFile && !isDir) throw new Error("ENOENT");
      return { isFile: () => isFile && !isDir, isDirectory: () => isDir, size: opts.sizes?.[r] ?? (files[r]?.length ?? 0) };
    },
  };
}
const ex = (files: Record<string, string>, o?: Parameters<typeof fakeFs>[1]) => makeObsidianSkillsExecutor({ vaultDir: "/vault", fs: fakeFs(files, o) });

describe("makeObsidianSkillsExecutor (S24)", () => {
  it("(a) list_notes → .md 상대경로 재귀(비-.md 제외)", async () => {
    const r = await ex({ "a.md": "x", "sub/b.md": "y", "note.txt": "z", "sub/c.png": "w" }).execute(CALL("obsidian_list_notes", {}), {});
    const lines = r.output.split("\n").sort();
    expect(lines).toEqual(["a.md", "sub/b.md"]);
  });
  it("(b) read_note(유효) → 내용", async () => {
    expect((await ex({ "n.md": "hello" }).execute(CALL("obsidian_read_note", { path: "n.md" }), {})).output).toBe("hello");
  });
  it("(c) search → query 포함 노트만", async () => {
    const r = await ex({ "a.md": "apple pie", "b.md": "banana", "c.md": "APPLE juice" }).execute(CALL("obsidian_search", { query: "apple" }), {});
    expect(r.output.split("\n").sort()).toEqual(["a.md", "c.md"]);
  });
  it("(d) 경로탈출·절대·중간상위참조·nullbyte → isError(fs read 미발생)", async () => {
    const calls = { readdir: [] as string[], stat: [] as string[], readFile: [] as string[] };
    const e = makeObsidianSkillsExecutor({ vaultDir: "/vault", fs: fakeFs({ "n.md": "x" }, { calls }) });
    for (const p of ["../etc.md", "/etc/passwd.md", "a/../b.md", "a\0b.md", "..\\x.md", "a\\..\\b.md", "\\abs.md"]) {
      expect((await e.execute(CALL("obsidian_read_note", { path: p }), {})).isError).toBe(true);
    }
    expect(calls.readFile.length).toBe(0); // 탈출 경로로 fs read 안 함(역슬래시 변형 포함)
  });
  it("(e) read 비-.md → isError", async () => {
    expect((await ex({ "n.txt": "x" }).execute(CALL("obsidian_read_note", { path: "n.txt" }), {})).isError).toBe(true);
  });
  it("(f) arg 비객체/배열/path non-string → isError", async () => {
    const e = ex({ "n.md": "x" });
    expect((await e.execute(CALL("obsidian_read_note", null), {})).isError).toBe(true);
    expect((await e.execute(CALL("obsidian_read_note", []), {})).isError).toBe(true);
    expect((await e.execute(CALL("obsidian_read_note", { path: 5 }), {})).isError).toBe(true);
  });
  it("(g) getter throw args → isError(no-throw)", async () => {
    const bad = new Proxy({}, { get(_t, p) { if (p === "path") throw new Error("boom"); return undefined; } }) as unknown;
    const r = await ex({ "n.md": "x" }).execute(CALL("obsidian_read_note", bad), {});
    expect(r.isError).toBe(true);
  });
  it("(h) 이미 aborted signal → reject(진입)", async () => {
    const ac = new AbortController(); ac.abort();
    await expect(ex({ "n.md": "x" }).execute(CALL("obsidian_list_notes", {}), { signal: ac.signal })).rejects.toThrow();
  });
  it("(i) 이른 fs 호출 직후 abort → 이후 fs 호출 없음·reject", async () => {
    const calls = { readdir: [] as string[], stat: [] as string[], readFile: [] as string[] };
    const ac = new AbortController();
    const baseFs = fakeFs({ "a.md": "x", "b.md": "y", "sub/c.md": "z" }, { calls });
    // 첫 readdir 후 abort 신호 ON → 다음 fs 가드가 throw
    const fs: ObsidianFsLike = { ...baseFs, readdirSync: (p) => { const out = baseFs.readdirSync(p); ac.abort(); return out; } };
    const e = makeObsidianSkillsExecutor({ vaultDir: "/vault", fs });
    await expect(e.execute(CALL("obsidian_list_notes", {}), { signal: ac.signal })).rejects.toThrow();
    expect(calls.stat.length).toBe(0); // readdir 후 abort → stat 안 함
  });
  it("(h2) read_note 이미 aborted → reject·existsSync 등 fs 미호출", async () => {
    const calls = { readdir: [] as string[], stat: [] as string[], readFile: [] as string[] };
    let exists = 0;
    const base = fakeFs({ "n.md": "x" }, { calls });
    const fs: ObsidianFsLike = { ...base, existsSync: (p) => { exists++; return base.existsSync(p); } };
    const ac = new AbortController(); ac.abort();
    await expect(makeObsidianSkillsExecutor({ vaultDir: "/vault", fs }).execute(CALL("obsidian_read_note", { path: "n.md" }), { signal: ac.signal })).rejects.toThrow();
    expect(exists + calls.stat.length + calls.readFile.length).toBe(0); // existsSync 도 호출 안 함
  });
  it("(i2) 마지막 fs 호출(stat) 후 abort → reject(success 반환 금지, 터미널 케이스)", async () => {
    const ac = new AbortController();
    const base = fakeFs({ "n.md": "x" }); // 단일 .md → 마지막 stat 이 곧 종점
    // statSync 가 .md 파일에 대해 호출되면 반환 후 abort ON → 직후 가드가 reject 해야
    const fs: ObsidianFsLike = { ...base, statSync: (p) => { const st = base.statSync(p); if (p.endsWith("n.md")) ac.abort(); return st; } };
    await expect(makeObsidianSkillsExecutor({ vaultDir: "/vault", fs }).execute(CALL("obsidian_list_notes", {}), { signal: ac.signal })).rejects.toThrow();
  });
  it("(j) vaultDir/fs 미주입 → unavailable isError", async () => {
    expect((await makeObsidianSkillsExecutor({}).execute(CALL("obsidian_list_notes", {}), {})).isError).toBe(true);
  });
  it("(k) read 1MB 초과 → isError", async () => {
    const r = await ex({ "big.md": "x" }, { sizes: { "big.md": 2 * 1024 * 1024 } }).execute(CALL("obsidian_read_note", { path: "big.md" }), {});
    expect(r.isError).toBe(true);
  });
  it("(m) 미등록 name → isError", async () => {
    expect((await ex({ "n.md": "x" }).execute(CALL("obsidian_unknown", {}), {})).isError).toBe(true);
  });
  it("(n) 전 도구 tier none(읽기)", () => {
    const specs = makeObsidianSkillsExecutor({ vaultDir: "/vault", fs: fakeFs({}) }).specs();
    expect(specs.every((s) => s.tier === undefined || s.tier === "none")).toBe(true);
  });
  it("(o) search: per-note 1MB 초과 파일 read 생략", async () => {
    const calls = { readdir: [] as string[], stat: [] as string[], readFile: [] as string[] };
    const e = makeObsidianSkillsExecutor({ vaultDir: "/vault", fs: fakeFs({ "big.md": "needle", "small.md": "needle" }, { sizes: { "big.md": 2 * 1024 * 1024, "small.md": 6 }, calls }) });
    const r = await e.execute(CALL("obsidian_search", { query: "needle" }), {});
    expect(r.output.split("\n")).toEqual(["small.md"]); // big.md 는 크기초과 skip
    expect(calls.readFile.some((p) => p.endsWith("big.md"))).toBe(false); // big.md read 미발생
  });
  it("(d2) folder 경로격리 — 전 벡터(상위참조·중간상위참조·단일dot·빈세그먼트·절대·nullbyte) → isError·fs 미호출", async () => {
    const calls = { readdir: [] as string[], stat: [] as string[], readFile: [] as string[] };
    const e = makeObsidianSkillsExecutor({ vaultDir: "/vault", fs: fakeFs({ "n.md": "x" }, { calls }) });
    for (const folder of ["..", "../x", "a/../b", ".", "a//b", "/abs", "a\0b", "..\\x", "a\\..\\b", "a\\\\b", "\\abs"]) {
      expect((await e.execute(CALL("obsidian_list_notes", { folder }), {})).isError).toBe(true);
      expect((await e.execute(CALL("obsidian_search", { query: "q", folder }), {})).isError).toBe(true);
    }
    expect(calls.readdir.length + calls.stat.length + calls.readFile.length).toBe(0); // 탈출 folder 로 fs 호출 안 함
  });
  it("(u) folder 유효 scoping → 해당 하위만 열거", async () => {
    const r = await ex({ "top.md": "x", "sub/a.md": "y", "sub/b.md": "z", "other/c.md": "w" }).execute(CALL("obsidian_list_notes", { folder: "sub" }), {});
    expect(r.output.split("\n").sort()).toEqual(["sub/a.md", "sub/b.md"]); // sub/ 만, top·other 제외
  });
  it("(t) search 도 scan-node cap(5000) 적용 → 후보 절단 시 '더 있음'", async () => {
    const calls = { readdir: [] as string[], stat: [] as string[], readFile: [] as string[] };
    const files: Record<string, string> = {};
    for (let i = 0; i < 7000; i++) files[`d/f${i}.txt`] = "needle"; // 비-.md 7000 → 매칭 0 이나 scan cap
    const r = await ex(files, { calls }).execute(CALL("obsidian_search", { query: "needle" }), {});
    expect(r.output).toContain("한도 도달"); // 후보 스캔 절단 마커(silent 금지)
    expect(calls.readdir.length + calls.stat.length).toBeLessThanOrEqual(5000 + 10);
  });
  it("(l) list 결과 cap(500) 초과 → '더 있음' 마커", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 600; i++) files[`n${i}.md`] = "x"; // 600 .md, 노드 수 < 5000
    const r = await ex(files).execute(CALL("obsidian_list_notes", {}), {});
    const lines = r.output.split("\n");
    expect(lines.length).toBe(501); // 500 결과 + 마커 1줄
    expect(lines[500]).toContain("더 있음");
  });
  it("(p) fs 스캔 노드 cap(5000) → 순회 중단 + '더 있음'(방문 노드 ≤ cap+상수)", async () => {
    const calls = { readdir: [] as string[], stat: [] as string[], readFile: [] as string[] };
    const files: Record<string, string> = {};
    // 비-.md 7000개(결과 cap 안 맞고 scan cap 만 걸리도록) — list 결과는 0~적지만 스캔은 cap 에서 멈춰야
    for (let i = 0; i < 7000; i++) files[`d/f${i}.txt`] = "x";
    const r = await ex(files, { calls }).execute(CALL("obsidian_list_notes", {}), {});
    expect(r.output).toContain("한도 도달"); // scan cap 도달 마커(빈 결과여도 silent 금지)
    expect(calls.readdir.length + calls.stat.length).toBeLessThanOrEqual(5000 + 10); // 방문 노드 bound
  });
  it("(q) search 결과 cap(100) — scan-node cap 과 직교", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 150; i++) files[`m${i}.md`] = "needle here"; // 150 매칭, 노드<5000
    const r = await ex(files).execute(CALL("obsidian_search", { query: "needle" }), {});
    const lines = r.output.split("\n");
    expect(lines.filter((l) => l.endsWith(".md")).length).toBe(100); // 결과 ≤100
    expect(r.output).toContain("더 있");
  });
  it("(s) search query 길이 초과(1000) → isError(fs 미호출)", async () => {
    const calls = { readdir: [] as string[], stat: [] as string[], readFile: [] as string[] };
    const e = makeObsidianSkillsExecutor({ vaultDir: "/vault", fs: fakeFs({ "n.md": "x" }, { calls }) });
    const r = await e.execute(CALL("obsidian_search", { query: "z".repeat(1001) }), {});
    expect(r.isError).toBe(true);
    expect(calls.readdir.length + calls.stat.length + calls.readFile.length).toBe(0); // fs 호출 전 거부
  });
  it("(v) search 가 500번째 너머 노트도 검색(결과 cap 에 묶이지 않음)", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 600; i++) files[`n${String(i).padStart(3, "0")}.md`] = i === 550 ? "unique-needle" : "filler";
    const r = await ex(files).execute(CALL("obsidian_search", { query: "unique-needle" }), {});
    expect(r.output).toContain("n550.md"); // 500 후보 cap 이었다면 누락됐을 노트
  });
  it("(w) walk 중 fs throw(non-abort) → isError(silent 부분결과 아님)", async () => {
    const base = fakeFs({ "a.md": "x", "bad/c.md": "y" });
    const fs: ObsidianFsLike = { ...base, statSync: (p) => { if (p.endsWith("/bad")) throw new Error("EACCES"); return base.statSync(p); } };
    const r = await makeObsidianSkillsExecutor({ vaultDir: "/vault", fs }).execute(CALL("obsidian_list_notes", {}), {});
    expect(r.isError).toBe(true); // fs 실패 = 단일 에러경계로 isError(부분결과 silent 금지)
  });
  it("(x) safeSegs 는 trim 안 함 — 선행 공백 경로는 다른 파일로 변조하지 않음", async () => {
    // " a.md" 는 실제 키 "a.md" 와 다른 파일 → 미존재 → not found(변조해서 a.md 읽지 않음)
    const r = await ex({ "a.md": "real" }).execute(CALL("obsidian_read_note", { path: " a.md" }), {});
    expect(r.output).not.toBe("real"); // trim 됐다면 "real" 반환됐을 것
  });
  it("(r) read 8000자 soft truncation → '…(생략)' 가시 마커(1MB 미만)", async () => {
    const big = "a".repeat(10000); // 10000자, 1MB 미만
    const r = await ex({ "long.md": big }).execute(CALL("obsidian_read_note", { path: "long.md" }), {});
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("생략");
    expect(r.output.length).toBeLessThanOrEqual(8000 + 20); // 8000 + 마커
  });
});
