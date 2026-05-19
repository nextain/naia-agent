// `naia-agent login` role-spec parser (Task #3 Slice B). The load-bearing
// case is cross-review Finding 3: a raw secret in the apiKeyRef slot must
// be REJECTED at the write boundary (login writes git-tracked llm.json).

import { describe, it, expect } from "vitest";
import { parseRoleSpec } from "../utils/login-spec.js";

describe("parseRoleSpec", () => {
  it("valid main/sub: provider|baseUrl|model [+apiKeyRef]", () => {
    const r = parseRoleSpec("openai-compat|http://127.0.0.1:11434/v1|gemma3n:e4b", false);
    expect(r).toEqual({ ok: true, role: { provider: "openai-compat", baseUrl: "http://127.0.0.1:11434/v1", model: "gemma3n:e4b" } });
    const r2 = parseRoleSpec("anthropic|https://api.anthropic.com|claude-x|ANTHROPIC_API_KEY", false);
    expect(r2.ok && r2.role.apiKeyRef).toBe("ANTHROPIC_API_KEY");
  });

  it("baseURL with :port survives | split", () => {
    const r = parseRoleSpec("openai-compat|http://host:8080/v1|m", false);
    expect(r.ok && r.role.baseUrl).toBe("http://host:8080/v1");
  });

  it("embedded requires positive INTEGER dims", () => {
    const ok = parseRoleSpec("ollama-embed|http://127.0.0.1:11434/v1|bge-m3|1024", true);
    expect(ok.ok && ok.role.dims).toBe(1024);
    for (const bad of ["0", "-1", "abc", "1024.5", ""]) {
      const r = parseRoleSpec(`ollama-embed|u|m|${bad}`, true);
      expect(r.ok).toBe(false);
    }
  });

  it("too few / empty fields → error", () => {
    expect(parseRoleSpec("openai-compat|u", false).ok).toBe(false);
    expect(parseRoleSpec("|u|m", false).ok).toBe(false);
    expect(parseRoleSpec("p||m", false).ok).toBe(false);
    expect(parseRoleSpec("p|u|m", true).ok).toBe(false); // embedded needs dims
  });

  it("Finding 3: RAW SECRET in apiKeyRef slot is REJECTED (write boundary)", () => {
    const bad = parseRoleSpec("anthropic|u|m|sk-ant-REALSECRET0123456789", false);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.err).toMatch(/RAW SECRET/);
    expect(parseRoleSpec("openai-compat|u|m|1024|AIzaSyAabcdefghij1234567890", true).ok).toBe(false);
    // whitespace in a ref name is also rejected (not a plausible name)
    expect(parseRoleSpec("anthropic|u|m|MY KEY", false).ok).toBe(false);
    // a plausible NAME is accepted
    expect(parseRoleSpec("anthropic|u|m|ANTHROPIC_API_KEY", false).ok).toBe(true);
  });
});
