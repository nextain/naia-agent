import { describe, expect, it } from "vitest";
import {
  DEFAULT_SURFACING_THRESHOLD,
  SURFACING_THRESHOLD_LEVELS,
  SURFACING_THRESHOLD_MAX_ITEMS,
  buildMemoryCandidates,
  decideSurfacing,
  isTrivialMemoryText,
  resolveSurfacingThreshold,
  selectRecallByThreshold,
  thresholdJudge,
} from "../main/domain/surfacing.js";
import { formatRecalledMemory, maskSecretShapes, type RecalledMemory } from "../main/domain/memory.js";
import type { EffectiveLlmConfig } from "../main/domain/llm-roles.js";

describe("memory surfacing threshold & policy contract tests (FR-MEM-23/24/25)", () => {
  describe("resolveSurfacingThreshold", () => {
    it("resolves named levels correctly", () => {
      expect(resolveSurfacingThreshold("less")).toBe(0.88);
      expect(resolveSurfacingThreshold("normal")).toBe(0.86);
      expect(resolveSurfacingThreshold("more")).toBe(0.84);
      expect(DEFAULT_SURFACING_THRESHOLD).toBe(0.86);
      expect(SURFACING_THRESHOLD_LEVELS).toEqual({ less: 0.88, normal: 0.86, more: 0.84 });
      expect(SURFACING_THRESHOLD_MAX_ITEMS).toBe(3);
    });

    it("respects valid numeric override and numeric string override in bounds 0.8..0.95", () => {
      expect(resolveSurfacingThreshold("normal", 0.91)).toBe(0.91);
      expect(resolveSurfacingThreshold("less", 0.82)).toBe(0.82);
      expect(resolveSurfacingThreshold("normal", "0.87")).toBe(0.87);
    });

    it("rejects out of bounds override (0, '0', 1, 0.5) and falls back to level or default", () => {
      expect(resolveSurfacingThreshold("normal", 0)).toBe(0.86);
      expect(resolveSurfacingThreshold("normal", "0")).toBe(0.86);
      expect(resolveSurfacingThreshold("normal", 1)).toBe(0.86);
      expect(resolveSurfacingThreshold("normal", 0.5)).toBe(0.86);
      expect(resolveSurfacingThreshold("less", 0.5)).toBe(0.88);
      expect(resolveSurfacingThreshold("more", 1.5)).toBe(0.84);
      expect(resolveSurfacingThreshold("normal", -0.5)).toBe(0.86);
      expect(resolveSurfacingThreshold("normal", "")).toBe(0.86);
    });

    it("falls back to default on invalid level or non-finite override", () => {
      expect(resolveSurfacingThreshold("unknown")).toBe(0.86);
      expect(resolveSurfacingThreshold(undefined)).toBe(0.86);
      expect(resolveSurfacingThreshold(null, NaN)).toBe(0.86);
      expect(resolveSurfacingThreshold(null, Infinity)).toBe(0.86);
    });
  });

  describe("isTrivialMemoryText", () => {
    it("marks empty or text matching query as trivial", () => {
      expect(isTrivialMemoryText("", "something")).toBe(true);
      expect(isTrivialMemoryText("hello world", "Hello, World!")).toBe(true);
      expect(isTrivialMemoryText("  루크  대표님  ", "루크 대표님")).toBe(true);
    });

    it("marks texts shorter than 6 normalized characters as trivial", () => {
      expect(isTrivialMemoryText("OK", "different")).toBe(true);
      expect(isTrivialMemoryText("짧음", "different")).toBe(true);
      expect(isTrivialMemoryText("a b c", "different")).toBe(true);
    });

    it("marks single tokens and identifier-shaped strings as trivial", () => {
      expect(isTrivialMemoryText("SETTINGS_415_MEMORY_OK", "different")).toBe(true);
      expect(isTrivialMemoryText("단일단어", "different")).toBe(true);
      expect(isTrivialMemoryText("identifier_only", "different")).toBe(true);
    });

    it("marks meaningful multi-token sentences as non-trivial", () => {
      expect(isTrivialMemoryText("루크는 고양이를 좋아한다", "오늘 날씨 어때?")).toBe(false);
      expect(isTrivialMemoryText("프로젝트 A는 9월 마감이다", "어떤 프로젝트가 있지?")).toBe(false);
      expect(isTrivialMemoryText("The database server was migrated yesterday", "status check")).toBe(false);
    });
  });

  describe("thresholdJudge", () => {
    const policy = { level: "normal" as const, threshold: 0.86, maxItems: 3 };

    it("fails closed on missing or non-finite scores", () => {
      const items = [
        { text: "유효한 문장입니다 A", score: undefined },
        { text: "유효한 문장입니다 B", score: NaN },
        { text: "유효한 문장입니다 C", score: Infinity },
      ];
      const result = thresholdJudge(items, "질문", policy);
      expect(result.kept).toHaveLength(0);
      expect(result.stats.missingScore).toBe(3);
      expect(result.stats.candidates).toBe(3);
    });

    it("filters trivial items and scores below threshold with nearMissScores and keptScores", () => {
      const items = [
        { text: "SETTINGS_415_MEMORY_OK", score: 0.95 }, // trivial
        { text: "유효한 문장입니다 A", score: 0.8246 },     // below threshold (0.8246 < 0.86)
        { text: "유효한 문장입니다 B", score: 0.8912 },     // keep
        { text: "유효한 문장입니다 C", score: 0.9138 },     // keep
        { text: "유효한 문장입니다 D", score: 0.8491 },     // below threshold
      ];
      const result = thresholdJudge(items, "질문", policy);
      expect(result.kept).toHaveLength(2);
      expect(result.kept[0].text).toBe("유효한 문장입니다 C"); // sorted descending
      expect(result.kept[1].text).toBe("유효한 문장입니다 B");
      expect(result.stats.threshold).toBe(0.86);
      expect(result.stats.candidates).toBe(5);
      expect(result.stats.trivial).toBe(1);
      expect(result.stats.below).toBe(2);
      expect(result.stats.kept).toBe(2);
      expect(result.stats.missingScore).toBe(0);
      expect(result.stats.keptScores).toEqual([0.914, 0.891]);
      expect(result.stats.nearMissScores).toEqual([0.849, 0.825]);
    });

    it("clamps output to policy.maxItems", () => {
      const items = [
        { text: "유효한 문장입니다 A", score: 0.87 },
        { text: "유효한 문장입니다 B", score: 0.88 },
        { text: "유효한 문장입니다 C", score: 0.89 },
        { text: "유효한 문장입니다 D", score: 0.90 },
      ];
      const result = thresholdJudge(items, "질문", policy);
      expect(result.kept).toHaveLength(3);
      expect(result.kept.map((k) => k.score)).toEqual([0.90, 0.89, 0.88]);
      expect(result.stats.keptScores).toEqual([0.9, 0.89, 0.88]);
    });

    it("handles NaN threshold without failing open: falls back to 0.86 and drops lower scores", () => {
      const items = [
        { text: "유효한 문장입니다 A", score: 0.5 }, // must be dropped!
        { text: "유효한 문장입니다 B", score: 0.87 }, // kept
      ];
      const result = thresholdJudge(items, "질문", { threshold: NaN, maxItems: 3 });
      expect(result.stats.threshold).toBe(0.86);
      expect(result.kept).toHaveLength(1);
      expect(result.kept[0].text).toBe("유효한 문장입니다 B");
      expect(result.stats.below).toBe(1);
      expect(result.stats.kept).toBe(1);
    });

    it("handles invalid maxItems (NaN, Infinity, -1) by falling back to SURFACING_THRESHOLD_MAX_ITEMS", () => {
      const items = [
        { text: "유효한 문장입니다 A", score: 0.88 },
        { text: "유효한 문장입니다 B", score: 0.89 },
        { text: "유효한 문장입니다 C", score: 0.90 },
        { text: "유효한 문장입니다 D", score: 0.91 },
      ];
      for (const invalidMax of [NaN, Infinity, -1]) {
        const result = thresholdJudge(items, "질문", { threshold: 0.86, maxItems: invalidMax });
        expect(result.kept).toHaveLength(3);
      }
    });
  });

  describe("selectRecallByThreshold", () => {
    const policy = { level: "normal" as const, threshold: 0.86, maxItems: 3 };

    it("filters facts and episodes together, dropping reflections and counting them in missingScore", () => {
      const mem: RecalledMemory = {
        facts: [
          "과거 사실 A (높은 점수)",
          "과거 사실 B (낮은 점수)",
          "과거 사실 C (점수 없음)",
        ],
        factScores: [0.9214, 0.8123, undefined],
        episodes: [
          { content: "과거 대화 에피소드 D", role: "user", score: 0.9012 },
          { content: "과거 대화 에피소드 E", role: "assistant", score: 0.8734 },
          { content: "SETTINGS_415_TRIVIAL", role: "user", score: 0.99 },
        ],
        reflections: ["학습된 교정 정보 1", "학습된 교정 정보 2"],
      };

      const result = selectRecallByThreshold(mem, "검색 질문", policy);
      expect(result.memory.facts).toEqual(["과거 사실 A (높은 점수)"]);
      expect(result.memory.factScores).toEqual([0.9214]);
      expect(result.memory.episodes).toHaveLength(2);
      expect(result.memory.episodes[0].content).toBe("과거 대화 에피소드 D");
      expect(result.memory.episodes[1].content).toBe("과거 대화 에피소드 E");
      expect(result.memory.reflections).toEqual([]); // reflections ALWAYS dropped!

      // 3 facts + 3 episodes + 2 reflections = 8 candidates
      expect(result.stats.candidates).toBe(8);
      // Fact C (no score) + 2 reflections = 3 missingScore
      expect(result.stats.missingScore).toBe(3);
      expect(result.stats.below).toBe(1); // Fact B
      expect(result.stats.trivial).toBe(1);
      expect(result.stats.kept).toBe(3);
      expect(result.stats.keptScores).toEqual([0.921, 0.901, 0.873]);
      expect(result.stats.nearMissScores).toEqual([0.812]);
    });

    it("drops all facts if factScores length does not match facts length", () => {
      const mem: RecalledMemory = {
        facts: ["사실 1", "사실 2"],
        factScores: [0.95], // mismatched length!
        episodes: [
          { content: "에피소드 정상입니다", role: "user", score: 0.88 },
        ],
      };
      const result = selectRecallByThreshold(mem, "질문", policy);
      expect(result.memory.facts).toHaveLength(0);
      expect(result.memory.episodes).toHaveLength(1);
      expect(result.stats.missingScore).toBe(2); // both facts treated as missing score
    });
  });

  describe("decideSurfacing 3-state", () => {
    const memoryRole: EffectiveLlmConfig = {
      role: "memory",
      provider: { value: "ollama", provenance: "explicit" },
      model: { value: "qwen2.5:3b", provenance: "explicit" },
    };

    it("returns off when disabled", () => {
      const decision = decideSurfacing({
        disabled: true,
        memoryAvailable: true,
        embeddingAvailable: true,
        memoryRole,
        runtimeOk: true,
      });
      expect(decision.mode).toBe("off");
      expect(decision.on).toBe(false);
      expect((decision as { reason?: string }).reason).toBe("disabled");
    });

    it("returns off when memory is not available", () => {
      const decision = decideSurfacing({
        disabled: false,
        memoryAvailable: false,
        embeddingAvailable: true,
        memoryRole,
        runtimeOk: true,
      });
      expect(decision.mode).toBe("off");
      expect((decision as { reason?: string }).reason).toBe("no-memory");
    });

    it("returns off when embedding is unavailable even if small LLM is configured", () => {
      const decision = decideSurfacing({
        disabled: false,
        memoryAvailable: true,
        embeddingAvailable: false,
        memoryRole,
        runtimeOk: true,
      });
      expect(decision.mode).toBe("off");
      expect((decision as { reason?: string }).reason).toBe("no-embedding");
    });

    it("returns on-threshold when no small LLM role or runtime not ok", () => {
      const noRole = decideSurfacing({
        disabled: false,
        memoryAvailable: true,
        embeddingAvailable: true,
        runtimeOk: true,
      });
      expect(noRole.mode).toBe("on-threshold");
      expect(noRole.on).toBe(false);
      expect((noRole as { reason?: string }).reason).toBe("no-small-llm");

      const notOk = decideSurfacing({
        disabled: false,
        memoryAvailable: true,
        embeddingAvailable: true,
        memoryRole,
        runtimeOk: false,
      });
      expect(notOk.mode).toBe("on-threshold");
      expect((notOk as { reason?: string }).reason).toBe("no-small-llm");
    });

    it("returns on-llm for free/platform providers", () => {
      for (const provider of ["naia", "nextain", "ollama", "vllm"]) {
        const decision = decideSurfacing({
          disabled: false,
          memoryAvailable: true,
          embeddingAvailable: true,
          memoryRole: {
            role: "memory",
            provider: { value: provider, provenance: "explicit" },
            model: { value: "m1", provenance: "explicit" },
          },
          runtimeOk: true,
        });
        expect(decision.mode).toBe("on-llm");
        expect(decision.on).toBe(true);
      }
    });

    it("returns on-llm for explicit non-inherited billed provider", () => {
      const decision = decideSurfacing({
        disabled: false,
        memoryAvailable: true,
        embeddingAvailable: true,
        memoryRole: {
          role: "memory",
          provider: { value: "openai", provenance: "explicit" },
          model: { value: "gpt-4o-mini", provenance: "explicit" },
        },
        runtimeOk: true,
      });
      expect(decision.mode).toBe("on-llm");
      expect(decision.on).toBe(true);
    });

    it("returns on-threshold for inherited billed provider to prevent stealth costs", () => {
      const decision = decideSurfacing({
        disabled: false,
        memoryAvailable: true,
        embeddingAvailable: true,
        memoryRole: {
          role: "memory",
          provider: { value: "openai", provenance: "inherit", inheritedFromRole: "main" },
          model: { value: "gpt-4o", provenance: "inherit", inheritedFromRole: "main" },
        },
        runtimeOk: true,
      });
      expect(decision.mode).toBe("on-threshold");
      expect(decision.on).toBe(false);
      expect((decision as { reason?: string }).reason).toBe("inherited-billed-provider");
    });

    it("returns on-threshold (user-choice) when judge is threshold with a Naia role and runtime ok", () => {
      const decision = decideSurfacing({
        disabled: false,
        memoryAvailable: true,
        embeddingAvailable: true,
        judge: "threshold",
        memoryRole: {
          role: "memory",
          provider: { value: "naia", provenance: "explicit" },
          model: { value: "gemini-3.1-flash-lite", provenance: "explicit" },
        },
        runtimeOk: true,
      });
      expect(decision.mode).toBe("on-threshold");
      expect(decision.on).toBe(false);
      expect((decision as { reason?: string }).reason).toBe("user-choice");
    });

    it("returns off (disabled) when judge is threshold but disabled", () => {
      const decision = decideSurfacing({
        disabled: true,
        memoryAvailable: true,
        embeddingAvailable: true,
        judge: "threshold",
        memoryRole: {
          role: "memory",
          provider: { value: "naia", provenance: "explicit" },
          model: { value: "gemini-3.1-flash-lite", provenance: "explicit" },
        },
        runtimeOk: true,
      });
      expect(decision.mode).toBe("off");
      expect(decision.on).toBe(false);
      expect((decision as { reason?: string }).reason).toBe("disabled");
    });

    it("returns off (no-embedding) when judge is threshold but no embedding", () => {
      const decision = decideSurfacing({
        disabled: false,
        memoryAvailable: true,
        embeddingAvailable: false,
        judge: "threshold",
        memoryRole: {
          role: "memory",
          provider: { value: "naia", provenance: "explicit" },
          model: { value: "gemini-3.1-flash-lite", provenance: "explicit" },
        },
        runtimeOk: true,
      });
      expect(decision.mode).toBe("off");
      expect(decision.on).toBe(false);
      expect((decision as { reason?: string }).reason).toBe("no-embedding");
    });

    it("keeps unchanged results when judge is 'llm' or absent", () => {
      const naiaRole: EffectiveLlmConfig = {
        role: "memory",
        provider: { value: "naia", provenance: "explicit" },
        model: { value: "gemini-3.1-flash-lite", provenance: "explicit" },
      };
      const withJudgeLlm = decideSurfacing({
        disabled: false,
        memoryAvailable: true,
        embeddingAvailable: true,
        judge: "llm",
        memoryRole: naiaRole,
        runtimeOk: true,
      });
      expect(withJudgeLlm.mode).toBe("on-llm");
      expect(withJudgeLlm.on).toBe(true);

      const withJudgeAbsent = decideSurfacing({
        disabled: false,
        memoryAvailable: true,
        embeddingAvailable: true,
        memoryRole: naiaRole,
        runtimeOk: true,
      });
      expect(withJudgeAbsent.mode).toBe("on-llm");
      expect(withJudgeAbsent.on).toBe(true);
    });
  });

  describe("maskSecretShapes", () => {
    it("redacts labeled secrets including 'password is: ...'", () => {
      expect(maskSecretShapes("password: mySuperSecret123")).toBe("password: ⟦redacted⟧");
      expect(maskSecretShapes("비밀번호는 secret_pass_456")).toBe("비밀번호는 ⟦redacted⟧");
      expect(maskSecretShapes("api_key = abcdef123456")).toBe("api_key = ⟦redacted⟧");
      expect(maskSecretShapes("password is: hunter22")).toBe("password is: ⟦redacted⟧");
      expect(maskSecretShapes("password is hunter22")).toBe("password is ⟦redacted⟧");
    });

    it("redacts well-known API token patterns and JWTs", () => {
      expect(maskSecretShapes("sk-proj-1234567890abcdefghijklmn")).toBe("⟦redacted⟧");
      expect(maskSecretShapes("AKIAIOSFODNN7EXAMPLE")).toBe("⟦redacted⟧");
      expect(maskSecretShapes("ghp_12345678901234567890")).toBe("⟦redacted⟧");
      expect(maskSecretShapes("xoxb-1234567890-abcdef")).toBe("⟦redacted⟧");
      expect(maskSecretShapes("Bearer my-secret-token-12345678")).toBe("Bearer ⟦redacted⟧");
      expect(
        maskSecretShapes(
          "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        ),
      ).toBe("⟦redacted⟧");
    });

    it("redacts long hex strings (>= 32 chars)", () => {
      const hex = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab34";
      expect(maskSecretShapes(`hash is ${hex}`)).toBe("hash is ⟦redacted⟧");
    });

    it("redacts long base64 strings containing mixed case and digits without breaking normal text", () => {
      const b64 = "aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA";
      expect(maskSecretShapes(`key: ${b64}`)).toContain("⟦redacted⟧");
      // normal word should not be redacted
      expect(maskSecretShapes("thisisaverylongunbrokenwordwithoutmixedcasesorhex")).toBe(
        "thisisaverylongunbrokenwordwithoutmixedcasesorhex",
      );
    });

    it("handles non-string inputs safely without throwing", () => {
      expect(maskSecretShapes(undefined as unknown as string)).toBe("");
      expect(maskSecretShapes(null as unknown as string)).toBe("");
    });

    it("formatRecalledMemory masks secrets before clip: 490 filler chars followed by key never produces substring longer than 6 chars", () => {
      const key = "sk-proj-ABCdef1234567890XYZabc";
      const text = "가".repeat(490) + key;
      const mem: RecalledMemory = {
        facts: [text],
        episodes: [{ content: text, role: "user" }],
        reflections: [text],
      };
      const formatted = formatRecalledMemory(mem, { maxItemChars: 500 });
      for (let i = 0; i <= key.length - 7; i++) {
        expect(formatted).not.toContain(key.slice(i, i + 7));
      }
      expect(formatted).not.toContain("ABCdef");
      expect(formatted).not.toContain("567890XYZ");
      expect(formatted).toContain("⟦redacted⟧");
    });

    it("buildMemoryCandidates masks secrets before clip: 490 filler chars followed by key never produces substring longer than 6 chars", () => {
      const key = "sk-proj-ABCdef1234567890XYZabc";
      const text490 = "가".repeat(490) + key;
      const mem490: RecalledMemory = {
        facts: [text490],
        episodes: [{ content: text490, role: "user" }],
      };
      const candidates490 = buildMemoryCandidates(mem490, []);
      expect(candidates490.length).toBeGreaterThan(0);
      const dumped490 = JSON.stringify(candidates490);
      expect(dumped490).not.toContain("ABCdef");
      expect(dumped490).not.toContain("567890XYZ");
      for (let i = 0; i <= key.length - 7; i++) {
        expect(dumped490).not.toContain(key.slice(i, i + 7));
      }

      const text390 = "가".repeat(390) + key;
      const mem390: RecalledMemory = {
        facts: [text390],
        episodes: [{ content: text390, role: "user" }],
      };
      const candidates390 = buildMemoryCandidates(mem390, []);
      expect(candidates390.length).toBeGreaterThan(0);
      const dumped390 = JSON.stringify(candidates390);
      expect(dumped390).not.toContain("ABCdef");
      expect(dumped390).not.toContain("567890XYZ");
      for (let i = 0; i <= key.length - 7; i++) {
        expect(dumped390).not.toContain(key.slice(i, i + 7));
      }
      expect(dumped390).toContain("⟦redacted⟧");
    });
  });
});
