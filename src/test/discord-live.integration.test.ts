import { describe, expect, it } from "vitest";
import { makeDiscordGateway } from "../main/adapters/discord-gateway.js";

const enabled = process.env.NAIA_DISCORD_LIVE === "1"
  && typeof process.env.NAIA_DISCORD_LIVE_BOT_TOKEN === "string";

describe.skipIf(!enabled)("credential-required Discord test-guild smoke", () => {
  it("authenticates and reaches READY without logging or persisting the token", async () => {
    const token = process.env.NAIA_DISCORD_LIVE_BOT_TOKEN!;
    const gateway = makeDiscordGateway();
    let readyUserId = "";
    const connection = await gateway.connect(token, {
      onReady(selfUserId) { readyUserId = selfUserId; },
      onMessage() {},
    });
    try {
      const deadline = Date.now() + 15_000;
      while (!readyUserId && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(readyUserId).toMatch(/^\d+$/);
    } finally {
      connection.close();
    }
  }, 20_000);
});
