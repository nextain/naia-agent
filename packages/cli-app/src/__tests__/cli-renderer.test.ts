import { describe, expect, it } from "vitest";
import type { NaiaStreamChunk } from "@nextain/agent-types";
import { renderChunk } from "../cli-renderer.js";

describe("renderChunk — formatting", () => {
  it("session_start renders adapter + summary", () => {
    const r = renderChunk({
      type: "session_start",
      sessionId: "abcdef123456",
      adapterId: "shell",
      taskSummary: "echo hi",
      workdir: "/tmp",
    });
    expect(r).toContain("shell");
    expect(r).toContain("echo hi");
  });

  it("text_delta strips trailing newline + indents", () => {
    const r = renderChunk({ type: "text_delta", sessionId: "x", text: "hello\n" });
    expect(r).toBe("  hello");
  });

  it("text_delta empty after trim → null", () => {
    const r = renderChunk({ type: "text_delta", sessionId: "x", text: "\n\n" });
    expect(r).toBeNull();
  });

  it("workspace_change uses kind symbol", () => {
    expect(renderChunk({ type: "workspace_change", path: "a.ts", kind: "add" })).toContain("✚");
    expect(renderChunk({ type: "workspace_change", path: "a.ts", kind: "delete" })).toContain("✘");
    expect(renderChunk({ type: "workspace_change", path: "a.ts", kind: "modify" })).toContain("✎");
  });

  it("verification_result test renders 24/24 PASS", () => {
    const r = renderChunk({
      type: "verification_result",
      runner: "test",
      pass: true,
      stats: { passed: 24, total: 24, failed: 0 },
      durationMs: 3200,
    } satisfies NaiaStreamChunk);
    expect(r).toContain("test 24/24 PASS");
    expect(r).toContain("3.2s");
  });

  it("report renders multi-line summary", () => {
    const r = renderChunk({
      type: "report",
      sessionId: "x",
      summary: "files: 1 (+5/-0)\ntests: 24/24 PASS (3.2s)\nelapsed: 12.4s",
      stats: {
        filesChanged: 1,
        additions: 5,
        deletions: 0,
        testsPassed: 24,
        testsFailed: 0,
        durationMs: 12400,
      },
      verifications: [],
    });
    expect(r).toContain("[알파] 완료");
    expect(r).toContain("files: 1 (+5/-0)");
  });

  it("interrupt rendered visibly", () => {
    const r = renderChunk({
      type: "interrupt",
      sessionId: "x",
      reason: "user-stop",
      mode: "hard_kill",
    });
    expect(r).toContain("interrupt");
    expect(r).toContain("user-stop");
  });

  it("audio_delta / image_delta / end → null in Phase 1", () => {
    expect(
      renderChunk({
        type: "audio_delta",
        sessionId: "x",
        pcm: new Uint8Array(0),
        sampleRate: 16000,
        channels: 1,
        format: "pcm_s16le",
      }),
    ).toBeNull();
    expect(
      renderChunk({
        type: "image_delta",
        sessionId: "x",
        mediaType: "image/png",
        data: new Uint8Array(0),
        isPartial: false,
      }),
    ).toBeNull();
    expect(renderChunk({ type: "end", sessionId: "x", stopReason: "end_turn" })).toBeNull();
  });
});
