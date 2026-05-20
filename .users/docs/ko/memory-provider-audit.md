# MemoryProvider 감사 — naia-memory 매핑

> **언어**: [English](../../../docs/memory-provider-audit.md) · 한국어 (이 파일)

**상태**: CLI 메모리 출고 표면 (Slice 3-XR-C-mem, 3-XR-D recall residue
hygiene, 3-XR-F/G/I cross-process 검증) 을 반영해 2026-05-20 에 갱신.
**출처**: `nextain/naia-memory` (live). `src/memory/index.ts`,
`src/memory/types.ts`, `src/memory/lite-provider.ts`,
`src/memory/adapters/` 의 export 를 직접 검사.
**목표**: 출고된 façade + binding + capability 커버리지, 그리고 남은
로드맵 항목 기록.

## 1. Shipped vs Roadmap (2026-05-20)

### Shipped

- **`LiteMemoryProvider`** — SQLite + 주입형 embedder, `MemoryProvider`
  레퍼런스 구현 (Slice 3-XR-C-mem, 2026-05-15). CLI 의 `--memory` 모드가
  사용. `better-sqlite3` 가 백엔드 (이제 정상 빌드 — `package.json`
  `pnpm.onlyBuiltDependencies` 가 `better-sqlite3`, `esbuild` 포함).
- **`--memory` CLI 플래그** — `pnpm naia-agent --memory "…"` 가
  `NAIA_AGENT_MEMORY_DB` (기본=naia-agent 사용자 설정 루트 하위) 에
  영속 `LiteMemoryProvider` 를 연다. 실패 시 ephemeral `InMemoryMemory`
  로 우아하게 강등 — 메모리 때문에 CLI 가 죽는 일이 절대 없다 (anchor #6).
- **`OpenAICompatEmbeddingProvider` wire-up** — `--memory` 가 `NAIA_EMBED_*`
  에서 embedder 를 구성. CLI 가 embed base URL 을 normalise (trailing
  `/v1` 제거) 하여 균일한 `…/v1` naia-settings baseUrl 이
  `…/v1/v1/embeddings` 로 두 번 붙는 사고를 방지 (root-cause fix — 이전엔
  모든 encode 가 조용히 실패).
- **`<recall>` 마커 프로토콜 + `MEMORY_PERSONA`** — core 에 STRICT
  파서. `--memory` 가 명시적 `--system` 없이 호출되면 빌트인 recall
  프로토콜 페르소나가 자동 주입돼 마커가 실제 발화. 페르소나는 언어
  중립 (general-purpose — Korean output directive 없음).
- **`stripRecallResidue` 새니타이저 (Slice 3-XR-F)** — pure 함수로 export.
  agent strip-path 가 사용. STRICT match/act 는 그대로 (leniency 가 recall
  행동에 도달하지 않음). `recal` 패밀리에만 anchor; 인용된 protocol 문서/
  코드 보존; marker-free 입력은 byte-identical 반환.
- **Cross-process recall LIVE 검증** —
  `packages/cli-app/src/__tests__/integration-scenarios.test.ts` 의
  Group A3 (24G live, Korean) 와 Group F2 (페르소나 + 메모리 합성) 가
  공유 `LiteMemoryProvider` SQLite 를 통해 store-in-process-A /
  recall-in-process-B 를 검증. 같은 불변식을
  `bin-user-scenarios.test.ts` 의 USER S8 / S8-neg 가 미러. R4 + R5
  2-consecutive PASS 확정.
- **Service-mode binding** — `memory.binding: "alpha-memory"` 인
  서비스 manifest 는 `resolveMemoryBinding` 으로 해소. naia-memory 를
  lazy load 하고 서비스별 `services/` 디렉터리 밖 db 경로를 거부 (sandbox).

### Roadmap

- **Supervisor-mode auto-injection** of `recall → extraSystemPrompt` —
  현재 CLI 페르소나는 모델에게 `<recall>` 마커 발화를 가르치는 방식.
  Supervisor 모드 (host-driven 오케스트레이션) 는 모델이 사용자
  메시지를 보기 전에 recall 텍스트를 turn-local system prompt slice 에
  미리 주입해야 한다.
- **Encode / decay 캐던스 튜닝** — `MemorySystem` consolidation +
  Ebbinghaus decay 가 내장 스케줄로 동작. 호스트가 세션 활동에 맞춰
  페이싱할 수 있도록 hook 노출.
- **`naia-adk` `getMemoryStoragePath()` helper** — "이 naia-adk 경로에서
  메모리가 어디 살지" 의 단일 SoT. CLI 와 향후 호스트가 소비해 path
  정책이 consumer 사이에 중복되지 않게 함.

## 2. 현재 naia-memory 표면

### 최상위: `MemorySystem` (orchestrator)

façade 와 관련된 public 메서드:

| 메서드 | 시그니처 | 역할 |
|---|---|---|
| `encode` | `(input: MemoryInput, context?: EncodingContext) → Promise<Episode \| null>` | importance gating 후 episodic store 저장 |
| `recall` | `(query: string, context?: RecallContext) → Promise<Episode[]>` | decay weighting + context 기반 retrieval |
| `consolidate` | `() → Promise<ConsolidationResult>` | episodic → semantic fact 추출 |
| `sessionRecall` | `(text: string, opts?: { topK? }) → Promise<string \| null>` | LLM 주입용 context block 포맷 |
| `close` | `() → Promise<void>` | 리소스 정리 |
| `startConsolidation` | `() → void` | 백그라운드 consolidation 루프 |

### `LiteMemoryProvider` (출고된 레퍼런스 구현)

`LiteMemoryProvider` 는 SQLite-backed `MemoryProvider` 레퍼런스 구현이다.
자체 connection 소유, 주입 embedder 수용, CLI 의 `--memory` 기본 구현.
개인 비서급 footprint 에 맞춰 사이즈됨.

### `MemoryAdapter` (하위 추상화, pluggable backend)

`src/memory/types.ts` 의 인터페이스 시그니처:

- `addEpisode`, `addFact`, `addSkill`, `addReflection`
- `searchEpisodes`, `searchFacts`, `searchSkills`
- `getEpisodesByIds`, update/delete 변형
- `close`

### 보조 타입

- `MemoryInput` — `{ content, role, context?, timestamp? }`
- `Episode` — `id, content, summary, timestamp, importance, encodingContext, consolidated, recallCount, lastAccessed, strength`
- `Fact`, `Skill`, `Reflection`
- `RecallContext` — `project, activeFile, topK, minStrength, deepRecall`
- `ImportanceScore` — `importance × surprise × emotion → utility`
- `BackupCapable` — naia-memory 가 이미 제공하는 capability 인터페이스

### 기존 adapter

- `LocalAdapter` — SQLite + hnswlib
- `QdrantAdapter` — 원격 vector DB
- `Mem0Adapter` — mem0 backend (내부 swap, §5)

### Embedding 추상화

- `EmbeddingProvider` 인터페이스
- 구현체: `OfflineEmbeddingProvider`, `OpenAICompatEmbeddingProvider`,
  `NaiaGatewayEmbeddingProvider`

## 3. `MemoryProvider` façade (`@nextain/agent-types` 용)

최소 표면 — A.5 컨트랙트 (`encode`, `recall`, `consolidate`, `close`)
일치 + naia-memory 매핑:

```typescript
// @nextain/agent-types (zero runtime deps)

export interface MemoryProvider {
  encode(input: MemoryInput): Promise<void>;
  recall(query: string, opts?: RecallOpts): Promise<MemoryHit[]>;
  consolidate(): Promise<void>;
  close(): Promise<void>;
}

export interface MemoryInput {
  content: string;
  role: "user" | "assistant" | "tool";
  context?: Record<string, string>;  // project, activeFile, sessionId, ...
  timestamp?: number;
}

export interface RecallOpts {
  topK?: number;
  minStrength?: number;
  deepRecall?: boolean;          // capability-gated — 미지원 구현체는 우아하게 무시
  context?: Record<string, string>;
}

export interface MemoryHit {
  id: string;
  content: string;
  summary?: string;
  score: number;                  // 구현체 정의 (strength, cosine 등)
  timestamp?: number;
  metadata?: Record<string, unknown>;
}
```

### naia-memory 매핑

| façade 메서드 | naia-memory 호출 | 비고 |
|---|---|---|
| `encode(input)` | `memorySystem.encode(input, input.context)` | importance gating 은 naia-memory 내부 |
| `recall(query, opts)` | `memorySystem.recall(query, opts)` → `Episode[]` → `MemoryHit[]` 매핑 | `Episode.strength` → `MemoryHit.score` |
| `consolidate()` | `memorySystem.consolidate()` | `ConsolidationResult` → `void` 로 drop; 호출자는 log 확인 |
| `close()` | `memorySystem.close()` | 직접 pass-through |

## 4. 옵셔널 Capability 인터페이스 (A.5)

최소 façade 가 아닌, optional capability 에 속하는 naia-memory 기능:

```typescript
export interface BackupCapable {
  backup(): Promise<Uint8Array>;
  restore(data: Uint8Array): Promise<void>;
}

export interface EmbeddingCapable {
  embed(text: string): Promise<number[]>;
}

export interface KnowledgeGraphCapable {
  queryEntities(name: string): Promise<Entity[]>;
  queryRelations(from: string, relation?: string): Promise<Relation[]>;
}

export interface ImportanceCapable {
  scoreImportance(input: MemoryInput): Promise<ImportanceScore>;
}

export interface ReconsolidationCapable {
  findContradictions(factId: string): Promise<Contradiction[]>;
}

export interface TemporalCapable {
  applyDecay(): Promise<void>;
  recallWithHistory(query: string, at?: number): Promise<MemoryHit[]>;
}

export interface SessionRecallCapable {
  sessionRecall(text: string, opts?: { topK?: number }): Promise<string | null>;
}
```

### naia-memory capability 커버리지

| Capability | naia-memory 지원? | 출처 |
|---|:---:|---|
| `BackupCapable` | ✓ | 기존 `BackupCapable` 타입 |
| `EmbeddingCapable` | ✓ | 주입형 `EmbeddingProvider` |
| `KnowledgeGraphCapable` | ✓ | `knowledge-graph.ts` |
| `ImportanceCapable` | ✓ | `importance.ts` |
| `ReconsolidationCapable` | ✓ | `reconsolidation.ts` (`findContradictions`) |
| `TemporalCapable` | ✓ | `decay.ts` (Ebbinghaus) + `deepRecall` |
| `SessionRecallCapable` | ✓ | `sessionRecall()` 메서드 |

naia-memory 가 7개 capability 모두 만족. 다른 구현체 (`mem0`, custom,
in-memory) 는 부분 집합 선택 가능; consumer (`naia-agent/runtime`) 가
사용 전 capability 확인.

## 5. mem0 dual audit

mem0 은 별도 `MemoryProvider` 가 **아니다**. naia-memory 가 내부에
3개 adapter (`LocalAdapter`, `Mem0Adapter`, `QdrantAdapter`) 를 가지고
모두 **내부** `MemoryAdapter` 인터페이스를 구현한다. `MemorySystem` —
orchestrator — 가 단일 `MemoryProvider` façade. 레이어링:

```
MemoryProvider (public façade, @nextain/agent-types)
   └── MemorySystem (naia-memory orchestrator)
        └── MemoryAdapter (Local / Mem0 / Qdrant — backend 선택)
             └── mem0 / SQLite+hnswlib / Qdrant
```

naia-agent consumer 관점에선 naia-memory 가 mem0 를 backend 로 쓰든
말든 **투명하다**. façade 변경 불필요, 7개 capability 도 backend 선택과
무관하게 그대로 적용됨 — naia-memory 상단 레이어에 구현되어 있기 때문.

## 6. Open question (구현 시점으로 deferred)

- adapter 주입 패턴: `naia-agent/runtime` wrapper class vs 직접 peerDep
- 풀 host 시나리오에서 `EmbeddingProvider` 주입 — shell-owned vs
  naia-agent-owned (현재 CLI 는 naia-agent-owned)
- `MemoryHit.score` 에서 `Episode.strength` vs cosine similarity 의미
- `ConsolidationResult` 로깅 채널 (provider Logger? host?)
- CLI 외 실패 모드: `ErrorEvent` 표면 vs close + 재구축?
- mem0 전용 튜닝 (LLM-based dedup, KO 처리) — adapter 레이어 사안.
  façade 사안 아님

## 7. 레퍼런스

- `CHANGELOG.md` — Slice 3-XR-C-mem (CLI 에 메모리 wire),
  Slice 3-XR-D (recall residue hygiene),
  Slice 3-XR-F (`stripRecallResidue` + USER S8 cross-process 불변식),
  Slice 3-XR-G/I (Group A3 + F2 live recall 검증).
- `bin/naia-agent.ts` — `--memory` wire-up, `MEMORY_PERSONA`,
  `buildCliMemory`, `resolveMemoryBinding("alpha-memory")`.
- `packages/cli-app/src/__tests__/integration-scenarios.test.ts`
  Group A3 / F2.
- `packages/cli-app/src/__tests__/bin-user-scenarios.test.ts` S8 / S8-neg.
- Migration plan: `alpha-adk/.agents/progress/naia-4repo-migration-plan.md`
  §A.5, Phase 0 S1 / S1b.
- naia-memory source: `nextain/naia-memory` main.
