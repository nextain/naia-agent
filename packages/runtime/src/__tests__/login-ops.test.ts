// packages/runtime/src/__tests__/login-ops.test.ts
// Unit tests for login-ops.ts pure functions.
// Covers: checkDuplicateKeys, buildEnvAppend, parseLoginArgs.
// No I/O, no TTY — all tests are deterministic and hermetic.
//
// Slice 1c success criterion: unit test 1+ (fixes G16 Track B).

import { describe, it, expect } from "vitest";
import { parseLoginArgs, checkDuplicateKeys, buildEnvAppend } from "../utils/login-ops.js";

// ── parseLoginArgs ────────────────────────────────────────────────────────────

describe("parseLoginArgs", () => {
  it("extracts provider from --key flag", () => {
    const r = parseLoginArgs(["--key", "anthropic"]);
    expect(r).toEqual({ provider: "anthropic" });
  });

  it("returns error when --key is absent", () => {
    const r = parseLoginArgs([]);
    expect(r).toEqual({ error: "missing --key <provider>" });
  });

  it("returns error when --key is the last arg (no value)", () => {
    const r = parseLoginArgs(["--key"]);
    expect(r).toMatchObject({ error: expect.stringContaining("missing") });
  });

  it("uses the last --key value when duplicated", () => {
    // Consistent with bin's loop-based parsing — last wins.
    const r = parseLoginArgs(["--key", "openai", "--key", "glm"]);
    expect(r).toEqual({ provider: "glm" });
  });

  it("ignores unrecognised flags", () => {
    const r = parseLoginArgs(["--debug", "--key", "vertex", "--verbose"]);
    expect(r).toEqual({ provider: "vertex" });
  });
});

// ── checkDuplicateKeys ────────────────────────────────────────────────────────

describe("checkDuplicateKeys", () => {
  it("all new keys → toAdd contains all, alreadySet empty", () => {
    const { toAdd, alreadySet } = checkDuplicateKeys(new Set(), {
      ANTHROPIC_API_KEY: "sk-ant-xxx",
    });
    expect(alreadySet).toEqual([]);
    expect(toAdd).toEqual([["ANTHROPIC_API_KEY", "sk-ant-xxx"]]);
  });

  it("all existing keys → toAdd empty, alreadySet contains all", () => {
    const existing = new Set(["ANTHROPIC_API_KEY"]);
    const { toAdd, alreadySet } = checkDuplicateKeys(existing, {
      ANTHROPIC_API_KEY: "new-value",
    });
    expect(toAdd).toEqual([]);
    expect(alreadySet).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("partial overlap → splits correctly", () => {
    const existing = new Set(["KEY1"]);
    const { toAdd, alreadySet } = checkDuplicateKeys(existing, {
      KEY1: "old",
      KEY2: "new",
    });
    expect(alreadySet).toEqual(["KEY1"]);
    expect(toAdd).toEqual([["KEY2", "new"]]);
  });

  it("empty values → both outputs empty", () => {
    const { toAdd, alreadySet } = checkDuplicateKeys(new Set(["KEY"]), {});
    expect(toAdd).toEqual([]);
    expect(alreadySet).toEqual([]);
  });

  it("empty existingKeys set → all go to toAdd", () => {
    const { toAdd, alreadySet } = checkDuplicateKeys(new Set(), {
      A: "1",
      B: "2",
    });
    expect(alreadySet).toEqual([]);
    expect(toAdd).toHaveLength(2);
  });
});

// ── buildEnvAppend ────────────────────────────────────────────────────────────

describe("buildEnvAppend", () => {
  it("empty toAdd returns existing unchanged", () => {
    expect(buildEnvAppend("KEY=val\n", [])).toBe("KEY=val\n");
  });

  it("appends to empty file", () => {
    expect(buildEnvAppend("", [["API_KEY", "sk-x"]])).toBe("API_KEY=sk-x\n");
  });

  it("appends after existing content that ends with newline", () => {
    const result = buildEnvAppend("OLD=v\n", [["NEW", "val"]]);
    expect(result).toBe("OLD=v\nNEW=val\n");
  });

  it("inserts separator when existing content lacks trailing newline", () => {
    const result = buildEnvAppend("OLD=v", [["NEW", "val"]]);
    expect(result).toBe("OLD=v\nNEW=val\n");
  });

  it("appends multiple pairs in order", () => {
    const result = buildEnvAppend("", [
      ["A", "1"],
      ["B", "2"],
    ]);
    expect(result).toBe("A=1\nB=2\n");
  });

  // Security: newline injection guards (CWE-93)
  it("throws on newline in key", () => {
    expect(() => buildEnvAppend("", [["KEY\nINJECT", "val"]])).toThrow(
      /invalid env key/,
    );
  });

  it("throws on carriage-return in key", () => {
    expect(() => buildEnvAppend("", [["KEY\rINJECT", "val"]])).toThrow(
      /invalid env key/,
    );
  });

  it("throws on '=' in key", () => {
    expect(() => buildEnvAppend("", [["KEY=BAD", "val"]])).toThrow(
      /invalid env key/,
    );
  });

  it("throws on newline in value", () => {
    expect(() => buildEnvAppend("", [["KEY", "val\nINJECT=pwned"]])).toThrow(
      /contains newline/,
    );
  });

  it("throws on carriage-return in value", () => {
    expect(() => buildEnvAppend("", [["KEY", "val\rINJECT"]])).toThrow(
      /contains newline/,
    );
  });

  it("fail-fast: throws on invalid second pair before writing any content (A3-002)", () => {
    // Guard loops over ALL pairs before the sep+join write.
    // Even if first pair is valid, an invalid second pair must throw.
    expect(() =>
      buildEnvAppend("", [
        ["A", "1"],
        ["B", "2\nINJECT=pwned"],
      ]),
    ).toThrow(/contains newline/);
  });
});

// ── checkDuplicateKeys + buildEnvAppend end-to-end ───────────────────────────

describe("checkDuplicateKeys → buildEnvAppend pipeline (S1-L2 scenario)", () => {
  it("S1-L2: duplicate key is excluded from written content", () => {
    const existingContent = "ANTHROPIC_API_KEY=old-key\n";
    const existingKeys = new Set(["ANTHROPIC_API_KEY"]);
    const newValues = { ANTHROPIC_API_KEY: "new-key", GLM_API_KEY: "glm-x" };

    const { toAdd, alreadySet } = checkDuplicateKeys(existingKeys, newValues);

    // Duplicate detected silently (caller logs stderr)
    expect(alreadySet).toContain("ANTHROPIC_API_KEY");
    // Only the new key reaches the file
    const result = buildEnvAppend(existingContent, toAdd);
    expect(result).toContain("GLM_API_KEY=glm-x");
    expect(result).not.toContain("new-key"); // old value preserved, not overwritten
  });
});
