# naia-agent ↔ naia-memory 연결 spec

> **언어**: [English](../../../docs/naia-memory-wire.md) · 한국어 (이 파일)
> **상태**: 라이브 (`--memory` 플래그 Slice 3-XR-C-mem 에서 출시, Group A3 + F2 가 cross-process 회상 LIVE 검증).
> **상위**: [`vision-statement.md`](vision-statement.md) §4b (페르소나 분리), [`memory-provider-audit.md`](memory-provider-audit.md) (façade 감사).

---

## 1. 책임 분리 (사용자 directive 2026-04-26, 2026-05-08 재확인)

> "기억을 불러오거나 선택하는 모듈은 naia-memory에서 해야 한다"

| 책임 | 위치 |
|---|---|
| **MemoryProvider interface 정의** | naia-agent (`packages/types/src/memory.ts`) |
| **기억 저장 (encode)** | **naia-memory** (`LocalAdapter` / Mem0 / Qdrant adapter) |
| **기억 검색 (recall) + 랭킹 + decay + importance gating** | **naia-memory** |
| **압축 (compact)** | **naia-memory** (`CompactableCapable` impl) |
| **`LiteMemoryProvider` (SQLite + embedding, 2026-05-15 출시)** | **naia-memory** 패키지 (CLI 사용 위해 naia-agent 가 re-export) |
| **interface 호출 + 결과 inject** | naia-agent (CLI `--memory` 플래그, 서비스 모드는 host inject) |

→ naia-agent 는 검색 로직을 가지지 않는다. `provider.recall(opts)` 호출 + 결과를 `extraSystemPrompt` 에 inject (또는 CLI 메모리 모드의 경우 `<recall>` 루프 페르소나 빌드).

---

## 2. 의존 wiring (현재 = 로컬 `file:` dep)

```json
// naia-agent/package.json (devDependencies)
"@nextain/naia-memory": "file:../naia-memory"
```

**npm publish 불요** — alpha-adk monorepo 안에서 `file:` 의존이 자동 link.

| 환경 | 상태 |
|---|:---:|
| alpha-adk 안 (로컬 dev) | OK — 검증 완료 (354 PASS, 전체 suite + Group A3 / F2 LIVE 메모리 회상) |
| 외부 사용자 / CI | NOT YET — naia-memory 디렉토리 부재 (npm publish 선행 필요) |

**publish 시점**:
- naia-memory 성능 테스트 / 안정화 후
- 외부 배포 필요 시 (지금은 미필요)
- 권한: 사용자 본인 npm 계정

publish 후엔 `"@nextain/naia-memory": "^0.x.y"` 로 변경.

---

## 3. wire 패턴 (host = alpha-adk 또는 다른 host)

### 3.1 CLI 모드 (`--memory` 플래그, 2026-05-15 출시)

bin 이 `buildCliMemory(args)` + `LiteMemoryProvider` 로 자체 빌드. 사용자는 `--memory` 만 추가:

```bash
pnpm naia-agent --no-tools --memory "기억해줘: 내 강아지 이름은 코코야."
pnpm naia-agent --no-tools --memory "내 강아지 이름이 뭐였지?"
# → "코코" (Group A3 / F2 가 cross-process 회상 검증)
```

저장 경로: 기본은 사용자 홈의 `.naia-agent/memory/` 디렉토리 아래 `cli.sqlite` 파일. `NAIA_AGENT_MEMORY_DB` 환경변수로 override.

### 3.2 서비스 모드 / host wire (manifest `memory.binding: "alpha-memory"`)

```typescript
import { Agent } from "@nextain/agent-core";
import { LocalAdapter, MemorySystem } from "@nextain/naia-memory";

// 1. naia-memory 인스턴스 (host 가 path 결정)
const adkRoot = process.env["ADK_ROOT"] ?? process.cwd();
const memorySystem = new MemorySystem({
  adapter: new LocalAdapter({
    storagePath: path.join(adkRoot, "data/memory"),  // naia-adk 컨벤션
  }),
});

// 2. MemoryProvider 로 wrap (examples/naia-memory-host.ts 참고)
const provider: MemoryProvider = makeNaiaMemoryProvider(memorySystem);

// 3. naia-agent 에 inject
const host: HostContext = { llm, memory: provider, ... };
const agent = new Agent(host, ...);

// 4. supervisor 가 sub-agent 에 보내기 전 recall + inject
const hits = await provider.recall({
  query: userPrompt,
  topK: 5,
  minStrength: 0.6,
});
const memoryContext = hits.map((h) => h.content).join("\n");
const taskSpec = {
  prompt: userPrompt,
  workdir,
  extraSystemPrompt: `[기억]\n${memoryContext}\n\n[페르소나]\n${naiaAdkPersona}`,
};

// 5. assistant 응답을 memory 에 encode
await provider.encode({
  content: assistantResponse,
  role: "assistant",
  context: { sessionId },
});
```

---

## 4. naia-agent 가 절대 하지 않는 것

- (NO) vector search / cosine similarity
- (NO) memory importance scoring
- (NO) Ebbinghaus decay
- (NO) knowledge graph
- (NO) storage backend 직접 import

→ 모두 naia-memory 책임. naia-agent 는 **interface 호출 + 결과 inject** 만.

---

## 5. 디렉토리 vs 패키지명

| | 값 |
|---|---|
| **GitHub repo** | `nextain/naia-memory` (`alpha-memory` 에서 rename, 4-repo migration 2026-04-26) |
| **submodule 디렉토리** | `projects/naia-memory/` |
| **npm 패키지명** | **`@nextain/naia-memory`** |
| **import** | `import { ... } from "@nextain/naia-memory"` |

디렉토리 rename 완료, workspace 에 `alpha-memory` legacy 디렉토리 없음.

---

## 6. 출시된 기능 (원래 Phase 3 plan 대비)

원 spec 은 "Phase 3 wire (future)" 라고 표기. 2026-05-15 (Slice 3-XR-C-mem) 시점에 다음이 출시됨:

- DONE — CLI `--memory` 플래그 (`LiteMemoryProvider`).
- DONE — `<recall>` 마커 프로토콜이 `MEMORY_PERSONA` 에 내장 (`--memory` default).
- DONE — Cross-process 회상 LIVE 검증 (Group A3 + F2, Slice 3-XR-G + 3-XR-I).
- DONE — Agent loop `stripRecallResidue` sanitizer (#2 leak fix, Slice 3-XR-F).
- DONE — 서비스 모드 binding (`memory.binding: "alpha-memory"`) manifest.

### 아직 로드맵에 남은 것

- `naia-adk` 가 `getMemoryStoragePath(adkRoot)` 컨벤션 헬퍼 export.
- Supervisor 모드 `recall → extraSystemPrompt` 자동 inject (Phase1Supervisor 는 현재 host-driven; `MemoryProvider` 인식하는 supervisor 로 lift = 다음 단계).
- 세션별 encode/decay cadence 튜닝.

---

## 7. Cross-refs

- `docs/memory-provider-audit.md` — interface 계약 + capabilities.
- `docs/vision-statement.md` — 페르소나 vs memory layer 분리.
- Slice 3-XR-C-mem (2026-05-15) — `--memory` + recall 프로토콜 첫 출시.
- Slice 3-XR-F / 3-XR-G — 블랙박스 시나리오 (S8 SQLite probe, A3 cross-process recall, F2 페르소나 + memory 합성).
