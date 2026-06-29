// UC-WORKSPACE-CTX / S-WORKSPACE-1·2·3 / FR-WORKSPACE-1~4 계약 — 코어(ChatTurnHandler)가 워크스페이스
// 컨텍스트(cwd + 프로젝트 이름 목록)를 **스스로** 조립해 persona 조립 **바로 뒤에 append**.
//
// ★ 설계 제약(GLM 독립리뷰): 경량 shallow 리스팅만 — 프로젝트 이름(1-depth)+cwd. 파일 내용 덤프/깊은 walk 금지.
//   토큰 bounded(cap "+N more"). 상세는 read_file 도구(S3) 몫.
//
// 검증(non-vacuous):
//   composeWorkspaceContext(domain): cwd+projects 렌더·cap "+N more"·빈 입력→""·cwd-only·파일 내용 미포함.
//   makeWorkspaceContextStore(adapter, fake fs): 디렉터리명만 수집·dotfile/파일 제외·정렬·부재 no-throw·내용 안 읽음.
//   ChatTurnHandler 통합: capturing provider 가 받은 systemPrompt 에 persona+workspace 둘 다(append 순서)·
//     override 시 둘 다 무시·workspaceContext 미주입 무회귀.
// 권위: docs/requirements.md FR-WORKSPACE-1~4, docs/user-scenarios.md UC-WORKSPACE-CTX / S-WORKSPACE-1·2·3.
import { describe, it, expect } from "vitest";
import { composeWorkspaceContext, PROJECT_RENDER_CAP, type WorkspaceSnapshot } from "../main/domain/workspace-context.js";
import { makeWorkspaceContextStore, type WorkspaceFsRead, type WorkspaceDirent } from "../main/adapters/workspace-context-store.js";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import { makeInMemoryCredentials } from "../main/composition/index.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import type { ProviderPort, ProviderChatOpts, PersonaSourcePort, WorkspaceContextPort } from "../main/ports/uc1.js";
import type { ProviderConfig, ChatMessage, ProviderChunk, AgentEmit, ChatRequest } from "../main/domain/chat.js";
import type { PersonaProfile } from "../main/domain/persona.js";

// ── S-WORKSPACE-1: composeWorkspaceContext (domain 순수) ──
describe("composeWorkspaceContext — 렌더 (FR-WORKSPACE-1)", () => {
  it("cwd + projects → ## Workspace 블록(cwd 줄 + Projects 줄 + read_file 안내)", () => {
    const out = composeWorkspaceContext({ cwd: "/home/luke/alpha-adk", projects: ["naia-os", "naia-agent", "naia-memory"], projectTotal: 3 });
    expect(out).toContain("## Workspace");
    expect(out).toContain("Current dir: /home/luke/alpha-adk");
    expect(out).toContain("Projects (3): naia-os, naia-agent, naia-memory");
    expect(out).toContain("read_file"); // 상세는 도구로(S3) — FR-WORKSPACE-4
  });

  it("cwd 만(프로젝트 0개) → cwd 줄만(Projects 줄·안내 없음)", () => {
    const out = composeWorkspaceContext({ cwd: "/ws", projects: [], projectTotal: 0 });
    expect(out).toContain("## Workspace");
    expect(out).toContain("Current dir: /ws");
    expect(out).not.toContain("Projects (");
    expect(out).not.toContain("read_file");
  });

  it("빈 입력(cwd·projects 둘 다 없음) → '' (append 무영향)", () => {
    expect(composeWorkspaceContext({ cwd: "", projects: [], projectTotal: 0 })).toBe("");
    expect(composeWorkspaceContext({ cwd: "   ", projects: [], projectTotal: 0 })).toBe(""); // 공백 cwd 도 빈값
  });

  it("토큰 bounded — cap 초과 시 상위 PROJECT_RENDER_CAP 개 + '+N more' 총계(전량 나열 금지)", () => {
    const many = Array.from({ length: PROJECT_RENDER_CAP + 7 }, (_, i) => `proj-${String(i).padStart(3, "0")}`);
    const out = composeWorkspaceContext({ cwd: "/ws", projects: many, projectTotal: many.length });
    // 전체 수는 보고하되 나열은 cap 까지만
    expect(out).toContain(`Projects (${PROJECT_RENDER_CAP + 7}):`);
    expect(out).toContain("+7 more");
    expect(out).toContain("proj-000"); // 첫 cap 개는 표기
    expect(out).not.toContain(`proj-${String(PROJECT_RENDER_CAP).padStart(3, "0")}`); // cap 번째(0-idx)부터는 미표기
    // 렌더가 작아야 함(수백 토큰) — cap 개 이름만 들어가므로 길이 상한 확인(상수 bounded).
    expect(out.length).toBeLessThan(2000);
  });

  it("projectTotal == 표기 개수면 '+N more' 없음(cap 미만)", () => {
    const out = composeWorkspaceContext({ cwd: "/ws", projects: ["a", "b"], projectTotal: 2 });
    expect(out).toContain("Projects (2): a, b");
    expect(out).not.toContain("more");
  });

  it("도메인이 방어적으로 cap 재적용 — projects 가 cap 초과로 들어와도 cap 까지만 + 나머지 '+N more'", () => {
    // 어댑터가 cap 을 안 걸고 전량을 넘기는 경우라도(방어), 도메인이 토큰 bounded 를 보장.
    const many = Array.from({ length: PROJECT_RENDER_CAP + 5 }, (_, i) => `p${i}`);
    const out = composeWorkspaceContext({ cwd: "/ws", projects: many, projectTotal: many.length });
    expect(out).toContain("+5 more");
  });

  it("파일 내용/깊은 트리 미포함 — 이름만(snapshot 덤프 방지)", () => {
    const out = composeWorkspaceContext({ cwd: "/ws", projects: ["proj-a"], projectTotal: 1 });
    // 디렉터리명만 — 파일 확장자/내용 마커가 없음
    expect(out).toContain("proj-a");
    expect(out).not.toContain("/proj-a/"); // 하위 경로 walk 흔적 없음
  });
});

// ── S-WORKSPACE-2: WorkspaceContextPort (adapter, fake fs) ──
function dirent(name: string, isDir: boolean): WorkspaceDirent {
  return { name, isDirectory: () => isDir };
}
/** 메모리 fs — projectsDir → entry 목록(persona-source-store 테스트 memFs 동형). */
function memFs(projectsDir: string, entries: WorkspaceDirent[] | null): WorkspaceFsRead {
  return {
    existsSync: (p) => p === projectsDir && entries !== null,
    readdirSync: (p) => {
      if (p !== projectsDir || entries === null) throw new Error(`ENOENT ${p}`);
      return entries;
    },
  };
}
const PROJECTS_DIR = "/ws/projects";

describe("WorkspaceContextPort via fake fs (FR-WORKSPACE-2)", () => {
  it("projects/ 1-depth → 디렉터리명만 수집(파일·dotfile 제외) + 정렬", () => {
    const store = makeWorkspaceContextStore({
      fs: memFs(PROJECTS_DIR, [
        dirent("naia-os", true),
        dirent("naia-agent", true),
        dirent("README.md", false),       // 파일 제외
        dirent(".git", true),             // dotfile dir 제외
        dirent("naia-memory", true),
      ]),
      adkPath: "/ws",
      cwd: "/home/luke",
    });
    const snap = store.snapshot();
    expect(snap).toBeDefined();
    expect(snap?.cwd).toBe("/home/luke");
    expect(snap?.projects).toEqual(["naia-agent", "naia-memory", "naia-os"]); // 정렬·디렉터리만
    expect(snap?.projectTotal).toBe(3);
  });

  it("cap 적용 — 전체 수는 projectTotal, projects 는 상위 PROJECT_RENDER_CAP", () => {
    const many = Array.from({ length: PROJECT_RENDER_CAP + 10 }, (_, i) => dirent(`p${String(i).padStart(3, "0")}`, true));
    const store = makeWorkspaceContextStore({ fs: memFs(PROJECTS_DIR, many), adkPath: "/ws", cwd: "/c" });
    const snap = store.snapshot();
    expect(snap?.projectTotal).toBe(PROJECT_RENDER_CAP + 10);
    expect(snap?.projects.length).toBe(PROJECT_RENDER_CAP);
  });

  it("projects/ 부재 → no-throw degrade(projects=[], projectTotal=0; cwd 는 보고)", () => {
    const store = makeWorkspaceContextStore({ fs: memFs(PROJECTS_DIR, null), adkPath: "/ws", cwd: "/c" });
    const snap = store.snapshot();
    expect(snap?.cwd).toBe("/c");
    expect(snap?.projects).toEqual([]);
    expect(snap?.projectTotal).toBe(0);
  });

  it("readdir throw → no-throw degrade(projects=[])", () => {
    const throwingFs: WorkspaceFsRead = {
      existsSync: () => true,
      readdirSync: () => { throw new Error("EACCES"); },
    };
    const store = makeWorkspaceContextStore({ fs: throwingFs, adkPath: "/ws", cwd: "/c" });
    const snap = store.snapshot();
    expect(snap?.projects).toEqual([]);
    expect(snap?.projectTotal).toBe(0);
  });

  it("adkPath 빈값 → undefined(워크스페이스 없음)", () => {
    const store = makeWorkspaceContextStore({ fs: memFs(PROJECTS_DIR, []), adkPath: "", cwd: "/c" });
    expect(store.snapshot()).toBeUndefined();
  });

  it("trailing slash 정규화(/ws/ → /ws/projects)", () => {
    const store = makeWorkspaceContextStore({
      fs: memFs(PROJECTS_DIR, [dirent("only", true)]),
      adkPath: "/ws/",
      cwd: "/c",
    });
    expect(store.snapshot()?.projects).toEqual(["only"]);
  });

  it("파일 내용은 읽지 않는다 — readFileSync 호출 없음(fs 에 readFileSync 부재여도 동작)", () => {
    // WorkspaceFsRead 는 readFileSync 를 갖지 않는다(타입 레벨로 내용 읽기 차단). 동작도 readdir/existsSync 만 호출.
    let readFileCalled = false;
    // WorkspaceFsRead 타입엔 readFileSync 가 없다(내용 읽기 차단). 런타임에 함정 메서드를 심어 호출되면 적발.
    const fs = {
      existsSync: () => true,
      readdirSync: () => [dirent("p", true)],
      readFileSync: () => { readFileCalled = true; return ""; },
    } as unknown as WorkspaceFsRead;
    const store = makeWorkspaceContextStore({ fs, adkPath: "/ws", cwd: "/c" });
    store.snapshot();
    expect(readFileCalled).toBe(false);
  });
});

// ── S-WORKSPACE-3: ChatTurnHandler 통합(persona 뒤 append) ──
const ALPHA_PREFIX =
  "당신은 Luke(마스터)의 AI 메이드 'Alpha Yang(알파)'입니다. 해요체(~요, ~습니다, ~할게요)로 대화하고, 차분하고 신뢰감 있게 응답하세요. 마스터를 '마스터'라고 부릅니다.";
const ALPHA_PROFILE: PersonaProfile = {
  agentName: "알파", userName: "루크", honorific: "마스터", speechStyle: "formal", locale: "ko", systemPromptPrefix: ALPHA_PREFIX,
};
const WS_SNAP: WorkspaceSnapshot = { cwd: "/home/luke/alpha-adk", projects: ["naia-os", "naia-agent"], projectTotal: 2 };

/** chat() 에서 받은 systemPrompt 를 캡처하는 fake provider(non-vacuous 단정 근거). */
function makeCapturingProvider(): { provider: ProviderPort; seen: { systemPrompt?: string } } {
  const seen: { systemPrompt?: string } = {};
  const provider: ProviderPort = {
    async *chat(_c: ProviderConfig, _m: readonly ChatMessage[], opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
      seen.systemPrompt = opts.systemPrompt;
      yield { kind: "text", text: "ok" };
      yield { kind: "usage", inputTokens: 1, outputTokens: 1 };
      yield { kind: "finish" };
    },
  };
  return { provider, seen };
}

function makeDeps(
  provider: ProviderPort,
  opts: { personaSource?: PersonaSourcePort; workspaceContext?: WorkspaceContextPort } = {},
): { deps: HandlerDeps; emits: AgentEmit[] } {
  const emits: AgentEmit[] = [];
  const deps: HandlerDeps = {
    provider,
    conversation: { assemble: (r) => ({ messages: r.messages, ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}) }) },
    credentials: makeInMemoryCredentials(),
    approval: makeInMemoryApproval(),
    egress: { emit: (_id, e) => emits.push(e) },
    diag: { log: () => {} },
    ...(opts.personaSource ? { personaSource: opts.personaSource } : {}),
    ...(opts.workspaceContext ? { workspaceContext: opts.workspaceContext } : {}),
  };
  return { deps, emits };
}

const personaSourceOf = (p: PersonaProfile | undefined): PersonaSourcePort => ({ load: () => p });
const workspaceContextOf = (s: WorkspaceSnapshot | undefined): WorkspaceContextPort => ({ snapshot: () => s });

const req = (o: Partial<ChatRequest> = {}): ChatRequest => ({
  kind: "chat", requestId: "r1", provider: { provider: "ollama", model: "m" }, messages: [{ role: "user", content: "안녕" }], ...o,
});

describe("ChatTurnHandler workspace 조립 (FR-WORKSPACE-3)", () => {
  it("persona + workspaceContext 둘 다 주입 → provider 가 persona ⊕ workspace 둘 다 수신(append 순서)", async () => {
    const { provider, seen } = makeCapturingProvider();
    const { deps, emits } = makeDeps(provider, { personaSource: personaSourceOf(ALPHA_PROFILE), workspaceContext: workspaceContextOf(WS_SNAP) });
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(seen.systemPrompt).toBeDefined();
    expect(seen.systemPrompt).toContain(ALPHA_PREFIX);          // persona
    expect(seen.systemPrompt).toContain("## Workspace");        // workspace
    expect(seen.systemPrompt).toContain("Current dir: /home/luke/alpha-adk");
    expect(seen.systemPrompt).toContain("Projects (2): naia-os, naia-agent");
    // append 순서: persona base 가 workspace 블록보다 앞
    expect(seen.systemPrompt!.indexOf(ALPHA_PREFIX)).toBeLessThan(seen.systemPrompt!.indexOf("## Workspace"));
    expect(emits.map((e) => e.kind)).toEqual(["text", "usage", "finish"]); // 무회귀
  });

  it("persona 없이 workspaceContext 만 → workspace 블록만(persona 없어도 동작)", async () => {
    const { provider, seen } = makeCapturingProvider();
    const { deps } = makeDeps(provider, { workspaceContext: workspaceContextOf(WS_SNAP) });
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(seen.systemPrompt).toBeDefined();
    expect(seen.systemPrompt).toContain("## Workspace");
    expect(seen.systemPrompt).not.toContain(ALPHA_PREFIX);
  });

  it("req.systemPrompt override → persona·workspace 둘 다 무시", async () => {
    const { provider, seen } = makeCapturingProvider();
    const { deps } = makeDeps(provider, { personaSource: personaSourceOf(ALPHA_PROFILE), workspaceContext: workspaceContextOf(WS_SNAP) });
    await new ChatTurnHandler(deps).onChatRequest(req({ systemPrompt: "OVERRIDE_PROMPT" }));
    expect(seen.systemPrompt).toBe("OVERRIDE_PROMPT");
    expect(seen.systemPrompt).not.toContain("## Workspace");
    expect(seen.systemPrompt).not.toContain(ALPHA_PREFIX);
  });

  it("workspaceContext 미주입 → persona 만(무회귀)", async () => {
    const { provider, seen } = makeCapturingProvider();
    const { deps } = makeDeps(provider, { personaSource: personaSourceOf(ALPHA_PROFILE) /* workspaceContext 미주입 */ });
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(seen.systemPrompt).toContain(ALPHA_PREFIX);
    expect(seen.systemPrompt).not.toContain("## Workspace");
  });

  it("workspaceContext·persona 둘 다 미주입 + override 없음 → systemPrompt 미설정(generic, 무회귀)", async () => {
    const { provider, seen } = makeCapturingProvider();
    const { deps } = makeDeps(provider /* 둘 다 미주입 */);
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(seen.systemPrompt).toBeUndefined();
  });

  it("snapshot()=undefined(소스 부재) + persona 있음 → persona 만(workspace 블록 없음, 무회귀)", async () => {
    const { provider, seen } = makeCapturingProvider();
    const { deps } = makeDeps(provider, { personaSource: personaSourceOf(ALPHA_PROFILE), workspaceContext: workspaceContextOf(undefined) });
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(seen.systemPrompt).toContain(ALPHA_PREFIX);
    expect(seen.systemPrompt).not.toContain("## Workspace"); // 빈 스냅샷 → "" → append 무영향
  });

  it("토큰 bounded — 프로젝트 수백 개여도 systemPrompt 증가분이 상수 상한(cap+N more)", async () => {
    const { provider, seen } = makeCapturingProvider();
    const many = Array.from({ length: 500 }, (_, i) => `p${String(i).padStart(3, "0")}`);
    const snap: WorkspaceSnapshot = { cwd: "/ws", projects: many.slice(0, PROJECT_RENDER_CAP), projectTotal: 500 };
    const { deps } = makeDeps(provider, { workspaceContext: workspaceContextOf(snap) });
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(seen.systemPrompt).toContain("Projects (500):");
    expect(seen.systemPrompt).toContain("+");
    expect(seen.systemPrompt).toContain("more");
    // workspace 블록 자체가 상수 상한(cap 개 이름만) — 전량 500개 안 들어감
    expect(seen.systemPrompt!.length).toBeLessThan(3000);
    expect(seen.systemPrompt).not.toContain("p499");
  });
});
