// Slice #68 — unit tests for createCodeGraphExecutor.
//
// Tests are intentionally offline: no real codegraph binary is invoked.
// MCPClient.connect() is mocked to simulate binary-not-found failures.

import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCodeGraphExecutor } from "../skills/codegraph.js";

// --- helpers -----------------------------------------------------------------

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "naia-codegraph-test-"));
}

function cleanup(dir: string) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// --- tests -------------------------------------------------------------------

describe("createCodeGraphExecutor — no .codegraph/ index", () => {
  it("returns null when .codegraph/ directory is absent", async () => {
    const dir = mkTmpDir();
    try {
      const result = await createCodeGraphExecutor({ workdir: dir });
      expect(result).toBeNull();
    } finally {
      cleanup(dir);
    }
  });

  it("returns null for a nonexistent workdir path", async () => {
    const result = await createCodeGraphExecutor({
      workdir: path.join(os.tmpdir(), `naia-nonexistent-${Date.now()}`),
    });
    expect(result).toBeNull();
  });
});

describe("createCodeGraphExecutor — binary failure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when MCPClient.connect() throws (binary not found)", async () => {
    const dir = mkTmpDir();
    // Create the .codegraph/ sentinel so existsSync passes.
    fs.mkdirSync(path.join(dir, ".codegraph"));

    // Mock MCPClient to throw on connect() — simulates missing binary.
    vi.mock("../mcp/index.js", () => ({
      MCPClient: class {
        connect() {
          throw new Error("spawn nonexistent-binary-xyz ENOENT");
        }
      },
      MCPToolExecutor: class {},
    }));

    try {
      const result = await createCodeGraphExecutor({
        workdir: dir,
        bin: "nonexistent-binary-xyz",
      });
      expect(result).toBeNull();
    } finally {
      cleanup(dir);
    }
  });
});

describe("createCodeGraphExecutor — exports", () => {
  it("is exported from skills/index.ts (public API)", async () => {
    const skills = await import("../skills/index.js");
    expect(typeof skills.createCodeGraphExecutor).toBe("function");
  });
});
