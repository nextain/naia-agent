// conversation-log 실 파일시스템 통합(FR-CONV.1) — makeFileConversationLog 를 실 node:fs 로 실 디스크에 append → 재read.
// 단위(contract)는 fakeFs. 이건 실제 appendFileSync/mkdirSync 동작 + jsonl 포맷을 디스크 왕복으로 검증(roundtrip 한쪽).
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFileConversationLog } from "../main/adapters/conversation-log-store.js";

describe("conversation-log 실 fs 통합(FR-CONV.1)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    dirs.length = 0;
  });

  function realLog(now = 1717000000000) {
    const base = mkdtempSync(join(tmpdir(), "naia-conv-it-"));
    dirs.push(base);
    const conversationsDir = join(base, "conversations");
    const log = makeFileConversationLog({ conversationsDir, fs: { appendFileSync, mkdirSync }, join, now: () => now });
    return { log, conversationsDir };
  }

  it("실 디스크 jsonl append + 재read 정확 포맷(roundtrip, 2턴 누적)", async () => {
    const { log, conversationsDir } = realLog();
    await log.append({ sessionId: "chat-1", userText: "안녕", assistantText: "반가워요" });
    await log.append({ sessionId: "chat-1", userText: "둘째", assistantText: "응답2" });
    const file = join(conversationsDir, "chat-1.jsonl");
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual({ role: "user", content: "안녕", timestamp: 1717000000000 });
    expect(lines[3]).toEqual({ role: "assistant", content: "응답2", timestamp: 1717000000000 });
  });

  it("개행/따옴표 content 도 물리 1줄 유지(JSONL 무결성)", async () => {
    const { log, conversationsDir } = realLog();
    await log.append({ sessionId: "s", userText: '줄1\n"큰따옴표"\n줄3', assistantText: "a\tb" });
    const physical = readFileSync(join(conversationsDir, "s.jsonl"), "utf8").trim().split("\n");
    expect(physical).toHaveLength(2);
    expect(JSON.parse(physical[0]).content).toBe('줄1\n"큰따옴표"\n줄3');
  });

  it("traversal sessionId → conversations 밖에 안 씀", async () => {
    const { log, conversationsDir } = realLog();
    await log.append({ sessionId: "../escape", userText: "x", assistantText: "y" });
    expect(existsSync(join(conversationsDir, "escape.jsonl"))).toBe(true);
  });
});
