// notify skill 테스트 — agent-local(target 검증 + payload + injected post/webhookUrl mock). 외부 webhook 불요.
import { describe, it, expect } from "vitest";
import { makeNotifyExecutor, type NotifyDeps } from "../main/adapters/notify-skills.js";
import type { ToolCall } from "../main/domain/chat.js";

const call = (args: Record<string, unknown>): ToolCall => ({ id: "1", name: "notify", args });

function mk(over: Partial<NotifyDeps> = {}): { deps: NotifyDeps; posts: Array<{ url: string; body: unknown }> } {
  const posts: Array<{ url: string; body: unknown }> = [];
  const deps: NotifyDeps = {
    post: async (url, body) => { posts.push({ url, body }); return { ok: true, status: 200 }; },
    webhookUrl: async (t) => (t === "slack" ? "https://hooks/slack" : t === "discord" ? "https://hooks/discord" : null),
    ...over,
  };
  return { deps, posts };
}

describe("notify skill", () => {
  it("tier=ask(외부발신 승인)", () => {
    expect(makeNotifyExecutor().specs().find((s) => s.name === "notify")?.tier).toBe("ask");
  });
  it("slack → {text} payload POST", async () => {
    const { deps, posts } = mk();
    const r = await makeNotifyExecutor(deps).execute(call({ target: "slack", message: "hi" }), {});
    expect(r.isError).toBeUndefined();
    expect(posts).toEqual([{ url: "https://hooks/slack", body: { text: "hi" } }]);
  });
  it("discord → {content} payload (old 충실)", async () => {
    const { deps, posts } = mk();
    await makeNotifyExecutor(deps).execute(call({ target: "discord", message: "yo" }), {});
    expect(posts[0].body).toEqual({ content: "yo" });
  });
  it("webhook 미설정 → 정직 isError(empty POST 안 함)", async () => {
    const { deps, posts } = mk();
    const r = await makeNotifyExecutor(deps).execute(call({ target: "google_chat", message: "x" }), {});
    expect(r.isError).toBe(true);
    expect(posts).toEqual([]);
  });
  it("post/webhookUrl 미주입 → unsupported", async () => {
    expect((await makeNotifyExecutor().execute(call({ target: "slack", message: "x" }), {})).isError).toBe(true);
  });
  it("target/message 검증", async () => {
    const { deps } = mk();
    expect((await makeNotifyExecutor(deps).execute(call({ target: "sms", message: "x" }), {})).isError).toBe(true);
    expect((await makeNotifyExecutor(deps).execute(call({ target: "slack" }), {})).isError).toBe(true);
    expect((await makeNotifyExecutor(deps).execute(call({ target: "slack", message: "  " }), {})).isError).toBe(true);
  });
  it("webhook 실패(ok=false) → status isError", async () => {
    const { deps } = mk({ post: async () => ({ ok: false, status: 500 }) });
    const r = await makeNotifyExecutor(deps).execute(call({ target: "slack", message: "x" }), {});
    expect(r).toEqual({ output: "slack webhook 500", isError: true });
  });
});
