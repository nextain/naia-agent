// UC-memory / issue #7 — os 메모리 UI 의 adapter(local/qdrant)·embedding(offline/vllm/ollama/naia)
// 선택이 makeNaiaMemory 런타임에 반영되는지 계약 고정. 이전엔 LocalAdapter+키워드-only 하드코딩이라
// UI 선택이 무시됐음(silent no-op). 여기선 (1) embedding provider 매핑·필수가드, (2) adapter 선택
// fail-closed 가드를 헤르메틱하게 검증한다.
//
// ⚠️ 범위: 실 embed I/O(offline=transformers 모델 다운로드, vllm/naia=원격, qdrant=라이브 서버)는
//   naia-memory 자체 테스트 책임 + 외부 자원 필요 → 이 계약은 *선택/구성 로직*만 결정론적으로 고정한다.
//   OfflineEmbeddingProvider 는 transformers 를 init() 에서 *동적* import 하므로 구성만으론 다운로드 없음.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEmbeddingProvider, buildMemoryFactExtractor, makeNaiaMemory } from "../main/adapters/naia-memory.js";

describe("issue #7 — buildEmbeddingProvider: UI embedding 선택 → EmbeddingProvider 매핑", () => {
  it("none/미지정 = 키워드-only(undefined)", () => {
    expect(buildEmbeddingProvider()).toBeUndefined();
    expect(buildEmbeddingProvider({ provider: "none" })).toBeUndefined();
  });

  it("offline = OfflineEmbeddingProvider, 모델별 dims(기본 384, mpnet 768)", () => {
    const p = buildEmbeddingProvider({ provider: "offline" });
    expect(p?.name).toBe("offline");
    expect(p?.dims).toBe(384); // all-MiniLM-L6-v2 기본
    expect(buildEmbeddingProvider({ provider: "offline", offlineModel: "all-mpnet-base-v2" })?.dims).toBe(768);
    expect(buildEmbeddingProvider({ provider: "offline", offlineModel: "multilingual-e5-large" })?.dims).toBe(1024);
  });

  it("vllm/ollama = OpenAI-compat; baseUrl·model 누락 = fail-closed(throw)", () => {
    const p = buildEmbeddingProvider({
      provider: "vllm",
      baseUrl: "http://localhost:11434",
      model: "nomic-embed-text",
    });
    expect(p?.name).toBe("openai-compat");
    expect(buildEmbeddingProvider({ provider: "ollama", baseUrl: "http://x", model: "m" })?.name).toBe("openai-compat");
    expect(() => buildEmbeddingProvider({ provider: "vllm", model: "x" })).toThrow(/baseUrl/);
    expect(() => buildEmbeddingProvider({ provider: "ollama", baseUrl: "http://x" })).toThrow(/model/);
  });

  it("naia = NaiaGatewayEmbeddingProvider; gatewayUrl·key 누락 = throw", () => {
    const p = buildEmbeddingProvider({ provider: "naia", naiaGatewayUrl: "https://gw", naiaKey: "gw-k" });
    expect(p?.name).toBe("naia-gateway");
    expect(() => buildEmbeddingProvider({ provider: "naia", naiaGatewayUrl: "https://gw" })).toThrow(/naiaKey/);
    expect(() => buildEmbeddingProvider({ provider: "naia", naiaKey: "gw-k" })).toThrow(/naiaGatewayUrl/);
  });
});

describe("issue #7 — makeNaiaMemory: adapter 선택 + fail-closed 가드", () => {
  it("local(기본) — embedding 없이 구성(기존 동작 보존, 키워드-only)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-adapter-local-"));
    try {
      const m = makeNaiaMemory({ project: "p", storePath: join(dir, "s.json"), sessionId: "s1" });
      expect(typeof m.recall).toBe("function");
      expect(typeof m.save).toBe("function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("local + embedding=offline — 구성 성공(provider 주입; 실 embed lazy, 다운로드 없음)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-adapter-emb-"));
    try {
      const m = makeNaiaMemory({
        project: "p",
        storePath: join(dir, "s.json"),
        sessionId: "s1",
        embedding: { provider: "offline" },
      });
      expect(typeof m.recall).toBe("function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("qdrant — embedding 없으면 fail-closed(throw, 키워드-only 불가)", () => {
    expect(() =>
      makeNaiaMemory({
        project: "p",
        adapter: "qdrant",
        qdrantUrl: "http://localhost:6333",
        embedding: { provider: "none" },
      }),
    ).toThrow(/embedding/);
  });

  it("qdrant — qdrantUrl 누락 시 throw", () => {
    expect(() =>
      makeNaiaMemory({
        project: "p",
        adapter: "qdrant",
        embedding: { provider: "offline" },
      }),
    ).toThrow(/qdrantUrl/);
  });
});

describe("issue #7 — buildMemoryFactExtractor: UI LLM 선택 → FactExtractor 매핑", () => {
  it("none/미지정 = 휴리스틱(undefined)", () => {
    expect(buildMemoryFactExtractor()).toBeUndefined();
    expect(buildMemoryFactExtractor({ provider: "none" })).toBeUndefined();
  });

  it("vllm/ollama/naia = FactExtractor(함수); baseUrl·model 누락 = fail-closed(throw)", () => {
    const fe = buildMemoryFactExtractor({ provider: "vllm", baseUrl: "http://localhost:8000", model: "qwen" });
    expect(typeof fe).toBe("function");
    expect(typeof buildMemoryFactExtractor({ provider: "naia", baseUrl: "https://gw", model: "vertexai:gemini" })).toBe("function");
    expect(() => buildMemoryFactExtractor({ provider: "vllm", model: "x" })).toThrow(/baseUrl/);
    expect(() => buildMemoryFactExtractor({ provider: "ollama", baseUrl: "http://x" })).toThrow(/model/);
  });
});

describe("issue #7 후속 — embedding device(gpu/cpu) 선택(naia-embedded 컴퓨트)", () => {
  it("offline + device(gpu/cpu/auto) — 구성 성공(name=offline; 실 device 적용은 transformers init)", () => {
    expect(buildEmbeddingProvider({ provider: "offline", device: "gpu" })?.name).toBe("offline");
    expect(buildEmbeddingProvider({ provider: "offline", device: "cpu" })?.name).toBe("offline");
    expect(buildEmbeddingProvider({ provider: "offline", device: "auto" })?.name).toBe("offline");
  });
});
