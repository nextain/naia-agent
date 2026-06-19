// conversation-log adapter 계약(FR-CONV.1/5) — verbatim transcript JSONL append. 단일 writer(전두엽=agent).
// 불변식: 1줄=1메시지(user→assistant) / sessionId 파일 격리 + traversal 차단 / append-only(누적) / **no-throw 격리**.
import { describe, it, expect } from "vitest";
import { makeFileConversationLog, sessionFileName } from "../main/adapters/conversation-log-store.js";

function fakeFs() {
  const files = new Map<string, string>();
  const mkdirs: string[] = [];
  return {
    files,
    mkdirs,
    appendFileSync: (path: string, data: string) => { files.set(path, (files.get(path) ?? "") + data); },
    mkdirSync: (path: string, _opts: { recursive: true }) => { mkdirs.push(path); },
  };
}
const join = (dir: string, file: string) => `${dir}/${file}`;

describe("sessionFileName (경로 인젝션·traversal 차단)", () => {
  it("정상 sessionId 보존", () => {
    expect(sessionFileName("chat-123_abc")).toBe("chat-123_abc.jsonl");
  });
  it("traversal/특수문자 치환 + 선행 _ . 제거", () => {
    expect(sessionFileName("../../etc/passwd")).toBe("etc_passwd.jsonl");
    expect(sessionFileName("a/b\\c")).toBe("a_b_c.jsonl");
  });
  it("빈/비정상 = default(FR-CONV.2 단일 fallback)", () => {
    expect(sessionFileName("")).toBe("default.jsonl");
    expect(sessionFileName("___")).toBe("default.jsonl");
  });
  it("길이 cap(128)", () => {
    expect(sessionFileName("x".repeat(500))).toBe(`${"x".repeat(128)}.jsonl`);
  });
});

describe("makeFileConversationLog.append (JSONL 1줄=1메시지)", () => {
  it("user→assistant 두 줄 append + timestamp 주입", async () => {
    const fs = fakeFs();
    const log = makeFileConversationLog({ conversationsDir: "/adk/conversations", fs, join, now: () => 1717000000000 });
    await log.append({ sessionId: "s1", userText: "안녕", assistantText: "반가워요" });
    const lines = fs.files.get("/adk/conversations/s1.jsonl")!.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ role: "user", content: "안녕", timestamp: 1717000000000 });
    expect(lines[1]).toEqual({ role: "assistant", content: "반가워요", timestamp: 1717000000000 });
  });
  it("sessionId 격리 — 다른 세션 = 다른 파일", async () => {
    const fs = fakeFs();
    const log = makeFileConversationLog({ conversationsDir: "/c", fs, join, now: () => 1 });
    await log.append({ sessionId: "a", userText: "u1", assistantText: "a1" });
    await log.append({ sessionId: "b", userText: "u2", assistantText: "a2" });
    expect(fs.files.has("/c/a.jsonl")).toBe(true);
    expect(fs.files.has("/c/b.jsonl")).toBe(true);
    expect(fs.files.get("/c/a.jsonl")).not.toContain("u2");
  });
  it("append-only — 같은 세션 누적(덮어쓰기 아님)", async () => {
    const fs = fakeFs();
    const log = makeFileConversationLog({ conversationsDir: "/c", fs, join, now: () => 1 });
    await log.append({ sessionId: "s", userText: "u1", assistantText: "a1" });
    await log.append({ sessionId: "s", userText: "u2", assistantText: "a2" });
    expect(fs.files.get("/c/s.jsonl")!.trim().split("\n")).toHaveLength(4);
  });
  it("sessionId 누락 = default 파일(FR-CONV.2)", async () => {
    const fs = fakeFs();
    const log = makeFileConversationLog({ conversationsDir: "/c", fs, join, now: () => 1 });
    await log.append({ sessionId: "", userText: "u", assistantText: "a" });
    expect(fs.files.has("/c/default.jsonl")).toBe(true);
  });
  it("dir 보장(mkdir recursive)", async () => {
    const fs = fakeFs();
    const log = makeFileConversationLog({ conversationsDir: "/c", fs, join, now: () => 1 });
    await log.append({ sessionId: "s", userText: "u", assistantText: "a" });
    expect(fs.mkdirs).toContain("/c");
  });
  it("no-throw 격리(FR-CONV.1) — appendFileSync throw 해도 resolve(크래시 없음)", async () => {
    const log = makeFileConversationLog({
      conversationsDir: "/c", join, now: () => 1,
      fs: { mkdirSync: () => {}, appendFileSync: () => { throw new Error("EACCES"); } },
    });
    await expect(log.append({ sessionId: "s", userText: "u", assistantText: "a" })).resolves.toBeUndefined();
  });
  it("no-throw 격리 — mkdirSync throw 해도 resolve", async () => {
    const log = makeFileConversationLog({
      conversationsDir: "/c", join, now: () => 1,
      fs: { mkdirSync: () => { throw new Error("EPERM"); }, appendFileSync: () => {} },
    });
    await expect(log.append({ sessionId: "s", userText: "u", assistantText: "a" })).resolves.toBeUndefined();
  });
});
