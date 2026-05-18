// R6/SB-1 (#32, matrix §D50) — S02 unit: service manifest schema validation.
// Pure (no bin spawn, no network, no API key) → G15 CI fixture-only safe.
//
// Schema SoT: naia-adk/docs/service-manifest-schema.md (v0.1.0).
// Compat rules: schema §3 (additive=MINOR, MAJOR bump=reject, forward-compat).

import { describe, it, expect } from "vitest";
import {
  parseServiceManifest,
  resolveMemoryBinding,
  manifestBaseURLTrust,
  manifestInvalid,
  SUPPORTED_MANIFEST_MAJOR,
} from "../host/service-manifest.js";
import { InMemoryMemory } from "../mocks/in-memory-memory.js";

// The schema §5 example (qwen3.6-27b-dense, SB-1), as raw JSON text.
const VALID = JSON.stringify({
  schemaVersion: "0.1.0",
  name: "coding-assistant",
  description: "qwen3.6-27b 코딩 어시스턴트 (naia-model-infra 48G)",
  persona: { systemPrompt: "You are a precise coding assistant. Korean/English." },
  llm: {
    backend: "openai-compatible",
    model: "Qwen/Qwen3.6-27B-FP8",
    baseURL: "http://localhost:8000/v1",
  },
  memory: { binding: "alpha-memory" },
});

describe("parseServiceManifest — valid (schema §5 example)", () => {
  it("accepts the v0.1.0 example and preserves fields", () => {
    const r = parseServiceManifest(VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.schemaVersion).toBe("0.1.0");
    expect(r.manifest.name).toBe("coding-assistant");
    expect(r.manifest.persona.systemPrompt).toContain("coding assistant");
    expect(r.manifest.llm.backend).toBe("openai-compatible");
    expect(r.manifest.llm.model).toBe("Qwen/Qwen3.6-27B-FP8");
    expect(r.manifest.llm.baseURL).toBe("http://localhost:8000/v1");
    expect(r.manifest.memory.binding).toBe("alpha-memory");
    expect(r.manifest.description).toContain("naia-model-infra");
  });

  it("baseURL + description are optional (minimal valid manifest)", () => {
    const r = parseServiceManifest(
      JSON.stringify({
        schemaVersion: "0.1.0",
        name: "min",
        persona: { systemPrompt: "hi" },
        llm: { backend: "anthropic", model: "claude-haiku-4-5-20251001" },
        memory: { binding: "in-memory" },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.llm.baseURL).toBeUndefined();
    expect(r.manifest.description).toBeUndefined();
  });

  it('accepts backend "claude-code" (Claude Agent SDK / subscription — naia-agent#39, D18)', () => {
    const r = parseServiceManifest(
      JSON.stringify({
        schemaVersion: "0.1.0",
        name: "cc",
        persona: { systemPrompt: "hi" },
        llm: { backend: "claude-code", model: "sonnet" },
        memory: { binding: "in-memory" },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.llm.backend).toBe("claude-code");
    expect(r.manifest.llm.model).toBe("sonnet");
    expect(r.manifest.llm.baseURL).toBeUndefined();
  });
});

describe("parseServiceManifest — MANIFEST_INVALID (canonical ErrorEvent)", () => {
  function expectInvalid(raw: string, detailIncludes: string) {
    const r = parseServiceManifest(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Canonical Part-A.11 ErrorEvent shape (not the design prose snake_case).
    expect(r.error.name).toBe("error.manifest");
    expect(r.error.errorCode).toBe("MANIFEST_INVALID");
    expect(r.error.severity).toBe("error");
    expect(r.error.retryable).toBe(false);
    expect(typeof r.error.timestamp).toBe("number");
    expect(String(r.error.data?.["detail"])).toContain(detailIncludes);
  }

  it("rejects malformed JSON", () => {
    expectInvalid("{ not json", "invalid JSON");
  });

  it("rejects a non-object root", () => {
    expectInvalid("[]", "must be a JSON object");
  });

  it("rejects missing schemaVersion", () => {
    expectInvalid(
      JSON.stringify({ name: "x", persona: { systemPrompt: "p" }, llm: { backend: "b", model: "m" }, memory: { binding: "none" } }),
      "schemaVersion is required",
    );
  });

  it("rejects non-semver schemaVersion", () => {
    expectInvalid(
      JSON.stringify({ schemaVersion: "0.1", name: "x", persona: { systemPrompt: "p" }, llm: { backend: "b", model: "m" }, memory: { binding: "none" } }),
      "not semver",
    );
  });

  it("rejects missing name", () => {
    expectInvalid(
      JSON.stringify({ schemaVersion: "0.1.0", persona: { systemPrompt: "p" }, llm: { backend: "b", model: "m" }, memory: { binding: "none" } }),
      "name is required",
    );
  });

  it("rejects missing persona.systemPrompt", () => {
    expectInvalid(
      JSON.stringify({ schemaVersion: "0.1.0", name: "x", persona: {}, llm: { backend: "b", model: "m" }, memory: { binding: "none" } }),
      "persona.systemPrompt is required",
    );
  });

  it("rejects missing llm.backend / llm.model", () => {
    expectInvalid(
      JSON.stringify({ schemaVersion: "0.1.0", name: "x", persona: { systemPrompt: "p" }, llm: { model: "m" }, memory: { binding: "none" } }),
      "llm.backend is required",
    );
    expectInvalid(
      JSON.stringify({ schemaVersion: "0.1.0", name: "x", persona: { systemPrompt: "p" }, llm: { backend: "b" }, memory: { binding: "none" } }),
      "llm.model is required",
    );
  });

  it("rejects wrong-typed llm.baseURL", () => {
    expectInvalid(
      JSON.stringify({ schemaVersion: "0.1.0", name: "x", persona: { systemPrompt: "p" }, llm: { backend: "b", model: "m", baseURL: 42 }, memory: { binding: "none" } }),
      "llm.baseURL must be a string",
    );
  });

  it("rejects missing memory.binding", () => {
    expectInvalid(
      JSON.stringify({ schemaVersion: "0.1.0", name: "x", persona: { systemPrompt: "p" }, llm: { backend: "b", model: "m" }, memory: {} }),
      "memory.binding is required",
    );
  });
});

describe("parseServiceManifest — schemaVersion compat (schema §3)", () => {
  it(`rejects a MAJOR above ${SUPPORTED_MANIFEST_MAJOR} (unsupported)`, () => {
    const r = parseServiceManifest(
      JSON.stringify({
        schemaVersion: "1.0.0",
        name: "x",
        persona: { systemPrompt: "p" },
        llm: { backend: "b", model: "m" },
        memory: { binding: "none" },
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(String(r.error.data?.["detail"])).toContain("unsupported schemaVersion");
  });

  it("forward-compat: higher MINOR with unknown additive fields is accepted & ignored", () => {
    const r = parseServiceManifest(
      JSON.stringify({
        schemaVersion: "0.9.0",
        name: "x",
        persona: { systemPrompt: "p" },
        llm: { backend: "b", model: "m" },
        memory: { binding: "in-memory" },
        // SB-2/SB-3 additive fields the SB-1 loader must tolerate (not consume):
        rag: { sources: ["alpha-memory://notes"] },
        eval: { fixtures: ["x.json"] },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Unknown fields are dropped from the typed shape (not consumed by SB-1).
    expect((r.manifest as unknown as Record<string, unknown>)["rag"]).toBeUndefined();
  });
});

describe("resolveMemoryBinding", () => {
  it('"in-memory" → InMemoryMemory', async () => {
    expect(await resolveMemoryBinding("in-memory")).toBeInstanceOf(InMemoryMemory);
  });

  it('"none" → InMemoryMemory (SB-1 minimal no-memory)', async () => {
    expect(await resolveMemoryBinding("none")).toBeInstanceOf(InMemoryMemory);
  });

  it('"alpha-memory" without a host factory throws', async () => {
    await expect(resolveMemoryBinding("alpha-memory")).rejects.toThrow(
      /alphaMemoryFactory/,
    );
  });

  it('"alpha-memory" uses the injected host factory', async () => {
    const sentinel = new InMemoryMemory();
    const got = await resolveMemoryBinding("alpha-memory", {
      alphaMemoryFactory: async () => sentinel,
    });
    expect(got).toBe(sentinel);
  });

  it("unknown binding throws", async () => {
    await expect(resolveMemoryBinding("redis")).rejects.toThrow(
      /unknown memory\.binding/,
    );
  });
});

// ── Security review SB-1 Vuln 2 — name path-traversal hardening ──────────────
describe("parseServiceManifest — name is a strict kebab slug (no traversal)", () => {
  function withName(name: unknown): string {
    return JSON.stringify({
      schemaVersion: "0.1.0",
      name,
      persona: { systemPrompt: "p" },
      llm: { backend: "anthropic", model: "m" },
      memory: { binding: "alpha-memory" },
    });
  }

  it.each([
    "../../../../tmp/evil",
    "..",
    "a/b",
    "a\\b",
    "a.b",
    "Coding-Assistant",
    "-leading-hyphen",
    "a".repeat(65),
    "name with spaces",
  ])("rejects path-unsafe / non-kebab name %j", (bad) => {
    const r = parseServiceManifest(withName(bad));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.errorCode).toBe("MANIFEST_INVALID");
    expect(String(r.error.data?.["detail"])).toContain("kebab-case");
  });

  it.each(["coding-assistant", "svc1", "a", "a-b-c-123"])(
    "accepts valid kebab name %j",
    (good) => {
      expect(parseServiceManifest(withName(good)).ok).toBe(true);
    },
  );
});

// ── Security review SB-1 Vuln 1 — baseURL trust gate (key exfil) ─────────────
describe("manifestBaseURLTrust", () => {
  const noAllow = {};

  it.each([
    "http://localhost:8000/v1",
    "http://127.0.0.1:8000/v1",
    "http://0.0.0.0:8000",
    "http://10.0.0.5:8000/v1",
    "http://192.168.1.10/v1",
    "http://172.16.0.1/v1",
    "https://[::1]/v1",
  ])("trusts loopback/private host %j with no allowlist", (u) => {
    expect(manifestBaseURLTrust(u, noAllow).ok).toBe(true);
  });

  it.each([
    "http://[fe80::1]/v1", // IPv6 link-local
    "http://[fc00::1]/v1", // IPv6 unique-local (ULA)
    "http://172.31.255.255/v1", // 172.16/12 upper bound
    "http://172.16.0.0/v1", // 172.16/12 lower bound
  ])("trusts IPv6 ULA/link-local + private boundary %j", (u) => {
    expect(manifestBaseURLTrust(u, noAllow).ok).toBe(true);
  });

  it.each([
    "http://0x7f000001/v1", // hex → WHATWG canonicalizes to 127.0.0.1
    "http://2130706433/v1", // decimal → WHATWG canonicalizes to 127.0.0.1
  ])("trusts integer IPv4 that canonicalizes to loopback %j", (u) => {
    expect(manifestBaseURLTrust(u, noAllow).ok).toBe(true);
  });

  // Cross-review r2 (codex MINOR) — uppercase canonicalizes to localhost.
  it("trusts case-canonicalized loopback (LOCALHOST → localhost)", () => {
    expect(manifestBaseURLTrust("http://LOCALHOST:8000/v1", noAllow).ok).toBe(true);
  });

  // Cross-review r3 (codex NEW MINOR) — userinfo credentials are refused
  // outright (schema §4: no secrets in manifest; also no log leak), even
  // when the host itself would otherwise be a trusted loopback.
  it.each([
    "http://user:pass@127.0.0.1/v1",
    "http://localhost@evil.com/v1",
    "https://token@api.vendor.com/v1",
  ])("refuses baseURL with embedded credentials %j", (u) => {
    const r = manifestBaseURLTrust(u, noAllow);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/credentials|userinfo/);
  });

  // Cross-review r1 (codex MAJOR) — prefix-match bypass MUST be rejected:
  // a DNS name that merely *starts with* a private prefix is NOT local.
  it.each([
    "http://127.0.0.1.evil.com/v1",
    "http://10.0.0.5.evil.com/v1",
    "http://192.168.1.10.evil.com/v1",
    "http://172.16.0.1.evil.com/v1",
    "http://169.254.0.1.evil.com/v1",
    "http://localhost.evil.com/v1",
    "http://localhost./v1", // trailing-dot FQDN, not exactly "localhost"
    "http://8.8.8.8/v1", // public IPv4
    "http://172.32.0.1/v1", // just above 172.16/12 → public
    "http://172.15.0.1/v1", // just below 172.16/12 → public
    "https://[2001:4860:4860::8888]/v1", // public IPv6
  ])("refuses hostile / non-local host %j (key-exfil bypass closed)", (u) => {
    const r = manifestBaseURLTrust(u, noAllow);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("NAIA_ALLOW_MANIFEST_BASEURL_HOSTS");
  });

  it("refuses a remote host when not allowlisted (key-exfil vector)", () => {
    const r = manifestBaseURLTrust("https://attacker.example/v1", noAllow);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("NAIA_ALLOW_MANIFEST_BASEURL_HOSTS");
  });

  it("allows a remote host only when operator opts in via env allowlist", () => {
    expect(
      manifestBaseURLTrust("https://api.vendor.com/v1", {
        NAIA_ALLOW_MANIFEST_BASEURL_HOSTS: "other.com, api.vendor.com",
      }).ok,
    ).toBe(true);
  });

  // Cross-review r2 (codex MINOR) — allowlist is EXACT, not prefix/suffix.
  it("allowlist is exact-only — a near-match host is still refused", () => {
    const env = { NAIA_ALLOW_MANIFEST_BASEURL_HOSTS: "api.vendor.com" };
    expect(manifestBaseURLTrust("https://api.vendor.com/v1", env).ok).toBe(true);
    const r = manifestBaseURLTrust("https://api.vendor.com.evil.com/v1", env);
    expect(r.ok).toBe(false); // suffix-extended host must NOT pass
    const r2 = manifestBaseURLTrust("https://evil-api.vendor.com/v1", env);
    expect(r2.ok).toBe(false); // prefix-extended host must NOT pass
  });

  it.each(["file:///etc/passwd", "ftp://host/x", "gopher://h"])(
    "refuses non-http(s) protocol %j",
    (u) => {
      const r = manifestBaseURLTrust(u, noAllow);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toMatch(/protocol|valid URL/);
    },
  );

  it("refuses a malformed URL", () => {
    expect(manifestBaseURLTrust("not a url", noAllow).ok).toBe(false);
  });
});

// Cross-review r4 (codex MEDIUM) — the shared canonical MANIFEST_INVALID
// builder. Host code (CLI unreadable-manifest path) reuses THIS, so pinning
// its shape here also guards the host-side path against drift (the prior
// hand-rolled object omitted the contract `timestamp`).
describe("manifestInvalid — canonical Part-A.11 ErrorEvent shape", () => {
  it("has all contract fields incl. timestamp", () => {
    const e = manifestInvalid('cannot read manifest "x": ENOENT');
    expect(e.name).toBe("error.manifest");
    expect(e.errorCode).toBe("MANIFEST_INVALID");
    expect(e.severity).toBe("error");
    expect(e.retryable).toBe(false);
    expect(typeof e.timestamp).toBe("number");
    expect(e.timestamp).toBeGreaterThan(0);
    expect(e.data?.["detail"]).toContain("cannot read manifest");
  });

  it("parser errors and host-built errors share the identical shape", () => {
    const fromParser = parseServiceManifest("{ bad");
    expect(fromParser.ok).toBe(false);
    if (fromParser.ok) return;
    const fromHost = manifestInvalid("cannot read manifest");
    expect(Object.keys(fromParser.error).sort()).toEqual(
      Object.keys(fromHost).sort(),
    );
  });
});
