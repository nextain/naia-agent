// UC-CLI S1(대화) 계약테스트 — FR-CLI-7(멀티턴 REPL host)·FR-CLI-8(login).
// 순수 로직(파싱·history·provider 선택·.env upsert)만 검증. 실 provider/bin 통합은 bin 실행 검증(progress 기록).
import { describe, it, expect } from "vitest";
import {
  parseChatArgs, upsertEnvLine, chooseProviderConfig, apiKeyEnvFor, makeReplConversation,
  PROVIDER_DEFAULT_MODEL, PROVIDER_API_KEY_ENV,
} from "../main/app/cli-chat.js";
import type { AgentRequest, AgentEmit, ChatRequest } from "../main/domain/chat.js";

describe("parseChatArgs", () => {
  it("인자 없음 = chat 모드(기본)", () => {
    const r = parseChatArgs([]);
    expect(r.ok).toBe(true);
    expect(r.args?.mode).toBe("chat");
  });
  it("chat 옵션 파싱(--system/--once/--no-tools/--provider/--model)", () => {
    const r = parseChatArgs(["chat", "--system", "너는 비서", "--once", "안녕", "--no-tools", "--provider", "anthropic", "--model", "claude-x"]);
    expect(r.ok).toBe(true);
    expect(r.args).toMatchObject({ mode: "chat", systemPrompt: "너는 비서", once: "안녕", noTools: true, provider: "anthropic", model: "claude-x" });
  });
  it("login 모드 — provider 필수", () => {
    expect(parseChatArgs(["login"]).ok).toBe(false);
    const r = parseChatArgs(["login", "--provider", "anthropic", "--key", "sk-x"]);
    expect(r.ok).toBe(true);
    expect(r.args).toMatchObject({ mode: "login", provider: "anthropic", key: "sk-x" });
  });
  it("login — 미지 provider 거부", () => {
    expect(parseChatArgs(["login", "--provider", "nonsense"]).ok).toBe(false);
  });
  it("--help = help(ok:false, help:true, usage)", () => {
    const r = parseChatArgs(["--help"]);
    expect(r.ok).toBe(false);
    expect(r.help).toBe(true);
    expect(r.error).toContain("멀티턴");
  });
  it("알 수 없는 인자 거부 / 값 누락 거부", () => {
    expect(parseChatArgs(["--bogus"]).ok).toBe(false);
    expect(parseChatArgs(["--system"]).ok).toBe(false); // 값 누락
  });
});

describe("upsertEnvLine", () => {
  it("신규 = 단일 라인 + trailing newline", () => {
    expect(upsertEnvLine("", "ANTHROPIC_API_KEY", "sk-1")).toBe("ANTHROPIC_API_KEY=sk-1\n");
  });
  it("기존 key 교체 + 타 key·주석 보존", () => {
    const before = "# creds\nANTHROPIC_API_KEY=old\nOPENAI_API_KEY=keep\n";
    const after = upsertEnvLine(before, "ANTHROPIC_API_KEY", "new");
    expect(after).toContain("# creds");
    expect(after).toContain("OPENAI_API_KEY=keep");
    expect(after).toContain("ANTHROPIC_API_KEY=new");
    expect(after).not.toContain("ANTHROPIC_API_KEY=old");
    expect(after.endsWith("\n")).toBe(true);
    expect(after.match(/ANTHROPIC_API_KEY=/g)?.length).toBe(1); // 중복 없음
  });
});

describe("chooseProviderConfig", () => {
  const noEnv = () => undefined;
  it("flag — 기본 모델 + env api 키 주입", () => {
    const r = chooseProviderConfig({ argProvider: "anthropic", envKey: (n) => (n === "ANTHROPIC_API_KEY" ? "sk-ok" : undefined) });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.config).toMatchObject({ provider: "anthropic", model: PROVIDER_DEFAULT_MODEL.anthropic, apiKey: "sk-ok" }); expect(r.source).toBe("flag"); }
  });
  it("flag — 기본 모델 없는 provider 는 --model 필수", () => {
    const r = chooseProviderConfig({ argProvider: "openai", envKey: noEnv });
    expect(r.ok).toBe(false);
    const r2 = chooseProviderConfig({ argProvider: "openai", argModel: "gpt-x", envKey: noEnv });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.config).toMatchObject({ provider: "openai", model: "gpt-x" });
  });
  it("naia-settings defaultConfig 우선(2순위) + --model override", () => {
    const dc = { provider: "glm", model: "glm-4", apiKey: "from-settings" } as const;
    const r = chooseProviderConfig({ defaultConfig: dc, envKey: noEnv });
    expect(r.ok && r.source).toBe("naia-settings");
    if (r.ok) expect(r.config).toMatchObject({ provider: "glm", model: "glm-4", apiKey: "from-settings" });
    const r2 = chooseProviderConfig({ defaultConfig: dc, argModel: "glm-5", envKey: noEnv });
    if (r2.ok) expect(r2.config.model).toBe("glm-5");
  });
  it("자동감지(3순위) — precedence anthropic > openai", () => {
    const r = chooseProviderConfig({ envKey: (n) => (n === "ANTHROPIC_API_KEY" ? "a" : n === "OPENAI_API_KEY" ? "o" : undefined) });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.config.provider).toBe("anthropic"); expect(r.source).toContain("auto"); }
  });
  it("아무 설정 없음 = honest error", () => {
    expect(chooseProviderConfig({ envKey: noEnv }).ok).toBe(false);
  });
});

describe("apiKeyEnvFor", () => {
  it("provider → env 이름(미지=null)", () => {
    expect(apiKeyEnvFor("anthropic")).toBe(PROVIDER_API_KEY_ENV.anthropic);
    expect(apiKeyEnvFor("naia")).toBe("NAIA_API_KEY");
    expect(apiKeyEnvFor("nope")).toBeNull();
  });
});

// ── 멀티턴 REPL 컨트롤러 ──
function harness() {
  const writes: string[] = [];
  let prompts = 0;
  const requests: AgentRequest[] = [];
  const repl = makeReplConversation({
    io: { write: (s) => writes.push(s), prompt: () => { prompts++; } },
    newRequestId: (() => { let i = 0; return () => `r${++i}`; })(),
  });
  repl.ingress.onRequest((req) => requests.push(req)); // wireAgentUC1.start() 모사
  const emit = (e: AgentEmit, reqId?: string) => repl.egress.emit(reqId ?? (requests[requests.length - 1] as ChatRequest).requestId, e);
  return { repl, writes, requests, get prompts() { return prompts; }, emit };
}

describe("makeReplConversation — 멀티턴 history + emit", () => {
  it("턴1: submit → ChatRequest(누적 messages) 방출, text→write, finish→assistant history+reprompt", () => {
    const h = harness();
    expect(h.repl.submit("안녕")).toBe(true);
    expect(h.requests).toHaveLength(1);
    const req1 = h.requests[0] as ChatRequest;
    expect(req1.kind).toBe("chat");
    expect(req1.messages.map((m) => [m.role, m.content])).toEqual([["user", "안녕"]]);
    expect(h.repl.isBusy()).toBe(true);
    h.emit({ kind: "text", text: "반가워" });
    h.emit({ kind: "text", text: "요" });
    h.emit({ kind: "finish" });
    expect(h.writes.join("")).toContain("반가워");
    expect(h.repl.isBusy()).toBe(false);
    expect(h.repl.history.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("턴2: 이전 user+assistant 가 messages 에 누적(맥락 유지)", () => {
    const h = harness();
    h.repl.submit("내 이름은 루크");
    h.emit({ kind: "text", text: "알겠어요 루크" });
    h.emit({ kind: "finish" });
    h.repl.submit("내 이름이 뭐였지?");
    const req2 = h.requests[1] as ChatRequest;
    expect(req2.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(req2.messages[0].content).toBe("내 이름은 루크");
    expect(req2.messages[2].content).toBe("내 이름이 뭐였지?");
  });

  it("busy 가드: 턴 진행 중 submit = false(드롭)", () => {
    const h = harness();
    h.repl.submit("첫 질문");
    expect(h.repl.submit("끼어들기")).toBe(false);
    expect(h.requests).toHaveLength(1);
  });

  it("error 격리: 턴만 실패하고 루프 생존(다음 submit OK)", () => {
    const h = harness();
    h.repl.submit("질문");
    h.emit({ kind: "error", message: "provider 터짐" });
    expect(h.repl.isBusy()).toBe(false);
    expect(h.writes.join("")).toContain("오류");
    expect(h.repl.submit("다시")).toBe(true); // 루프 생존
  });

  it("cancel: CancelRequest 전송 + 즉시 비busy(부분응답 보존)", () => {
    const h = harness();
    h.repl.submit("긴 질문");
    h.emit({ kind: "text", text: "부분..." });
    const id = h.repl.cancel();
    expect(id).toBe("r1");
    expect(h.requests[1]).toMatchObject({ kind: "cancel", requestId: "r1" });
    expect(h.repl.isBusy()).toBe(false);
  });

  it("requestId 불일치 emit 무시(취소된 잔류 스트림)", () => {
    const h = harness();
    h.repl.submit("질문");
    h.emit({ kind: "finish" });               // r1 종료
    const before = h.writes.length;
    h.emit({ kind: "text", text: "유령" }, "r1"); // 종료된 r1 으로 늦게 도착 → 무시
    expect(h.writes.length).toBe(before);
  });
});
