import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeDiscordRuntimeText } from "../main/adapters/discord-messages.js";

describe("Discord runtime user-facing i18n", () => {
  it("provides the same message operations in Korean and English", () => {
    for (const locale of ["ko", "en"] as const) {
      const text = makeDiscordRuntimeText(locale);
      expect(text.emptyReply()).not.toBe("");
      expect(text.failureReply()).not.toBe("");
      expect(text.processingDisclosure({
        workload: "embedding",
        destination: "external_cloud",
        decision: "allowed",
      })).toContain("external_cloud");
    }
  });

  it("keeps user-facing literals out of the lifecycle/transport implementation", () => {
    const source = readFileSync(new URL("../main/adapters/discord-channel.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/[가-힣]/);
  });
});
