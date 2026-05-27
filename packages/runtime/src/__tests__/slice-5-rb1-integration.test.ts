// Slice 5-RB1 integration — examples/naia-{coding,talk}.service.json
// parsing + makeGatewayFetch error chain end-to-end.
//
// Verifies the user-visible promise: a Phase-1 manifest parses cleanly
// against the v0.1.0 schema, AND the bin fetch wrapper correctly classifies
// gateway errors when wired with the parsed manifest's baseURL.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseServiceManifest,
  manifestBaseURLTrust,
} from "../host/index.js";
import { makeGatewayFetch } from "../utils/gateway-fetch.js";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const EXAMPLES = join(REPO_ROOT, "examples");

function readManifest(name: string): string {
  return readFileSync(join(EXAMPLES, name), "utf8");
}

describe("Slice 5-RB1 — examples manifests parse against v0.1.0", () => {
  it("examples/naia-coding.service.json passes parseServiceManifest", () => {
    const r = parseServiceManifest(readManifest("naia-coding.service.json"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.name).toBe("naia-coding");
      expect(r.manifest.schemaVersion).toBe("0.1.0");
      expect(r.manifest.llm.backend).toBe("openai-compatible");
      expect(r.manifest.llm.model).toBe("naia-coding");
      expect(r.manifest.llm.baseURL).toBe(
        "https://naia-gateway-dev.run.app/v1",
      );
      expect(r.manifest.memory.binding).toBe("alpha-memory");
    }
  });

  it("examples/naia-talk.service.json passes parseServiceManifest", () => {
    const r = parseServiceManifest(readManifest("naia-talk.service.json"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.name).toBe("naia-talk");
      expect(r.manifest.llm.model).toBe("naia-talk");
    }
  });

  it("manifest baseURL requires NAIA_ALLOW_MANIFEST_BASEURL_HOSTS opt-in for the deployed gateway", () => {
    // Public Cloud Run hosts are NOT loopback/private — operator MUST opt
    // in. This is the security gate from service-manifest.ts §269.
    const r = parseServiceManifest(readManifest("naia-coding.service.json"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(manifestBaseURLTrust(r.manifest.llm.baseURL!, {}).ok).toBe(false);
    expect(
      manifestBaseURLTrust(r.manifest.llm.baseURL!, {
        NAIA_ALLOW_MANIFEST_BASEURL_HOSTS: "naia-gateway-dev.run.app",
      }).ok,
    ).toBe(true);
  });
});

describe("Slice 5-RB1 — end-to-end gateway error chain on parsed manifest", () => {
  it("403 from unrelated host passes through (only 401/402/503 are classified)", async () => {
    const fetcher = makeGatewayFetch({
      rawFetch: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
        ),
      onFatalError: ((cls: string) => {
        throw new Error(`unexpected fatal: ${cls}`);
      }) as never,
    });
    const r = await fetcher("https://naia-gateway-dev.run.app/v1/chat");
    expect(r.status).toBe(403);
  });

  it("license-failed → onFatalError fires (would exit 3 in bin)", async () => {
    let captured: { cls: string; msg: string } | null = null;
    const fetcher = makeGatewayFetch({
      rawFetch: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "license-failed" }), {
            status: 401,
          }),
        ),
      lang: "ko",
      onFatalError: ((cls: string, msg: string) => {
        captured = { cls, msg };
        throw new Error("__exit_3__");
      }) as never,
    });
    await expect(
      fetcher("https://naia-gateway-dev.run.app/v1/chat"),
    ).rejects.toThrow("__exit_3__");
    expect(captured).not.toBeNull();
    expect(captured!.cls).toBe("license-failed");
    expect(captured!.msg).toContain("https://naia.nextain.io/ko/pricing");
  });

  it("503 pod-starting → retries then succeeds, onPodStarting fires every retry", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const pending: string[] = [];
    const fetcher = makeGatewayFetch({
      rawFetch: vi.fn().mockImplementation(async () => {
        attempts += 1;
        if (attempts < 3) {
          return new Response(JSON.stringify({ error: "pod-starting" }), {
            status: 503,
          });
        }
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      }) as unknown as typeof fetch,
      onFatalError: (() => {
        throw new Error("unexpected fatal");
      }) as never,
      onPodStarting: (msg) => pending.push(msg),
      now: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const r = await fetcher("https://naia-gateway-dev.run.app/v1/chat");
    expect(r.status).toBe(200);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([5_000, 10_000]);
    expect(pending).toHaveLength(2);
  });

  it("credit-insufficient on en locale uses /en/pricing deeplink", async () => {
    let captured: { msg: string } | null = null;
    const fetcher = makeGatewayFetch({
      rawFetch: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "credit-insufficient" }), {
            status: 402,
          }),
        ),
      lang: "en",
      onFatalError: ((cls: string, msg: string) => {
        captured = { msg };
        throw new Error("__exit_3__");
      }) as never,
    });
    await expect(
      fetcher("https://naia-gateway-dev.run.app/v1/chat"),
    ).rejects.toThrow("__exit_3__");
    expect(captured).not.toBeNull();
    expect(captured!.msg).toContain("/en/pricing");
  });
});
