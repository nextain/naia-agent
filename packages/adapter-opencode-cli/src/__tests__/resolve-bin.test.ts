// Unit tests for resolve-bin.ts security validation (P0-2 / #23).

import { describe, it, expect, beforeEach, afterEach } from "vitest";

// We test the validation logic by probing the exported function through
// OpencodeRunAdapter.health() which calls resolveOpencodeBin() internally.
// For direct validation, we test via the adapter's resolveBin path.

import { resolveOpencodeBin } from "../resolve-bin.js";

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}

describe("resolveOpencodeBin — OPENCODE_BIN validation (P0-2 / #23)", () => {
  it("returns OPENCODE_BIN when it is a valid absolute path", () => {
    const abs = process.platform === "win32" ? "C:\\tools\\opencode.exe" : "/usr/local/bin/opencode";
    withEnv("OPENCODE_BIN", abs, () => {
      const r = resolveOpencodeBin();
      expect(r.command).toBe(abs);
      expect(r.prefixArgs).toHaveLength(0);
    });
  });

  it("throws on relative OPENCODE_BIN (path hijacking, P0-2)", () => {
    withEnv("OPENCODE_BIN", "../../../bin/evil", () => {
      expect(() => resolveOpencodeBin()).toThrow(/must be an absolute path/);
    });
  });

  it("ignores empty OPENCODE_BIN and falls through to PATH/npx", () => {
    withEnv("OPENCODE_BIN", "", () => {
      // Should not throw — falls through to PATH lookup or npx
      expect(() => resolveOpencodeBin()).not.toThrow();
      const r = resolveOpencodeBin();
      // Either found in PATH or fallback to npx
      expect(typeof r.command).toBe("string");
      expect(r.command.length).toBeGreaterThan(0);
    });
  });

  it("ignores whitespace-only OPENCODE_BIN and falls through", () => {
    withEnv("OPENCODE_BIN", "   ", () => {
      expect(() => resolveOpencodeBin()).not.toThrow();
    });
  });

  it("falls back to npx when OPENCODE_BIN unset and opencode not in PATH", () => {
    // Temporarily unset OPENCODE_BIN; opencode may or may not be in PATH
    withEnv("OPENCODE_BIN", undefined, () => {
      const r = resolveOpencodeBin();
      // Either found in PATH (any non-empty string) or falls to npx
      if (r.command === "npx") {
        expect(r.prefixArgs).toContain("opencode-ai@1.14.25");
      } else {
        expect(r.command.length).toBeGreaterThan(0);
      }
    });
  });
});
