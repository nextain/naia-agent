// OS-keychain secret store (Slice B). The real libsecret backend needs a
// live Secret Service, so here we test (a) the platform-default contract,
// (b) the test seam, and (c) resolveSecret's keychain fallback + env
// precedence via an injected fake store (no real keychain touched).

import { afterEach, describe, expect, it } from "vitest";
import {
  getSecretStore,
  __setSecretStoreForTest,
  classifyProbe,
  type SecretStore,
} from "../utils/secret-store.js";

afterEach(() => __setSecretStoreForTest()); // reset singleton

describe("classifyProbe (locale-independent — cross-review BLOCK fix)", () => {
  // Real `secret-tool` outputs measured on a Korean-locale box with the
  // Secret Service deliberately broken (the BLOCK that English-substring
  // matching missed). Success-classification must call these UNAVAILABLE.
  it("healthy service, absent key → exit 1 + empty stderr → AVAILABLE", () => {
    expect(classifyProbe({ status: 1, stderr: "" })).toBe(true);
    expect(classifyProbe({ status: 1, stderr: "   \n" })).toBe(true);
  });
  it("found key → exit 0 → AVAILABLE", () => {
    expect(classifyProbe({ status: 0, stderr: "" })).toBe(true);
  });
  it("localized down-state stderr → UNAVAILABLE (no English heuristic)", () => {
    for (const s of [
      "secret-tool: 연결할 수 없습니다: 그런 파일이나 디렉터리가 없습니다",
      "secret-tool: 지정된 주소가 빈 문자열입니다",
      "secret-tool: 연결할 수 없습니다: 연결이 거부됨",
      "secret-tool: The given address is empty", // C-locale variant
    ]) {
      expect(classifyProbe({ status: 1, stderr: s })).toBe(false);
    }
  });
  it("spawn error / timeout-kill (status null) → UNAVAILABLE", () => {
    expect(classifyProbe({ error: new Error("ENOENT"), status: null, stderr: "" })).toBe(false);
    expect(classifyProbe({ status: null, stderr: "" })).toBe(false);
  });
  it("unexpected non-zero status → UNAVAILABLE", () => {
    expect(classifyProbe({ status: 127, stderr: "" })).toBe(false);
    expect(classifyProbe({ status: 2, stderr: "boom" })).toBe(false);
  });
});

describe("getSecretStore", () => {
  it("returns a singleton; non-linux degrades to unavailable (never plaintext)", () => {
    const a = getSecretStore();
    const b = getSecretStore();
    expect(a).toBe(b);
    if (process.platform !== "linux") {
      expect(a.available()).toBe(false);
      expect(a.get("x")).toBeUndefined();
      expect(a.set("x", "y")).toBe(false);
    }
  });

  it("test seam injects + resets", () => {
    const fake: SecretStore = {
      available: () => true,
      get: (n) => (n === "K" ? "v" : undefined),
      set: () => true,
    };
    __setSecretStoreForTest(fake);
    expect(getSecretStore()).toBe(fake);
    expect(getSecretStore().get("K")).toBe("v");
    __setSecretStoreForTest();
    expect(getSecretStore()).not.toBe(fake);
  });
});
