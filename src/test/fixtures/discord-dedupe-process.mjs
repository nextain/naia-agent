import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { makeFileDiscordDedupe } from "../../../dist/main/adapters/discord-dedupe-store.js";

const [path, action, readyPath, barrierPath, bindingId, messageId, nowText] = process.argv.slice(2);
if (!path || !action || !readyPath || !barrierPath || !bindingId || !messageId || !nowText) {
  throw new Error("DISCORD_DEDUPE_PROCESS_ARGS");
}
const now = Number(nowText);
const store = makeFileDiscordDedupe({ path, maxEntries: 16, ttlMs: 10_000 });

if (action === "old_reply") {
  await store.reserve({ bindingId, messageId, now });
  await store.beginReply({ bindingId, messageId, chunks: ["one", "two"], now: now + 1 });
  await store.claimChunk({ bindingId, messageId, nextChunk: 1, now: now + 2 });
  await store.confirmChunk({ bindingId, messageId, confirmedChunk: 1, now: now + 3 });
}

writeFileSync(readyPath, "ready");
while (!existsSync(barrierPath)) await delay(2);

let result;
if (action === "reserve") {
  result = await store.reserve({ bindingId, messageId, now });
} else if (action === "old_reply") {
  result = {
    partial: await store.partial({ bindingId, messageId, confirmedChunk: 1, now: now + 5 }),
    claim: await store.claimChunk({ bindingId, messageId, nextChunk: 2, now: now + 6 }),
  };
} else if (action === "resume_reply") {
  const reservation = await store.reserve({ bindingId, messageId, now: now + 4 });
  result = {
    reservation,
    claim: await store.claimChunk({ bindingId, messageId, nextChunk: 2, now: now + 7 }),
  };
} else {
  throw new Error("DISCORD_DEDUPE_PROCESS_ACTION");
}
process.stdout.write(`${JSON.stringify(result)}\n`);
