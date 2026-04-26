# naia-agent ↔ naia-memory 연결 spec

> **status**: Phase 2 docs (Phase 3 정식 wire 시 정식화)
> **상위**: `docs/vision-statement.md` §4b (페르소나 분리), `docs/memory-provider-audit.md` (façade 감사)

---

## 1. 책임 분리 (사용자 directive 명시)

> "기억을 불러오거나 선택하는 모듈은 naia-memory에서 해야 한다"

| 책임 | 위치 |
|---|---|
| **MemoryProvider interface 정의** | naia-agent (`packages/types/src/memory.ts`) |
| **기억 저장 (encode)** | **naia-memory** (LocalAdapter / Mem0 / Qdrant 등) |
| **기억 검색 (recall)** + **랭킹/선택** + **decay** + **importance gating** | **naia-memory** |
| **압축 (compact)** | **naia-memory** (CompactableCapable impl) |
| **interface 호출 + 결과 inject** | naia-agent (Phase 3 supervisor) |

→ naia-agent는 검색 로직을 가지지 않는다. `provider.recall(opts)` 호출 + 결과를 `extraSystemPrompt`에 주입할 뿐.

---

## 2. 의존 방식 (현재 = 로컬 file: dep)

```json
// naia-agent/package.json (devDependencies)
"@nextain/naia-memory": "file:../alpha-memory"
```

**npm online publish 없이도 동작** — alpha-adk monorepo 안에서 file: 의존이 자동 link.

| 환경 | 동작 |
|---|:---:|
| alpha-adk 안 (로컬 dev) | ✓ 즉시 (354 PASS 검증) |
| 외부 사용자 / CI | ✗ alpha-memory 디렉터리 부재 |

**publish 시점 권고**:
- alpha-memory 성능 테스트 / 안정화 후
- 외부 distribution 필요 시 (지금은 미필요)
- 권한: 사용자 본인 npm account

publish 후에는 `"@nextain/naia-memory": "^0.x.y"` 로 변경.

---

## 3. wire 패턴 (host = alpha-adk 또는 다른 인스턴스 host)

```typescript
import { Agent } from "@nextain/agent-core";
import { LocalAdapter, MemorySystem } from "@nextain/naia-memory";

// 1. naia-memory 인스턴스 (alpha-adk가 path 결정)
const adkRoot = process.env["ADK_ROOT"] ?? process.cwd();
const memorySystem = new MemorySystem({
  adapter: new LocalAdapter({
    storagePath: path.join(adkRoot, "data/memory"),  // naia-adk 컨벤션
  }),
});

// 2. MemoryProvider 어댑터로 wrap (examples/naia-memory-host.ts 패턴)
const provider: MemoryProvider = makeNaiaMemoryProvider(memorySystem);

// 3. naia-agent에 inject
const host: HostContext = { llm, memory: provider, ... };
const agent = new Agent(host, ...);

// 4. (Phase 3 정식) supervisor가 prompt 보내기 전 recall + inject
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

// 5. sub-agent에 전달 → 응답 → encode 다시 호출
await provider.encode({
  content: assistantResponse,
  role: "assistant",
  context: { sessionId },
});
```

**Phase 3에서 정식 wire**. 현재 Phase 2는 wire X (interface만 정의 + adapter 예시).

---

## 4. naia-agent가 절대 하지 않는 것

- ❌ vector search / cosine similarity
- ❌ 기억 importance scoring
- ❌ Ebbinghaus decay
- ❌ knowledge graph
- ❌ 어떤 storage backend 직접 import

→ 모두 naia-memory 책임. naia-agent는 **interface 호출 + 결과 inject** 만.

---

## 5. 디렉터리명 vs pkg name (현 상황)

| | 값 |
|---|---|
| **GitHub repo** | `nextain/alpha-memory` (legacy 이름 유지) |
| **submodule 디렉터리** | `projects/alpha-memory/` |
| **npm package name** | **`@nextain/naia-memory`** (rename 완료) |
| **import 식** | `import { ... } from "@nextain/naia-memory"` |

→ 디렉터리명 (alpha-memory) 과 pkg name (naia-memory) 분리. 코드/import는 naia-memory만 쓰니 의존 path 명확. 디렉터리 rename은 사용자 별도 결정 (Phase 3 권장).

---

## 6. Phase 3 정식 wire 시 추가될 것

- naia-adk가 storage path 컨벤션 export (예: `getMemoryStoragePath(adkRoot: string)`)
- Phase2Supervisor → Phase3Supervisor (또는 옵션 추가)에 `MemoryProvider` DI
- supervisor.run() 내부에서 recall → extraSystemPrompt 자동 채움
- session_aggregated 후 encode 자동 호출
- `--memory` flag (CLI에서 enable/disable)
