import { describe, it, expect, beforeEach } from "vitest";
import {
  makeBrowserReadTools,
  BROWSER_READ_TOOL_NAMES,
  type BrowserReadFs,
  type BrowserReadStat,
  type BrowserReadEntry,
} from "../main/adapters/browser-read-tools.js";

interface FsNode {
  kind: "file" | "directory";
  content?: string;
  size?: number;
  children?: Map<string, FsNode>;
}

class FakeBrowserReadFs implements BrowserReadFs {
  public root: FsNode = { kind: "directory", children: new Map() };
  public statCalls: string[][] = [];
  public listCalls: string[][] = [];
  public readTextCalls: string[][] = [];

  public errorToThrow?: { method: "stat" | "list" | "readText"; error: Error };

  addFile(pathStr: string, content: string, size?: number): void {
    const parts = pathStr.split("/").filter(Boolean);
    let curr = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]!;
      if (!curr.children!.has(p)) {
        curr.children!.set(p, { kind: "directory", children: new Map() });
      }
      curr = curr.children!.get(p)!;
    }
    const filename = parts[parts.length - 1]!;
    curr.children!.set(filename, {
      kind: "file",
      content,
      size: size ?? content.length,
    });
  }

  addDir(pathStr: string): void {
    const parts = pathStr.split("/").filter(Boolean);
    let curr = this.root;
    for (const p of parts) {
      if (!curr.children!.has(p)) {
        curr.children!.set(p, { kind: "directory", children: new Map() });
      }
      curr = curr.children!.get(p)!;
    }
  }

  private getNode(segments: readonly string[]): FsNode | null {
    let curr: FsNode | undefined = this.root;
    for (const seg of segments) {
      if (!curr || curr.kind !== "directory" || !curr.children) {
        return null;
      }
      curr = curr.children.get(seg);
    }
    return curr ?? null;
  }

  async stat(segments: readonly string[]): Promise<BrowserReadStat> {
    this.statCalls.push([...segments]);
    if (this.errorToThrow?.method === "stat") {
      throw this.errorToThrow.error;
    }
    const node = this.getNode(segments);
    if (!node) return null;
    if (node.kind === "directory") {
      return { kind: "directory" };
    }
    return { kind: "file", size: node.size ?? node.content?.length ?? 0 };
  }

  async list(segments: readonly string[]): Promise<readonly BrowserReadEntry[]> {
    this.listCalls.push([...segments]);
    if (this.errorToThrow?.method === "list") {
      throw this.errorToThrow.error;
    }
    const node = this.getNode(segments);
    if (!node || node.kind !== "directory" || !node.children) {
      return [];
    }
    const entries: BrowserReadEntry[] = [];
    for (const [name, child] of node.children.entries()) {
      entries.push({ name, kind: child.kind });
    }
    return entries;
  }

  async readText(segments: readonly string[]): Promise<string> {
    this.readTextCalls.push([...segments]);
    if (this.errorToThrow?.method === "readText") {
      throw this.errorToThrow.error;
    }
    const node = this.getNode(segments);
    if (!node || node.kind !== "file") {
      throw new Error(`file not found: ${segments.join("/")}`);
    }
    return node.content ?? "";
  }
}

function createDefaultFs(): FakeBrowserReadFs {
  const fs = new FakeBrowserReadFs();
  fs.addFile("AGENTS.md", "# AGENTS\n규칙 문서");
  fs.addFile(".agents/context/philosophy.md", "# 철학\n## 1. 첫 원칙");
  fs.addFile("notes/hello.md", "hello world");
  fs.addFile("naia-settings/config.json", '{"key":"secret"}');
  fs.addFile(".env", "SECRET=123");
  fs.addFile(".keys/k.txt", "key-token");
  fs.addDir("empty");
  return fs;
}

describe("browser-read-tools contracts", () => {
  beforeEach(() => {
    expect.hasAssertions();
  });

  it("WO13A-T01 맨 위 목록에 d .agents 가 있음", async () => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });
    const res = await tools.execute({ id: "1", name: "list_dir", args: { path: "" } }, {});
    expect(res.output).toBe("d .agents\nf AGENTS.md\nd empty\nd notes");
    expect(res.isError).toBe(undefined);
  });

  it("WO13A-T02 read_file AGENTS.md 내용", async () => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });
    const res = await tools.execute({ id: "1", name: "read_file", args: { path: "AGENTS.md" } }, {});
    expect(res.output).toBe("# AGENTS\n규칙 문서");
    expect(res.isError).toBe(undefined);
  });

  it("WO13A-T03 list_dir agents/context -> Did you mean: .agents/context?", async () => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });
    const res = await tools.execute({ id: "1", name: "list_dir", args: { path: "agents/context" } }, {});
    expect(res.output).toBe("not found: agents/context. Did you mean: .agents/context?");
    expect(res.isError).toBe(true);
  });

  it("WO13A-T03b 안내 후 philosophy.md 목록 및 내용 확인", async () => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });
    const listRes = await tools.execute({ id: "1", name: "list_dir", args: { path: ".agents/context" } }, {});
    expect(listRes.output).toBe("f philosophy.md");
    expect(listRes.isError).toBe(undefined);

    const readRes = await tools.execute(
      { id: "2", name: "read_file", args: { path: ".agents/context/philosophy.md" } },
      {},
    );
    expect(readRes.output).toBe("# 철학\n## 1. 첫 원칙");
    expect(readRes.isError).toBe(undefined);
  });

  it("WO13A-T04 read_file Agents.md -> Did you mean: AGENTS.md?", async () => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });
    const res = await tools.execute({ id: "1", name: "read_file", args: { path: "Agents.md" } }, {});
    expect(res.output).toBe("not found: Agents.md. Did you mean: AGENTS.md?");
    expect(res.isError).toBe(true);
  });

  it("WO13A-T05 read_file nope/x.md -> Entries in /: 안내", async () => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });
    const res = await tools.execute({ id: "1", name: "read_file", args: { path: "nope/x.md" } }, {});
    expect(res.output).toBe("not found: nope/x.md. Entries in /: .agents/, AGENTS.md, empty/, notes/");
    expect(res.isError).toBe(true);
  });

  it("WO13A-T06 opfs://naia-adk 및 상대경로 정규화 확인", async () => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });

    const r1 = await tools.execute({ id: "1", name: "read_file", args: { path: "opfs://naia-adk/notes/hello.md" } }, {});
    const r2 = await tools.execute({ id: "2", name: "read_file", args: { path: "./notes//hello.md" } }, {});
    const r3 = await tools.execute({ id: "3", name: "read_file", args: { path: "notes/hello.md" } }, {});

    expect(r1.output).toBe("hello world");
    expect(r2.output).toBe("hello world");
    expect(r3.output).toBe("hello world");

    expect(fs.readTextCalls).toEqual([
      ["notes", "hello.md"],
      ["notes", "hello.md"],
      ["notes", "hello.md"],
    ]);
  });

  it("WO13A-T07 루트 표현 6가지가 모두 같은 맨 위 목록", async () => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });
    const rootPaths = ["", ".", "/", "./", "opfs://naia-adk", "opfs://naia-adk/"];

    const expectedOutput = "d .agents\nf AGENTS.md\nd empty\nd notes";
    for (let i = 0; i < rootPaths.length; i++) {
      const res = await tools.execute({ id: String(i), name: "list_dir", args: { path: rootPaths[i] } }, {});
      expect(res.output).toBe(expectedOutput);
      expect(res.isError).toBe(undefined);
    }

    expect(fs.listCalls).toEqual([[], [], [], [], [], []]);
  });

  it("WO13A-T08 6,000자 넘는 파일 잘림 표시", async () => {
    const fs = new FakeBrowserReadFs();
    const content = "a".repeat(6500);
    fs.addFile("long.txt", content);
    const tools = makeBrowserReadTools({ fs });

    const res = await tools.execute({ id: "1", name: "read_file", args: { path: "long.txt" } }, {});
    expect(res.output).toBe("a".repeat(6000) + "\n…(truncated, 6500 chars)");
    expect(res.isError).toBe(undefined);
  });

  it("WO13A-T09 1MB 넘는 크기 -> file too large", async () => {
    const fs = new FakeBrowserReadFs();
    fs.addFile("huge.bin", "", 1048577);
    const tools = makeBrowserReadTools({ fs });

    const res = await tools.execute({ id: "1", name: "read_file", args: { path: "huge.bin" } }, {});
    expect(res.output).toBe("file too large");
    expect(res.isError).toBe(true);
    expect(fs.readTextCalls.length).toBe(0);
  });

  it("WO13A-T10 빈 폴더 (empty)", async () => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });
    const res = await tools.execute({ id: "1", name: "list_dir", args: { path: "empty" } }, {});
    expect(res.output).toBe("(empty)");
    expect(res.isError).toBe(undefined);
  });

  it("WO13A-T11 알 수 없는 도구", async () => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });
    const res = await tools.execute({ id: "1", name: "unknown_func", args: { path: "AGENTS.md" } }, {});
    expect(res.output).toBe("unknown tool: unknown_func");
    expect(res.isError).toBe(true);
  });

  it("WO13A-T12 문자열 아닌 경로", async () => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });
    const res = await tools.execute({ id: "1", name: "read_file", args: { path: 12345 } }, {});
    expect(res.output).toBe("invalid arguments: path must be a string");
    expect(res.isError).toBe(true);
  });

  it("WO13A-T13 두 도구의 tier 가 none", async () => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });
    const specs = tools.specs();
    expect(specs[0]!.tier).toBe("none");
    expect(specs[1]!.tier).toBe("none");
  });

  it("WO13A-T14 맨 위 목록에 naia-settings .env .keys 가 없음", async () => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });
    const res = await tools.execute({ id: "1", name: "list_dir", args: { path: "" } }, {});
    expect(res.output).toBe("d .agents\nf AGENTS.md\nd empty\nd notes");
    expect(res.isError).toBe(undefined);
  });

  it("WO13A-T15 안내 및 응답에 naia-settings .env .keys 가 없음", async () => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });

    const r1 = await tools.execute({ id: "1", name: "read_file", args: { path: "nope/x.md" } }, {});
    const r2 = await tools.execute({ id: "2", name: "list_dir", args: { path: "keys" } }, {});
    const r3 = await tools.execute({ id: "3", name: "list_dir", args: { path: "env" } }, {});
    const r4 = await tools.execute({ id: "4", name: "list_dir", args: { path: "NAIA-SETTINGS2" } }, {});

    for (const r of [r1, r2, r3, r4]) {
      const lower = r.output.toLowerCase().replace("naia-settings2", "");
      expect(lower).not.toContain("naia-settings");
      expect(lower).not.toContain(".env");
      expect(lower).not.toContain(".keys");
    }
  });

  it("WO13A-T16 별도 가짜 fs 맨 위 대소문자 민감 항목 숨김", async () => {
    const fs = new FakeBrowserReadFs();
    fs.addFile(".ENV", "secret");
    fs.addFile(".Keys/k.txt", "secret");
    fs.addFile("NAIA-Settings/x.json", "secret");
    fs.addFile("AGENTS.md", "# AGENTS");
    const tools = makeBrowserReadTools({ fs });

    const res = await tools.execute({ id: "1", name: "list_dir", args: { path: "" } }, {});
    expect(res.output).toBe("f AGENTS.md");
    expect(res.isError).toBe(undefined);
  });

  it("WO13A-T17 파일 아래 경로 not found 안내", async () => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });

    const r1 = await tools.execute({ id: "1", name: "read_file", args: { path: "AGENTS.md/nope" } }, {});
    expect(r1.output).toBe("not found: AGENTS.md/nope. AGENTS.md is a file");
    expect(r1.isError).toBe(true);

    const r2 = await tools.execute({ id: "2", name: "list_dir", args: { path: "AGENTS.md/x" } }, {});
    expect(r2.output).toBe("not found: AGENTS.md/x. AGENTS.md is a file");
    expect(r2.isError).toBe(true);

    expect(fs.listCalls.length).toBe(0);
  });

  it("WO13A-T18 big 폴더 201개 항목 list_dir", async () => {
    const fs = new FakeBrowserReadFs();
    for (let i = 0; i < 100; i++) {
      fs.addDir(`big/d${String(i).padStart(3, "0")}`);
    }
    for (let i = 0; i < 101; i++) {
      fs.addFile(`big/f${String(i).padStart(3, "0")}`, "content");
    }
    const tools = makeBrowserReadTools({ fs });

    const res = await tools.execute({ id: "1", name: "list_dir", args: { path: "big" } }, {});
    const expectedLines: string[] = [];
    for (let i = 0; i < 100; i++) {
      expectedLines.push(`d d${String(i).padStart(3, "0")}`);
    }
    for (let i = 0; i < 100; i++) {
      expectedLines.push(`f f${String(i).padStart(3, "0")}`);
    }
    expectedLines.push("…(more entries)");
    expect(res.output).toBe(expectedLines.join("\n"));
    expect(res.isError).toBe(undefined);
  });

  it("WO13A-T19 big 폴더 not found 시 30개 항목 안내", async () => {
    const fs = new FakeBrowserReadFs();
    for (let i = 0; i < 100; i++) {
      fs.addDir(`big/d${String(i).padStart(3, "0")}`);
    }
    for (let i = 0; i < 101; i++) {
      fs.addFile(`big/f${String(i).padStart(3, "0")}`, "content");
    }
    const tools = makeBrowserReadTools({ fs });

    const res = await tools.execute({ id: "1", name: "read_file", args: { path: "big/zzz" } }, {});
    const expectedEntries = Array.from(
      { length: 30 },
      (_, i) => `d${String(i).padStart(3, "0")}/`,
    ).join(", ");
    expect(res.output).toBe(`not found: big/zzz. Entries in big: ${expectedEntries}`);
    expect(res.isError).toBe(true);
  });

  it("WO13A-T20 notes 폴더 안 민감파일 숨김", async () => {
    const fs = new FakeBrowserReadFs();
    fs.addFile("notes/.ENV", "sec");
    fs.addFile("notes/.Keys/k.txt", "sec");
    fs.addFile("notes/hello.md", "hello");
    const tools = makeBrowserReadTools({ fs });

    const listRes = await tools.execute({ id: "1", name: "list_dir", args: { path: "notes" } }, {});
    expect(listRes.output).toBe("f hello.md");
    expect(listRes.isError).toBe(undefined);

    const notFoundRes = await tools.execute({ id: "2", name: "read_file", args: { path: "notes/nope.md" } }, {});
    expect(notFoundRes.output).toBe("not found: notes/nope.md. Entries in notes: hello.md");
    expect(notFoundRes.isError).toBe(true);

    const rRead = await tools.execute({ id: "3", name: "read_file", args: { path: "notes/env" } }, {});
    expect(rRead.output.toLowerCase()).not.toContain(".env");
    expect(rRead.output.toLowerCase()).not.toContain(".keys");

    const rList = await tools.execute({ id: "4", name: "list_dir", args: { path: "notes/keys" } }, {});
    expect(rList.output.toLowerCase()).not.toContain(".env");
    expect(rList.output.toLowerCase()).not.toContain(".keys");
  });

  it("WO13A-T21 취소된 signal 로 execute 호출 시 reject", async () => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });
    const controller = new AbortController();
    controller.abort();

    await expect(
      tools.execute({ id: "1", name: "list_dir", args: { path: "notes" } }, { signal: controller.signal }),
    ).rejects.toThrow();

    await expect(
      tools.execute({ id: "2", name: "read_file", args: { path: "AGENTS.md" } }, { signal: controller.signal }),
    ).rejects.toThrow();

    expect(fs.statCalls.length).toBe(0);
    expect(fs.listCalls.length).toBe(0);
    expect(fs.readTextCalls.length).toBe(0);
  });

  it.each([
    ["WO13A-T22 stat", "stat" as const],
    ["WO13A-T22 list", "list" as const],
    ["WO13A-T22 readText", "readText" as const],
  ])("%s", async (_name, method) => {
    const fs = createDefaultFs();
    fs.errorToThrow = { method, error: new Error("boom") };
    const tools = makeBrowserReadTools({ fs });

    if (method === "list") {
      const res = await tools.execute({ id: "1", name: "list_dir", args: { path: "notes" } }, {});
      expect(res.output).toBe("error: boom");
      expect(res.isError).toBe(true);
    } else {
      const res = await tools.execute({ id: "1", name: "read_file", args: { path: "AGENTS.md" } }, {});
      expect(res.output).toBe("error: boom");
      expect(res.isError).toBe(true);
    }
  });

  it("WO13A-T23 파일/폴더 타입 불일치 및 원래 경로 공백 제거", async () => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });

    const r1 = await tools.execute({ id: "1", name: "list_dir", args: { path: "AGENTS.md" } }, {});
    expect(r1.output).toBe("not a directory: AGENTS.md");
    expect(r1.isError).toBe(true);

    const r2 = await tools.execute({ id: "2", name: "read_file", args: { path: "notes" } }, {});
    expect(r2.output).toBe("not a file: notes");
    expect(r2.isError).toBe(true);

    const r3 = await tools.execute({ id: "3", name: "read_file", args: { path: "  notes  " } }, {});
    expect(r3.output).toBe("not a file: notes");
    expect(r3.isError).toBe(true);
  });

  it("WO13A-T24 경계값: 정확히 6000자, 1MB, 200개 항목", async () => {
    const fs = new FakeBrowserReadFs();
    const exact6k = "x".repeat(6000);
    fs.addFile("exact6k.txt", exact6k);
    fs.addFile("exact1mb.bin", "b", 1048576);

    for (let i = 0; i < 100; i++) {
      fs.addDir(`folder200/d${String(i).padStart(3, "0")}`);
    }
    for (let i = 0; i < 100; i++) {
      fs.addFile(`folder200/f${String(i).padStart(3, "0")}`, "ok");
    }
    const tools = makeBrowserReadTools({ fs });

    const r6k = await tools.execute({ id: "1", name: "read_file", args: { path: "exact6k.txt" } }, {});
    expect(r6k.output).toBe(exact6k);
    expect(r6k.isError).toBe(undefined);

    const r1mb = await tools.execute({ id: "2", name: "read_file", args: { path: "exact1mb.bin" } }, {});
    expect(r1mb.output).toBe("b");
    expect(r1mb.isError).toBe(undefined);
    expect(fs.readTextCalls.filter((c) => c.join("/") === "exact1mb.bin").length).toBe(1);

    const r200 = await tools.execute({ id: "3", name: "list_dir", args: { path: "folder200" } }, {});
    const expected200Lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      expected200Lines.push(`d d${String(i).padStart(3, "0")}`);
    }
    for (let i = 0; i < 100; i++) {
      expected200Lines.push(`f f${String(i).padStart(3, "0")}`);
    }
    expect(r200.output).toBe(expected200Lines.join("\n"));
    expect(r200.isError).toBe(undefined);
  });

  it("WO13A-T25 고친 경로 우선순위 및 고친 경로 없을 시 Entries 안내", async () => {
    const fs = new FakeBrowserReadFs();
    fs.addFile(".Readme.md", "dot readme");
    fs.addFile("readme.md", "lower readme");
    fs.addFile(".agents/context/a.md", "a");
    fs.addFile("AGENTS.md", "agents");
    const tools = makeBrowserReadTools({ fs });

    const r1 = await tools.execute({ id: "1", name: "read_file", args: { path: "README.md" } }, {});
    expect(r1.output).toBe("not found: README.md. Did you mean: .Readme.md?");
    expect(r1.isError).toBe(true);

    const r2 = await tools.execute({ id: "2", name: "read_file", args: { path: "agents/context/nope.md" } }, {});
    expect(r2.output).toBe("not found: agents/context/nope.md. Entries in /: .Readme.md, .agents/, AGENTS.md, readme.md");
    expect(r2.isError).toBe(true);
  });

  it("WO13A-T26 specs() 계약 확인", () => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });
    const specs = tools.specs();

    expect(BROWSER_READ_TOOL_NAMES).toEqual(["list_dir", "read_file"]);
    expect(specs).toEqual([
      {
        name: "list_dir",
        description: "List files and folders at a path in the user's ADK workspace.",
        tier: "none",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Path relative to the workspace root, for example AGENTS.md or notes/hello.md. Use exact names; hidden folders start with a dot.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "read_file",
        description: "Read a text file in the user's ADK workspace.",
        tier: "none",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Path relative to the workspace root, for example AGENTS.md or notes/hello.md. Use exact names; hidden folders start with a dot.",
            },
          },
          required: ["path"],
        },
      },
    ]);
  });
});

const DENIAL_CASES = [
  ["01", "../x", "denied: path outside workspace"],
  ["02", "notes/../../x", "denied: path outside workspace"],
  ["03", "/etc/passwd", "denied: absolute paths are not allowed"],
  ["04", "//server/share", "denied: absolute paths are not allowed"],
  ["05", "C:/x", "denied: absolute paths are not allowed"],
  ["06", "c:\\x", "denied: absolute paths are not allowed"],
  ["07", "file:///x", "denied: absolute paths are not allowed"],
  ["08", "opfs://naia-adkx/a", "denied: absolute paths are not allowed"],
  ["09", "notes\\hello.md", "denied: path outside workspace"],
  ["10", "notes/a\u0001b", "denied: path outside workspace"],
  ["11", "naia-settings/config.json", "denied: settings folder is not readable"],
  ["12", "Naia-Settings/config.json", "denied: settings folder is not readable"],
  ["13", "NAIA-SETTINGS", "denied: settings folder is not readable"],
  ["14", ".env", "denied: sensitive path"],
  ["15", ".keys/k.txt", "denied: sensitive path"],
  ["16", "opfs://naia-adk/../x", "denied: path outside workspace"],
  ["17", ".ENV", "denied: sensitive path"],
  ["18", ".KEYS/k.txt", "denied: sensitive path"],
] as const;

describe("browser-read-tools denials", () => {
  beforeEach(() => {
    expect.hasAssertions();
  });

  it.each(DENIAL_CASES)("WO13A-TR%s read_file", async (_no, path, reason) => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });
    const res = await tools.execute({ id: "1", name: "read_file", args: { path } }, {});
    expect(res.output).toBe(reason);
    expect(res.isError).toBe(true);
    expect(fs.statCalls.length).toBe(0);
    expect(fs.listCalls.length).toBe(0);
    expect(fs.readTextCalls.length).toBe(0);
  });

  it.each(DENIAL_CASES)("WO13A-TR%s list_dir", async (_no, path, reason) => {
    const fs = createDefaultFs();
    const tools = makeBrowserReadTools({ fs });
    const res = await tools.execute({ id: "1", name: "list_dir", args: { path } }, {});
    expect(res.output).toBe(reason);
    expect(res.isError).toBe(true);
    expect(fs.statCalls.length).toBe(0);
    expect(fs.listCalls.length).toBe(0);
    expect(fs.readTextCalls.length).toBe(0);
  });
});
