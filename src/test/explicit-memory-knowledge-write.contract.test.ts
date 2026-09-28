import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_SAVE_TOOL_NAME,
  MEMORY_SAVE_TOOL_SPEC,
  makeMemorySkillsExecutor,
} from "../main/adapters/memory-skill.js";
import {
  KNOWLEDGE_STORE_TOOL_NAME,
  KNOWLEDGE_STORE_TOOL_SPEC,
  makeKnowledgeSkillsExecutor,
  type KnowledgeBackend,
} from "../main/adapters/knowledge-skill.js";
import {
  storeWorkspaceKnowledge,
} from "../main/adapters/knowledge-compile.js";
import {
  ChatTurnHandler,
  MEMORY_TOOL_POLICY,
  KNOWLEDGE_ROUTING_POLICY,
  buildMemoPolicy,
  type HandlerDeps,
} from "../main/app/chat-turn-handler.js";
import type { ToolSpec, AgentEmit, ChatMessage, ProviderConfig, ProviderChunk } from "../main/domain/chat.js";
import type { MemoryPort } from "../main/ports/memory.js";
import type { ProviderPort, ProviderChatOpts } from "../main/ports/uc1.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import { makeInMemoryCredentials } from "../main/composition/index.js";

describe("UC-154 contract tests — explicit long-term memory & knowledge writing tools", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length) {
      const d = tempDirs.pop()!;
      await rm(d, { recursive: true, force: true });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Acceptance 1: skill_memory_save
  // ──────────────────────────────────────────────────────────────────────────
  describe("skill_memory_save (FR-MEM-19)", () => {
    it("spec exports required properties: name, fact and evidence required", () => {
      expect(MEMORY_SAVE_TOOL_NAME).toBe("skill_memory_save");
      expect(MEMORY_SAVE_TOOL_SPEC.name).toBe("skill_memory_save");
      const p = MEMORY_SAVE_TOOL_SPEC.parameters as { required: string[] };
      expect(p.required).toContain("fact");
      expect(p.required).toContain("evidence");
      expect(MEMORY_SAVE_TOOL_SPEC.description).toContain("성공 응답을 받기 전에는 기억했다고 말하지 마세요");
    });

    it("saves fact and user evidence via MemoryPort.save and returns success", async () => {
      let savedUser = "";
      let savedAssistant = "";
      const memory: MemoryPort = {
        recall: vi.fn(async () => ({ facts: [], episodes: [] })),
        save: vi.fn(async (userText, assistantText) => {
          savedUser = userText;
          savedAssistant = assistantText;
        }),
      };

      const exec = makeMemorySkillsExecutor({ memory });
      const res = await exec.execute({
        id: "call-save-1",
        name: "skill_memory_save",
        args: {
          fact: "사용자는 고양이를 두 마리 키운다",
          evidence: "나 고양이 두 마리 키워",
        },
      }, {});

      expect(res.isError).toBeFalsy();
      expect(savedUser).toBe("나 고양이 두 마리 키워");
      expect(savedAssistant).toBe("사용자는 고양이를 두 마리 키운다");
      const parsed = JSON.parse(res.output);
      expect(parsed.ok).toBe(true);
      expect(parsed.success).toBe(true);
      expect(parsed.fact).toBe("사용자는 고양이를 두 마리 키운다");
      expect(parsed.message).toContain("기억 저장 완료");
    });

    it("returns error on missing or empty fact or evidence", async () => {
      const memory: MemoryPort = {
        recall: vi.fn(),
        save: vi.fn(),
      };
      const exec = makeMemorySkillsExecutor({ memory });

      const resNoArgs = await exec.execute({
        id: "call-save-err-1",
        name: "skill_memory_save",
        args: null,
      }, {});
      expect(resNoArgs.isError).toBe(true);

      const resEmptyFact = await exec.execute({
        id: "call-save-err-2",
        name: "skill_memory_save",
        args: { fact: "   ", evidence: "evidence" },
      }, {});
      expect(resEmptyFact.isError).toBe(true);
      expect(resEmptyFact.output).toContain("fact and evidence must be non-empty strings");

      const resEmptyEv = await exec.execute({
        id: "call-save-err-3",
        name: "skill_memory_save",
        args: { fact: "fact", evidence: "" },
      }, {});
      expect(resEmptyEv.isError).toBe(true);
      expect(resEmptyEv.output).toContain("fact and evidence must be non-empty strings");

      expect(memory.save).not.toHaveBeenCalled();
    });

    it("returns error and does not claim success when MemoryPort.save rejects", async () => {
      const memory: MemoryPort = {
        recall: vi.fn(),
        save: vi.fn(async () => {
          throw new Error("disk quota exceeded");
        }),
      };
      const exec = makeMemorySkillsExecutor({ memory });

      const res = await exec.execute({
        id: "call-save-fail",
        name: "skill_memory_save",
        args: {
          fact: "판교 근무",
          evidence: "판교로 출근해",
        },
      }, {});

      expect(res.isError).toBe(true);
      expect(res.output).toContain("기억 저장 실패: disk quota exceeded");
      expect(res.output).not.toContain("기억 저장 완료");
    });

    it("returns error when memory port does not implement save", async () => {
      const exec = makeMemorySkillsExecutor({});
      const res = await exec.execute({
        id: "call-no-mem",
        name: "skill_memory_save",
        args: { fact: "사실", evidence: "발화" },
      }, {});

      expect(res.isError).toBe(true);
      expect(res.output).toContain("memory save unavailable");
    });

    it("aborts execution when signal is already aborted", async () => {
      const memory: MemoryPort = {
        recall: vi.fn(),
        save: vi.fn(),
      };
      const exec = makeMemorySkillsExecutor({ memory });
      const ac = new AbortController();
      ac.abort();

      await expect(
        exec.execute(
          { id: "call-abort", name: "skill_memory_save", args: { fact: "f", evidence: "e" } },
          { signal: ac.signal },
        ),
      ).rejects.toThrow("aborted");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Acceptance 2: skill_knowledge_store
  // ──────────────────────────────────────────────────────────────────────────
  describe("skill_knowledge_store (FR-KB-9)", () => {
    it("spec exports tool name and required content parameter", () => {
      expect(KNOWLEDGE_STORE_TOOL_NAME).toBe("skill_knowledge_store");
      expect(KNOWLEDGE_STORE_TOOL_SPEC.name).toBe("skill_knowledge_store");
      const p = KNOWLEDGE_STORE_TOOL_SPEC.parameters as { required: string[] };
      expect(p.required).toContain("content");
      expect(KNOWLEDGE_STORE_TOOL_SPEC.description).toContain("knowledge.json 과 naia-settings 를 모델이 직접 고치지 않습니다");
    });

    it("stores knowledge content into registered source and triggers compile", async () => {
      const adk = await mkdtemp(join(tmpdir(), "kstore-adk-"));
      tempDirs.push(adk);
      const docsDir = join(adk, "docs");
      await mkdir(docsDir, { recursive: true });
      await mkdir(join(adk, "naia-settings"), { recursive: true });
      await writeFile(
        join(adk, "naia-settings", "knowledge.json"),
        JSON.stringify({
          version: 1,
          scope: "default",
          sources: [{ path: "docs" }],
        }),
      );

      let compiledAdk = "";
      const fakeCompile = vi.fn(async (targetAdk: string) => {
        compiledAdk = targetAdk;
        return {
          ok: true,
          scope: "default",
          sourceCount: 1,
          cardCount: 3,
          entityCount: 2,
          relationCount: 1,
        };
      });

      const res = await storeWorkspaceKnowledge(
        adk,
        {
          title: "회사 원격근무 정책",
          content: "원격근무는 주 2회까지 자율적으로 신청할 수 있습니다.",
        },
        fakeCompile,
      );

      expect(res.ok).toBe(true);
      expect(res.cardCount).toBe(3);
      expect(res.sourceCount).toBe(1);
      expect(compiledAdk).toBe(adk);

      // Verify file content in docsDir
      expect(res.file).toBeDefined();
      const written = await readFile(res.file!, "utf8");
      expect(written).toContain("# 회사 원격근무 정책");
      expect(written).toContain("원격근무는 주 2회까지 자율적으로 신청할 수 있습니다.");

      // Ensure knowledge.json was NOT modified
      const settingsContent = await readFile(join(adk, "naia-settings", "knowledge.json"), "utf8");
      expect(JSON.parse(settingsContent)).toEqual({
        version: 1,
        scope: "default",
        sources: [{ path: "docs" }],
      });
    });

    it("rejects attempt to write directly to naia-settings or knowledge.json", async () => {
      const adk = await mkdtemp(join(tmpdir(), "kstore-sec-"));
      tempDirs.push(adk);
      await mkdir(join(adk, "naia-settings"), { recursive: true });
      await writeFile(
        join(adk, "naia-settings", "knowledge.json"),
        JSON.stringify({
          version: 1,
          scope: "default",
          sources: [{ path: "naia-settings" }],
        }),
      );

      const fakeCompile = vi.fn();
      const res = await storeWorkspaceKnowledge(
        adk,
        { content: "hacked", title: "hacked" },
        fakeCompile,
      );

      expect(res.ok).toBe(false);
      expect(res.error).toContain("naia-settings 및 knowledge.json 은 직접 수정할 수 없습니다");
      expect(fakeCompile).not.toHaveBeenCalled();
    });

    it("returns error when no source folders are registered", async () => {
      const adk = await mkdtemp(join(tmpdir(), "kstore-empty-"));
      tempDirs.push(adk);
      await mkdir(join(adk, "naia-settings"), { recursive: true });
      await writeFile(
        join(adk, "naia-settings", "knowledge.json"),
        JSON.stringify({ version: 1, scope: "default", sources: [] }),
      );

      const res = await storeWorkspaceKnowledge(adk, { content: "content" });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("등록된 소스 폴더가 없습니다");
    });

    it("returns error when compile fails", async () => {
      const adk = await mkdtemp(join(tmpdir(), "kstore-cfail-"));
      tempDirs.push(adk);
      await mkdir(join(adk, "docs"), { recursive: true });
      await mkdir(join(adk, "naia-settings"), { recursive: true });
      await writeFile(
        join(adk, "naia-settings", "knowledge.json"),
        JSON.stringify({ version: 1, scope: "default", sources: [{ path: "docs" }] }),
      );

      const fakeCompile = vi.fn(async () => ({
        ok: false,
        scope: "default",
        sourceCount: 0,
        cardCount: 0,
        entityCount: 0,
        relationCount: 0,
        error: "syntax error in markdown table",
      }));

      const res = await storeWorkspaceKnowledge(adk, { content: "content" }, fakeCompile);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("syntax error in markdown table");
    });

    it("makeKnowledgeSkillsExecutor exposes skill_knowledge_store when backend.store is provided", async () => {
      const backend: KnowledgeBackend = {
        search: vi.fn(async () => []),
        ask: vi.fn(async () => ({ abstained: true, answer: "", sources: [] })),
        store: vi.fn(async (_opts) => ({
          ok: true,
          file: "/workspace/docs/note.md",
          cardCount: 5,
          sourceCount: 1,
        })),
      };

      const exec = makeKnowledgeSkillsExecutor({ backend });
      const specs = exec.specs();
      expect(specs.map((s) => s.name)).toContain("skill_knowledge_store");

      const res = await exec.execute({
        id: "call-kstore-1",
        name: "skill_knowledge_store",
        args: {
          title: "프로젝트 로드맵",
          content: "Q4 릴리즈 계획",
        },
      }, {});

      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.output);
      expect(parsed.ok).toBe(true);
      expect(parsed.cardCount).toBe(5);
      expect(backend.store).toHaveBeenCalledWith({
        content: "Q4 릴리즈 계획",
        title: "프로젝트 로드맵",
        sourcePath: undefined,
      });
    });

    it("makeKnowledgeSkillsExecutor returns error when store fails", async () => {
      const backend: KnowledgeBackend = {
        search: vi.fn(async () => []),
        ask: vi.fn(async () => ({ abstained: true, answer: "", sources: [] })),
        store: vi.fn(async () => ({
          ok: false,
          error: "컴파일 오류: 토큰 한도 초과",
        })),
      };

      const exec = makeKnowledgeSkillsExecutor({ backend });
      const res = await exec.execute({
        id: "call-kstore-fail",
        name: "skill_knowledge_store",
        args: { content: "huge content" },
      }, {});

      expect(res.isError).toBe(true);
      expect(res.output).toContain("컴파일 오류: 토큰 한도 초과");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Acceptance 3: Routing policy & memo_save restriction
  // ──────────────────────────────────────────────────────────────────────────
  describe("tool routing policy & memo_save restriction", () => {
    it("MEMORY_TOOL_POLICY instructs personal facts -> memory tool and forbids claiming to remember before success", () => {
      expect(MEMORY_TOOL_POLICY).toContain("skill_memory_save");
      expect(MEMORY_TOOL_POLICY).toContain("Never claim to have remembered or saved something before skill_memory_save succeeds");
      expect(MEMORY_TOOL_POLICY).toContain("Personal facts and user preferences belong in long-term memory (skill_memory_save)");
      expect(MEMORY_TOOL_POLICY).toContain("Notes/memos belong in memo_save ONLY when the user explicitly asks for a memo");
    });

    it("KNOWLEDGE_ROUTING_POLICY routes company/project documents to skill_knowledge_store", () => {
      expect(KNOWLEDGE_ROUTING_POLICY).toContain("skill_knowledge_store adds content to the workspace knowledge source");
      expect(KNOWLEDGE_ROUTING_POLICY).toContain("Never use memo_save or skill_memory_save for company/project knowledge");
      expect(KNOWLEDGE_ROUTING_POLICY).toContain("memo_save ONLY when the user explicitly asks for a memo");
    });

    it("buildMemoPolicy strictly enforces memo_save only on explicit memo requests", () => {
      const policyMemOn = buildMemoPolicy(true);
      expect(policyMemOn).toContain("Call memo_save ONLY on an explicit memo request; if the user explicitly asks for a memo, call memo_save.");

      const policyMemOff = buildMemoPolicy(false);
      expect(policyMemOff).toContain("Call memo_save ONLY on an explicit memo request; if the user explicitly asks for a memo, call memo_save.");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Acceptance 4: Automatic memory.save maintains & delivers failure honestly
  // ──────────────────────────────────────────────────────────────────────────
  describe("automatic turn-end memory.save behavior", () => {
    function makeTestHarness(opts: {
      memorySave?: (u: string, a: string) => Promise<void>;
      memoryTimeoutMs?: number;
      specs?: readonly ToolSpec[];
    }) {
      const emits: AgentEmit[] = [];
      const memory: MemoryPort = {
        recall: vi.fn(async () => ({ facts: [], episodes: [] })),
        save: opts.memorySave ? vi.fn(opts.memorySave) : vi.fn(async () => {}),
      };

      const provider: ProviderPort = {
        async *chat(_c: ProviderConfig, _m: readonly ChatMessage[], _o: ProviderChatOpts): AsyncIterable<ProviderChunk> {
          yield { kind: "text", text: "대답 완료." };
          yield { kind: "finish" };
        },
      };

      const deps: HandlerDeps = {
        provider,
        conversation: {
          assemble: (r) => ({
            messages: r.messages,
            ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}),
          }),
        },
        credentials: makeInMemoryCredentials(),
        approval: makeInMemoryApproval(),
        egress: { emit: (_id, e) => emits.push(e) },
        diag: { log: () => {} },
        memory,
        ...(opts.memoryTimeoutMs !== undefined ? { memoryTimeoutMs: opts.memoryTimeoutMs } : {}),
        toolExecutor: opts.specs ? { specs: () => opts.specs!, execute: vi.fn() } : undefined,
      };

      return { deps, memory, emits };
    }

    it("maintains automatic memory.save on successful normal turn", async () => {
      const { deps, memory, emits } = makeTestHarness({});
      const handler = new ChatTurnHandler(deps);

      await handler.onChatRequest({
        kind: "chat",
        requestId: "turn-normal-1",
        provider: { provider: "fake", model: "m" },
        messages: [{ role: "user", content: "오늘 날씨 어때?" }],
      });

      expect(memory.save).toHaveBeenCalledOnce();
      expect(memory.save).toHaveBeenCalledWith("오늘 날씨 어때?", "대답 완료.");
      expect(emits.some((e) => e.kind === "finish")).toBe(true);
      // No failure warnings emitted
      expect(emits.some((e) => e.kind === "logEntry" && e.level === "warn")).toBe(false);
    });

    it("emits warning logEntry when automatic memory.save fails, delivering failure honestly", async () => {
      const { deps, memory, emits } = makeTestHarness({
        memorySave: async () => {
          throw new Error("sqlite database is locked");
        },
      });
      const handler = new ChatTurnHandler(deps);

      await handler.onChatRequest({
        kind: "chat",
        requestId: "turn-fail-1",
        provider: { provider: "fake", model: "m" },
        messages: [{ role: "user", content: "안녕하세요" }],
      });

      expect(memory.save).toHaveBeenCalledOnce();
      const warnEmit = emits.find(
        (e) => e.kind === "logEntry" && e.level === "warn" && e.message.includes("자동 기억 저장 실패"),
      );
      expect(warnEmit).toBeDefined();
      expect((warnEmit as { message: string }).message).toContain("sqlite database is locked");
    });

    it("emits warning logEntry when automatic memory.save times out, delivering timeout honestly", async () => {
      const { deps, memory, emits } = makeTestHarness({
        memoryTimeoutMs: 10,
        memorySave: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      });
      const handler = new ChatTurnHandler(deps);

      await handler.onChatRequest({
        kind: "chat",
        requestId: "turn-timeout-1",
        provider: { provider: "fake", model: "m" },
        messages: [{ role: "user", content: "안녕하세요" }],
      });

      expect(memory.save).toHaveBeenCalledOnce();
      const warnEmit = emits.find(
        (e) => e.kind === "logEntry" && e.level === "warn" && e.message.includes("자동 기억 저장 시간초과"),
      );
      expect(warnEmit).toBeDefined();
    });

    it("excludes skill_memory_save on discord or processing requests", async () => {
      const allSpecs: readonly ToolSpec[] = [
        MEMORY_SAVE_TOOL_SPEC,
        { name: "other_tool", description: "other", parameters: {} },
      ];

      let capturedSystemPrompt: string | undefined;
      let capturedTools: readonly ToolSpec[] = [];

      const provider: ProviderPort = {
        async *chat(_c: ProviderConfig, _m: readonly ChatMessage[], o: ProviderChatOpts): AsyncIterable<ProviderChunk> {
          capturedSystemPrompt = o.systemPrompt;
          capturedTools = o.tools ?? [];
          yield { kind: "finish" };
        },
      };

      const deps: HandlerDeps = {
        provider,
        conversation: {
          assemble: (r) => ({
            messages: r.messages,
            ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}),
          }),
        },
        credentials: makeInMemoryCredentials(),
        approval: makeInMemoryApproval(),
        egress: { emit: () => {} },
        diag: { log: () => {} },
        memory: { recall: vi.fn(), save: vi.fn() },
        toolExecutor: { specs: () => allSpecs, execute: vi.fn() },
      };

      const handler = new ChatTurnHandler(deps);

      // Discord channel request -> persistence forbidden -> skill_memory_save omitted
      await handler.onChatRequest({
        kind: "chat",
        requestId: "discord-req",
        channel: { kind: "discord", bindingId: "b1", guildId: "g1", channelId: "c1", userId: "u1" },
        provider: { provider: "fake", model: "m" },
        messages: [{ role: "user", content: "hi" }],
      });

      expect(capturedTools.map((t) => t.name)).not.toContain("skill_memory_save");
      expect(capturedSystemPrompt).not.toContain(MEMORY_TOOL_POLICY);
    });
  });
});
