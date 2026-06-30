// UC-FS-TOOLS 계약 테스트(S3) — 보안 중심. 주입 fake fs/exec(실 파일시스템·실 프로세스 0).
// sandbox 단위(validatePath/isSensitivePath) + realpath/TOCTOU + 도구 계약(fs-tools/shell-tool) + 민감경로 실증.
// ⚠️ F-SEC01: 실 키/시크릿 미접근 — 모든 경로는 **가짜**. allow-root 는 가공 디렉터리(/ws).
import { describe, it, expect } from "vitest";
import { validatePath, isSensitivePath, isSettingsWriteFenced, type SandboxPolicy } from "../main/domain/fs-sandbox.js";
import { makeFsTools, type FsToolsFsLike } from "../main/adapters/fs-tools.js";
import { makeShellTool, type ShellExecFn, type ShellExecResult } from "../main/adapters/shell-tool.js";
import type { ToolCall } from "../main/domain/chat.js";

const ROOT = "/ws"; // 가공 allow-root(절대). 실 워크스페이스 아님.
const POLICY: SandboxPolicy = { allowRoots: [ROOT] };
const CALL = (name: string, args: unknown): ToolCall => ({ id: "c", name, args });

// ─────────────────────────────────────────────────────────────────────────────
// 1) sandbox 단위 — validatePath (순수 정책)
// ─────────────────────────────────────────────────────────────────────────────
describe("validatePath (domain — 순수 sandbox 정책)", () => {
  it("(a) allow-root 안 상대경로 허용 → normalized 절대경로", () => {
    const r = validatePath("docs/readme.md", POLICY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe("/ws/docs/readme.md");
  });
  it("(b) allow-root 자체 허용", () => {
    expect(validatePath("/ws", POLICY).ok).toBe(true);
    expect(validatePath(".", POLICY).ok).toBe(true); // 루트 자체로 정규화
  });
  it("(c) `..` 상위탈출 거부", () => {
    expect(validatePath("../etc/passwd", POLICY).ok).toBe(false);
    expect(validatePath("docs/../../escape", POLICY).ok).toBe(false);
    expect(validatePath("a/b/../../../out", POLICY).ok).toBe(false);
  });
  it("(d) Windows 드라이브 절대경로(다른 드라이브) 거부", () => {
    expect(validatePath("C:\\Windows\\system32", POLICY).ok).toBe(false);
    expect(validatePath("D:/secret", POLICY).ok).toBe(false);
  });
  it("(e) UNC 경로 거부", () => {
    expect(validatePath("\\\\server\\share", POLICY).ok).toBe(false);
  });
  it("(f) env 확장(%X%/$X/${X}) 거부", () => {
    expect(validatePath("%USERPROFILE%/x", POLICY).ok).toBe(false);
    expect(validatePath("$HOME/x", POLICY).ok).toBe(false);
    expect(validatePath("${HOME}/x", POLICY).ok).toBe(false);
    expect(validatePath("docs/$SECRET", POLICY).ok).toBe(false);
  });
  it("(g) 널바이트 거부", () => {
    expect(validatePath("docs/x\0.md", POLICY).ok).toBe(false);
  });
  it("(h) allow-root 밖 절대경로 거부", () => {
    expect(validatePath("/etc/passwd", POLICY).ok).toBe(false);
    expect(validatePath("/wsx/sneaky", POLICY).ok).toBe(false); // 세그먼트 경계: /ws 가 /wsx 를 prefix 로 오인 X
  });
  it("(i) 빈 allow-root = deny-all", () => {
    expect(validatePath("docs/x", { allowRoots: [] }).ok).toBe(false);
  });
  it("(j) 빈 문자열/비-string 거부", () => {
    expect(validatePath("", POLICY).ok).toBe(false);
    // @ts-expect-error 의도적 비-string
    expect(validatePath(undefined, POLICY).ok).toBe(false);
  });
  it("(k) 역슬래시 구분자 정규화(Windows 입력) — 안전한 상대경로는 허용", () => {
    const r = validatePath("docs\\sub\\note.md", POLICY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe("/ws/docs/sub/note.md");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) sandbox 단위 — denylist (isSensitivePath / validatePath denylist)
// ─────────────────────────────────────────────────────────────────────────────
describe("denylist (민감경로 — allow-root 안이라도 거부)", () => {
  // 전부 가짜 경로(allow-root /ws 하위). 실제 키 미접근.
  const denied = [
    "naia-settings/.keys/x.dpapi",   // .keys 세그먼트 + .dpapi 접미사
    "naia-settings/.keys/anything",  // .keys 세그먼트
    ".env",
    "sub/.env",
    ".env.production",
    "config/.env.local",
    "data-private/secret.txt",
    "data-business/deal.json",
    ".ssh/id_rsa",
    "keys/id_rsa",
    "keys/id_ed25519",
    "certs/server.pem",
    "certs/private.key",
    "sign/cert.pfx",
    "vault/key.age",
    ".git/config",
    "deep/path/.git/objects/ab/cd",
    // ── S3 codex-review 확장 denylist ──
    "secret/token.txt",                 // secret 세그먼트
    "secrets/db.json",                  // secrets 세그먼트
    "home/.gnupg/secring.gpg",          // .gnupg 세그먼트(+ .gpg 접미사)
    "home/.password-store/site.gpg",    // .password-store 세그먼트
    "deploy/service-account.json",      // 정확 파일명 + service-account substring
    ".ssh/authorized_keys",             // authorized_keys 파일명(+ .ssh 세그먼트)
    "ssh/known_hosts",                  // known_hosts 파일명
    "home/.git-credentials",            // git 평문 자격증명
    "ci/gha-creds",                     // GitHub Actions creds
    "ci/wif-config.json",               // WIF 구성
    "gcp/project-key.json",             // -key.json substring
    "var/run/secrets/serviceaccount/token", // /serviceaccount substring(+ secrets 세그먼트)
  ];
  for (const p of denied) {
    it(`거부: ${p}`, () => {
      const r = validatePath(p, POLICY);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/sensitive|denylist/i);
    });
  }
  it("대소문자 무관 — .KEYS / .DPAPI 도 거부", () => {
    expect(validatePath("naia-settings/.KEYS/X.DPAPI", POLICY).ok).toBe(false);
  });
  it("일반(비민감) 파일은 통과", () => {
    expect(validatePath("docs/readme.md", POLICY).ok).toBe(true);
    expect(validatePath("src/main/x.ts", POLICY).ok).toBe(true);
    expect(isSensitivePath("/ws/docs/readme.md")).toBe(false);
  });
});

describe("isSettingsWriteFenced (설정 쓰기-펜스 — write 전용, FR-KB-OS.9)", () => {
  it("naia-settings/ 하위 = 펜스(true)", () => {
    for (const p of [
      "/ws/naia-settings",
      "/ws/naia-settings/knowledge.json",
      "/ws/naia-settings/config.json",
      "/ws/naia-settings/.keys/k.dpapi",
      "/ws/NAIA-SETTINGS/config.json", // 대소문자 무관
    ])
      expect(isSettingsWriteFenced(p, [ROOT])).toBe(true);
  });
  it("naia-settings 밖 = 펜스 아님(false) — 일반 워크스페이스/유사이름", () => {
    for (const p of [
      "/ws/docs/x.md",
      "/ws/knowledge/default/kb.json",
      "/ws/naia-settings-backup/x", // prefix 유사하지만 다른 디렉터리
    ])
      expect(isSettingsWriteFenced(p, [ROOT])).toBe(false);
  });
  it("빈 allowRoots = 펜스 안 함(컨테인먼트는 validatePath 가 별도 담당)", () => {
    expect(isSettingsWriteFenced("/ws/naia-settings/x", [])).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fake fs — 인메모리. realpathSync 는 명시 링크맵으로 swap 시뮬(TOCTOU).
// ─────────────────────────────────────────────────────────────────────────────
interface FakeFsOpts {
  /** 정규화 경로 → 실제 경로(realpath swap). 없으면 항등. */
  links?: Record<string, string>;
  dirs?: string[];
  sizes?: Record<string, number>;
  calls?: { read: string[]; write: string[] };
  /** lstat 가 symlink 로 보고할 경로(write 대상 symlink 거부 시뮬). */
  symlinks?: string[];
}
function fakeFs(files: Record<string, string>, opts: FakeFsOpts = {}): FsToolsFsLike {
  const dirs = new Set(["/ws", ...(opts.dirs ?? [])]);
  const links = opts.links ?? {};
  const symlinks = new Set(opts.symlinks ?? []);
  const exists = (p: string) => p in files || dirs.has(p) || p in links;
  const real = (p: string) => links[p] ?? p;
  return {
    existsSync: (p) => exists(p),
    realpathSync: (p) => { if (!exists(p)) throw new Error("ENOENT"); return real(p); },
    lstatSync: (p) => ({ isSymbolicLink: () => symlinks.has(p) }),
    readFileSync: (p) => { opts.calls?.read.push(p); const t = real(p); if (!(t in files)) throw new Error("ENOENT"); return files[t]; },
    readdirSync: (p) => {
      const t = real(p);
      if (!dirs.has(t)) throw new Error("ENOTDIR");
      const prefix = t === "/ws" ? "/ws/" : t + "/";
      const names = new Set<string>();
      for (const k of [...Object.keys(files), ...dirs]) {
        if (k !== t && k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0]);
      }
      return [...names].map((name) => {
        const full = prefix + name;
        const isDir = dirs.has(full) || [...Object.keys(files), ...dirs].some((k) => k.startsWith(full + "/"));
        return { name, isDirectory: () => isDir, isFile: () => !isDir && full in files };
      });
    },
    writeFileSync: (p, data) => { opts.calls?.write.push(p); const t = real(p); files[t] = data; },
    statSync: (p) => {
      const t = real(p);
      const isFile = t in files;
      const isDir = dirs.has(t);
      if (!isFile && !isDir) throw new Error("ENOENT");
      return { isFile: () => isFile, isDirectory: () => isDir, size: opts.sizes?.[t] ?? (files[t]?.length ?? 0) };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) realpath / TOCTOU — symlink/junction 탈출 차단
// ─────────────────────────────────────────────────────────────────────────────
describe("realpath/TOCTOU (symlink·junction 탈출 차단)", () => {
  it("(a) realpath 가 allow-root 밖을 가리키면 read 거부(문자열은 통과해도)", async () => {
    // /ws/link 는 문자열상 allow-root 안이지만 realpath 가 /etc/passwd(밖)로 swap.
    const calls = { read: [] as string[], write: [] as string[] };
    const fs = fakeFs({ "/etc/passwd": "root:x:0:0" }, { links: { "/ws/link": "/etc/passwd" }, calls });
    const ex = makeFsTools({ fs, allowRoots: [ROOT] });
    const r = await ex.execute(CALL("read_file", { path: "link" }), {});
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/realpath rejected|denied/i);
    expect(calls.read.length).toBe(0); // 탈출 링크로 실제 read 안 함
  });
  it("(b) realpath 가 민감경로(.keys)로 swap 되면 거부", async () => {
    const calls = { read: [] as string[], write: [] as string[] };
    const fs = fakeFs({ "/ws/naia-settings/.keys/k.dpapi": "SECRET" }, { links: { "/ws/innocent.md": "/ws/naia-settings/.keys/k.dpapi" }, calls });
    const ex = makeFsTools({ fs, allowRoots: [ROOT] });
    const r = await ex.execute(CALL("read_file", { path: "innocent.md" }), {});
    expect(r.isError).toBe(true);
    expect(calls.read.length).toBe(0);
  });
  it("(c) realpath 가 allow-root 안에 머물면 통과(정상 링크)", async () => {
    const fs = fakeFs({ "/ws/real.md": "hello" }, { links: { "/ws/alias.md": "/ws/real.md" } });
    const ex = makeFsTools({ fs, allowRoots: [ROOT] });
    const r = await ex.execute(CALL("read_file", { path: "alias.md" }), {});
    expect(r.isError).toBeFalsy();
    expect(r.output).toBe("hello");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) 도구 계약 — fs-tools (read_file/list_dir/write_file)
// ─────────────────────────────────────────────────────────────────────────────
describe("makeFsTools — 도구 계약", () => {
  it("read_file(허용) → 내용", async () => {
    const ex = makeFsTools({ fs: fakeFs({ "/ws/a.md": "content" }), allowRoots: [ROOT] });
    expect((await ex.execute(CALL("read_file", { path: "a.md" }), {})).output).toBe("content");
  });
  it("list_dir(허용) → 항목(d/f prefix)", async () => {
    const ex = makeFsTools({ fs: fakeFs({ "/ws/a.md": "x", "/ws/sub/b.md": "y" }, { dirs: ["/ws/sub"] }), allowRoots: [ROOT] });
    const r = await ex.execute(CALL("list_dir", { path: "." }), {});
    expect(r.output.split("\n").sort()).toEqual(["d sub", "f a.md"]);
  });
  it("거부 경로(`..`/드라이브/민감) → isError, throw 안 함", async () => {
    const ex = makeFsTools({ fs: fakeFs({ "/ws/a.md": "x" }), allowRoots: [ROOT] });
    for (const p of ["../escape.md", "C:\\x.md", "data-private/s.txt", "%H%/x"]) {
      const r = await ex.execute(CALL("read_file", { path: p }), {});
      expect(r.isError).toBe(true); // resolve 후 reject 없이 isError
    }
  });
  it("write_file: enableWrite=false 면 specs 에 없음 + 호출 거부", async () => {
    const ex = makeFsTools({ fs: fakeFs({}, { dirs: ["/ws"] }), allowRoots: [ROOT], enableWrite: false });
    expect(ex.specs().map((s) => s.name)).toEqual(["list_dir", "read_file"]);
    const r = await ex.execute(CALL("write_file", { path: "new.md", content: "x" }), {});
    expect(r.isError).toBe(true);
  });
  it("write_file: enableWrite=true 면 spec 노출 + 동작(부모 디렉터리 존재 시)", async () => {
    const calls = { read: [] as string[], write: [] as string[] };
    const ex = makeFsTools({ fs: fakeFs({}, { dirs: ["/ws"], calls }), allowRoots: [ROOT], enableWrite: true });
    expect(ex.specs().map((s) => s.name)).toContain("write_file");
    const r = await ex.execute(CALL("write_file", { path: "new.md", content: "data" }), {});
    expect(r.isError).toBeFalsy();
    expect(calls.write.length).toBe(1);
    expect(calls.write[0]).toBe("/ws/new.md");
  });
  it("write_file: allow-root 밖/민감경로 거부(부모 없거나 denylist)", async () => {
    const ex = makeFsTools({ fs: fakeFs({}, { dirs: ["/ws", "/ws/naia-settings/.keys"] }), allowRoots: [ROOT], enableWrite: true });
    expect((await ex.execute(CALL("write_file", { path: "../out.md", content: "x" }), {})).isError).toBe(true);
    expect((await ex.execute(CALL("write_file", { path: "naia-settings/.keys/evil.dpapi", content: "x" }), {})).isError).toBe(true);
  });
  it("write_file: 기존 대상이 symlink 면 거부(link-follow 외부 덮어쓰기 차단, write 미발생)", async () => {
    const calls = { read: [] as string[], write: [] as string[] };
    // /ws/alias.md 는 존재하고 symlink — 덮어쓰기 거부.
    const fs = fakeFs({ "/ws/alias.md": "old" }, { calls, symlinks: ["/ws/alias.md"] });
    const ex = makeFsTools({ fs, allowRoots: [ROOT], enableWrite: true });
    const r = await ex.execute(CALL("write_file", { path: "alias.md", content: "evil" }), {});
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/symlink/i);
    expect(calls.write.length).toBe(0); // symlink 대상으로 write 안 함
  });
  it("write_file: 기존 대상이 일반 파일이면 덮어쓰기 허용(symlink 아님)", async () => {
    const calls = { read: [] as string[], write: [] as string[] };
    const fs = fakeFs({ "/ws/plain.md": "old" }, { calls });
    const ex = makeFsTools({ fs, allowRoots: [ROOT], enableWrite: true });
    const r = await ex.execute(CALL("write_file", { path: "plain.md", content: "new" }), {});
    expect(r.isError).toBeFalsy();
    expect(calls.write.length).toBe(1);
  });
  // ── K-SEC: naia-settings 쓰기-펜스(FR-KB-OS.9 "AI 가 설정 못 건드림") — 읽기는 허용, 쓰기만 거부 ──
  it("write_file: naia-settings/ 설정 파일 쓰기 거부(셸 소유, write 미발생)", async () => {
    const calls = { read: [] as string[], write: [] as string[] };
    const fs = fakeFs({ "/ws/naia-settings/knowledge.json": "{}" }, { dirs: ["/ws", "/ws/naia-settings"], calls });
    const ex = makeFsTools({ fs, allowRoots: [ROOT], enableWrite: true });
    for (const p of ["naia-settings/knowledge.json", "naia-settings/config.json", "naia-settings/ui-config.json"]) {
      const r = await ex.execute(CALL("write_file", { path: p, content: "evil" }), {});
      expect(r.isError).toBe(true);
      expect(r.output).toMatch(/read-only|settings/i);
    }
    expect(calls.write.length).toBe(0); // 설정에 실제 write 안 함
  });
  it("read_file: naia-settings/ 설정 읽기는 허용(에이전트가 provider/지식 config 읽음 — 펜스는 write 전용)", async () => {
    const fs = fakeFs({ "/ws/naia-settings/config.json": "{\"provider\":\"gemini\"}" }, { dirs: ["/ws", "/ws/naia-settings"] });
    const ex = makeFsTools({ fs, allowRoots: [ROOT], enableWrite: true });
    const r = await ex.execute(CALL("read_file", { path: "naia-settings/config.json" }), {});
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("gemini");
  });
  it("write_file: symlink 으로 naia-settings 우회해도 real 이 펜스 안이면 거부", async () => {
    const calls = { read: [] as string[], write: [] as string[] };
    // /ws/innocent.json 은 존재하는 일반 경로지만 realpath 가 naia-settings/knowledge.json 으로 swap.
    const fs = fakeFs({ "/ws/naia-settings/knowledge.json": "{}" }, { dirs: ["/ws", "/ws/naia-settings"], links: { "/ws/innocent.json": "/ws/naia-settings/knowledge.json" }, calls });
    const ex = makeFsTools({ fs, allowRoots: [ROOT], enableWrite: true });
    const r = await ex.execute(CALL("write_file", { path: "innocent.json", content: "evil" }), {});
    expect(r.isError).toBe(true);
    expect(calls.write.length).toBe(0);
  });
  it("tier 설정 확인 — read/list=fs-read, write=fs-write(승인 게이트 발화 근거)", () => {
    const ex = makeFsTools({ fs: fakeFs({}), allowRoots: [ROOT], enableWrite: true });
    const byName = Object.fromEntries(ex.specs().map((s) => [s.name, s.tier]));
    expect(byName["read_file"]).toBe("fs-read");
    expect(byName["list_dir"]).toBe("fs-read");
    expect(byName["write_file"]).toBe("fs-write");
  });
  it("args 비객체 → isError(no-throw)", async () => {
    const ex = makeFsTools({ fs: fakeFs({}), allowRoots: [ROOT] });
    expect((await ex.execute(CALL("read_file", "not-an-object"), {})).isError).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) 민감경로 실증 — .keys/.dpapi/data-private read 차단
// ─────────────────────────────────────────────────────────────────────────────
describe("민감경로 실증 (실 키 패턴 — 가짜 경로로만 시뮬)", () => {
  it("<adk>/naia-settings/.keys/x.dpapi read → isError(차단, 실제 read 미발생)", async () => {
    const calls = { read: [] as string[], write: [] as string[] };
    // 파일이 실제로 존재해도 denylist 가 먼저 거부(read 도달 전).
    const fs = fakeFs({ "/ws/naia-settings/.keys/NAIA_KEY.dpapi": "FAKE-DPAPI-BLOB" }, { calls });
    const ex = makeFsTools({ fs, allowRoots: [ROOT] });
    const r = await ex.execute(CALL("read_file", { path: "naia-settings/.keys/NAIA_KEY.dpapi" }), {});
    expect(r.isError).toBe(true);
    expect(calls.read.length).toBe(0); // 민감경로 → fs read 호출 0
  });
  it("<adk>/data-private/... read → 차단", async () => {
    const calls = { read: [] as string[], write: [] as string[] };
    const fs = fakeFs({ "/ws/data-private/secret.json": "{}" }, { calls });
    const ex = makeFsTools({ fs, allowRoots: [ROOT] });
    expect((await ex.execute(CALL("read_file", { path: "data-private/secret.json" }), {})).isError).toBe(true);
    expect(calls.read.length).toBe(0);
  });
  it("list_dir 로도 .keys 디렉터리 나열 차단", async () => {
    const fs = fakeFs({ "/ws/naia-settings/.keys/a.dpapi": "x" }, { dirs: ["/ws/naia-settings", "/ws/naia-settings/.keys"] });
    const ex = makeFsTools({ fs, allowRoots: [ROOT] });
    expect((await ex.execute(CALL("list_dir", { path: "naia-settings/.keys" }), {})).isError).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) 도구 계약 — shell-tool (argv·cwd·opt-in·no-throw)
// ─────────────────────────────────────────────────────────────────────────────
const fakeExec = (capture: { argv?: readonly string[]; cwd?: string } = {}): ShellExecFn =>
  async (argv, opts): Promise<ShellExecResult> => {
    capture.argv = argv; capture.cwd = opts.cwd;
    return { stdout: `ran ${argv.join(" ")} in ${opts.cwd}`, stderr: "", code: 0 };
  };

// fake realpath — 기본 항등(swap 없음). links 맵 주면 cwd realpath swap 시뮬(TOCTOU).
const fakeRealpath = (links: Record<string, string> = {}) => (p: string): string => links[p] ?? p;

describe("makeShellTool — argv·cwd·opt-in·no-throw", () => {
  it("argv 정상 실행 → 출력 + cwd=allow-root", async () => {
    const cap: { argv?: readonly string[]; cwd?: string } = {};
    const ex = makeShellTool({ exec: fakeExec(cap), allowRoots: [ROOT], realpath: fakeRealpath() });
    const r = await ex.execute(CALL("shell_exec", { command: ["echo", "hi"] }), {});
    expect(r.isError).toBeFalsy();
    expect(cap.argv).toEqual(["echo", "hi"]);
    expect(cap.cwd).toBe("/ws");
  });
  it("command 가 셸 문자열(string) → isError(argv 아님)", async () => {
    const ex = makeShellTool({ exec: fakeExec(), allowRoots: [ROOT], realpath: fakeRealpath() });
    const r = await ex.execute(CALL("shell_exec", { command: "rm -rf / && echo pwned" }), {});
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/array of strings|argv/i);
  });
  it("빈 argv / 비-string 항목 → isError", async () => {
    const ex = makeShellTool({ exec: fakeExec(), allowRoots: [ROOT], realpath: fakeRealpath() });
    expect((await ex.execute(CALL("shell_exec", { command: [] }), {})).isError).toBe(true);
    expect((await ex.execute(CALL("shell_exec", { command: ["ls", 5] }), {})).isError).toBe(true);
    expect((await ex.execute(CALL("shell_exec", { command: ["ls", "a\0b"] }), {})).isError).toBe(true);
  });
  it("cwd 탈출(`..`/드라이브/env) → isError(exec 미호출)", async () => {
    let called = false;
    const ex = makeShellTool({ exec: async () => { called = true; return { stdout: "", stderr: "", code: 0 }; }, allowRoots: [ROOT], realpath: fakeRealpath() });
    for (const cwd of ["../escape", "C:\\Windows", "%TEMP%", "/etc"]) {
      const r = await ex.execute(CALL("shell_exec", { command: ["ls"], cwd }), {});
      expect(r.isError).toBe(true);
    }
    expect(called).toBe(false); // 탈출 cwd 로 exec 안 함
  });
  it("cwd allow-root 안 → 정규화 cwd 로 exec", async () => {
    const cap: { argv?: readonly string[]; cwd?: string } = {};
    const ex = makeShellTool({ exec: fakeExec(cap), allowRoots: [ROOT], realpath: fakeRealpath() });
    await ex.execute(CALL("shell_exec", { command: ["pwd"], cwd: "sub/dir" }), {});
    expect(cap.cwd).toBe("/ws/sub/dir");
  });
  it("cwd realpath 가 allow-root 밖을 가리키면 거부(symlink/junction cwd 탈출, exec 미호출)", async () => {
    let called = false;
    // cwd 문자열은 allow-root 안(/ws/escape)이지만 realpath 가 /etc(밖)로 swap.
    const ex = makeShellTool({
      exec: async () => { called = true; return { stdout: "", stderr: "", code: 0 }; },
      allowRoots: [ROOT],
      realpath: fakeRealpath({ "/ws/escape": "/etc" }),
    });
    const r = await ex.execute(CALL("shell_exec", { command: ["ls"], cwd: "escape" }), {});
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/cwd realpath rejected|cwd denied/i);
    expect(called).toBe(false); // 탈출 realpath cwd 로 exec 안 함
  });
  it("cwd realpath swap 이 민감경로(.keys)면 거부", async () => {
    let called = false;
    const ex = makeShellTool({
      exec: async () => { called = true; return { stdout: "", stderr: "", code: 0 }; },
      allowRoots: [ROOT],
      realpath: fakeRealpath({ "/ws/innocent": "/ws/naia-settings/.keys" }),
    });
    const r = await ex.execute(CALL("shell_exec", { command: ["ls"], cwd: "innocent" }), {});
    expect(r.isError).toBe(true);
    expect(called).toBe(false);
  });
  it("기본 cwd(allow-root)도 realpath 재검증 — 정상(항등)이면 통과", async () => {
    const cap: { argv?: readonly string[]; cwd?: string } = {};
    const ex = makeShellTool({ exec: fakeExec(cap), allowRoots: [ROOT], realpath: fakeRealpath() });
    const r = await ex.execute(CALL("shell_exec", { command: ["pwd"] }), {});
    expect(r.isError).toBeFalsy();
    expect(cap.cwd).toBe("/ws");
  });
  it("비-0 exit → isError(출력 보존), throw 안 함", async () => {
    const ex = makeShellTool({ exec: async () => ({ stdout: "out", stderr: "boom", code: 1 }), allowRoots: [ROOT], realpath: fakeRealpath() });
    const r = await ex.execute(CALL("shell_exec", { command: ["false"] }), {});
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/boom|exit 1/);
  });
  it("exec 가 throw 해도 no-throw(isError)", async () => {
    const ex = makeShellTool({ exec: async () => { throw new Error("spawn fail"); }, allowRoots: [ROOT], realpath: fakeRealpath() });
    const r = await ex.execute(CALL("shell_exec", { command: ["x"] }), {});
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/spawn fail/);
  });
  it("tier=shell(상위 승인 게이트 발화 근거)", () => {
    const ex = makeShellTool({ exec: fakeExec(), allowRoots: [ROOT], realpath: fakeRealpath() });
    expect(ex.specs()[0].name).toBe("shell_exec");
    expect(ex.specs()[0].tier).toBe("shell");
  });
});
