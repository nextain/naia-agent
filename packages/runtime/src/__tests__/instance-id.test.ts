// Slice 5-RB1.d — naia-os instance_id resolver tests.
// Uses real fs in os.tmpdir() so the persistence path is exercised end-to-end.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveInstanceId } from "../utils/instance-id.js";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("resolveInstanceId", () => {
  let adkPath: string;
  let home: string;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "naia-instance-"));
    adkPath = join(root, "adk");
    home = join(root, "home");
    await mkdir(adkPath, { recursive: true });
    await mkdir(home, { recursive: true });
  });

  it("reads instanceId from naia-settings/naia-os.json when present", async () => {
    const settingsDir = join(adkPath, "naia-settings");
    await mkdir(settingsDir, { recursive: true });
    const id = "12345678-1234-4abc-9def-1234567890ab";
    await writeFile(
      join(settingsDir, "naia-os.json"),
      JSON.stringify({ instanceId: id, tierBEnabled: true }),
      "utf8",
    );
    const r = await resolveInstanceId({ adkPath, home });
    expect(r).toEqual({ instanceId: id, source: "naia-settings" });
  });

  it("falls through naia-os.json with invalid (non-UUID) instanceId", async () => {
    const settingsDir = join(adkPath, "naia-settings");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      join(settingsDir, "naia-os.json"),
      JSON.stringify({ instanceId: "not-a-uuid" }),
      "utf8",
    );
    const r = await resolveInstanceId({ adkPath, home });
    expect(r.source).toBe("fallback-generated");
    expect(r.instanceId).toMatch(UUID_V4_RE);
  });

  it("falls through corrupted JSON to fallback", async () => {
    const settingsDir = join(adkPath, "naia-settings");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "naia-os.json"), "not json", "utf8");
    const r = await resolveInstanceId({ adkPath, home });
    expect(r.source).toBe("fallback-generated");
  });

  it("reads existing fallback file", async () => {
    const fallbackDir = join(home, ".naia-agent");
    await mkdir(fallbackDir, { recursive: true });
    const id = "abcdef01-2345-4678-9abc-def012345678";
    await writeFile(
      join(fallbackDir, "instance.json"),
      JSON.stringify({ instanceId: id }),
      "utf8",
    );
    const r = await resolveInstanceId({ adkPath, home });
    expect(r).toEqual({ instanceId: id, source: "fallback-existing" });
  });

  it("generates a UUID v4 and persists at mode 600 when no source exists", async () => {
    const r = await resolveInstanceId({ adkPath, home });
    expect(r.source).toBe("fallback-generated");
    expect(r.instanceId).toMatch(UUID_V4_RE);

    const persisted = JSON.parse(
      await readFile(join(home, ".naia-agent", "instance.json"), "utf8"),
    ) as { instanceId: string; createdAt: string };
    expect(persisted.instanceId).toBe(r.instanceId);
    expect(persisted.createdAt).toBeTypeOf("string");

    if (process.platform !== "win32") {
      const s = await stat(join(home, ".naia-agent", "instance.json"));
      expect(s.mode & 0o777).toBe(0o600);
    }
  });

  it("is stable across calls (idempotent after generation)", async () => {
    const a = await resolveInstanceId({ adkPath, home });
    const b = await resolveInstanceId({ adkPath, home });
    expect(a.instanceId).toBe(b.instanceId);
    expect(a.source).toBe("fallback-generated");
    expect(b.source).toBe("fallback-existing");
  });
});
