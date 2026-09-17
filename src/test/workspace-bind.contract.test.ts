import { describe, expect, it } from "vitest";
import {
  codexThreadWorkspace,
  resolveWorkspaceBind,
  workspaceBindFromSettings,
} from "../main/domain/workspace-bind.js";

describe("workspace bind — Codex/fs-tools/terminal share one root", () => {
  it("binds a trimmed canonical root as read-only until terminal input is granted", () => {
    expect(resolveWorkspaceBind({ canonicalRoot: "  D:\\alpha-adk  " })).toEqual({
      canonicalRoot: "D:\\alpha-adk",
      filesystemAccess: "read-only",
    });
    expect(resolveWorkspaceBind({
      canonicalRoot: "/work/naia",
      terminalAllowed: true,
    })).toEqual({
      canonicalRoot: "/work/naia",
      filesystemAccess: "workspace-write",
    });
  });

  it("does not invent a workspace from empty or whitespace roots", () => {
    expect(resolveWorkspaceBind({ canonicalRoot: "" })).toBeUndefined();
    expect(resolveWorkspaceBind({ canonicalRoot: "   " })).toBeUndefined();
  });

  it("maps the shell terminal-input setting onto the same bind", () => {
    expect(workspaceBindFromSettings({
      canonicalRoot: "/ws",
      environmentTerminalInput: true,
    })?.filesystemAccess).toBe("workspace-write");
    expect(workspaceBindFromSettings({
      canonicalRoot: "/ws",
      environmentTerminalInput: false,
    })?.filesystemAccess).toBe("read-only");
    expect(workspaceBindFromSettings({
      canonicalRoot: "/ws",
      environmentTerminalInput: "true",
    })?.filesystemAccess).toBe("read-only");
  });

  it("keeps Codex chat on the bound root instead of OS temp when a workspace exists", () => {
    expect(codexThreadWorkspace(
      { canonicalRoot: "D:\\alpha-adk", filesystemAccess: "read-only" },
      "/tmp",
    )).toEqual({ cwd: "D:\\alpha-adk", sandbox: "read-only" });
    expect(codexThreadWorkspace(
      { canonicalRoot: "D:\\alpha-adk", filesystemAccess: "workspace-write" },
      "/tmp",
    )).toEqual({ cwd: "D:\\alpha-adk", sandbox: "workspace-write" });
  });

  it("falls back to the isolated cwd only when no workspace is bound", () => {
    expect(codexThreadWorkspace(undefined, "/tmp/naia-isolated")).toEqual({
      cwd: "/tmp/naia-isolated",
      sandbox: "read-only",
    });
  });
});
