# Hosting an Agent — 개발자 가이드

> **언어**: [English](../../../docs/hosting-guide.md) · 한국어 (이 파일)

본 가이드는 `@nextain/agent-core` 의 `Agent` 를 임베드하는 호스트를
만드는 방법을 설명합니다. naia-agent 사전 지식은 가정하지 않습니다.
다만 TypeScript + Node ≥ 22 환경은 전제로 합니다.

5분이면 첫 실행, 20분이면 production 형태의 호스트가 완성됩니다.

## 최소 호스트 (15줄)

```ts
import { Agent } from "@nextain/agent-core";
import { ConsoleLogger, InMemoryMeter, NoopTracer } from "@nextain/agent-observability";
import { InMemoryMemory, InMemoryToolExecutor, MockLLMClient } from "@nextain/agent-runtime";

const agent = new Agent({
  host: {
    llm: new MockLLMClient({ turns: [{ blocks: "hello", stopReason: "end_turn" }] }),
    memory: new InMemoryMemory(),
    tools: new InMemoryToolExecutor(),
    logger: new ConsoleLogger(),
    tracer: new NoopTracer(),
    meter: new InMemoryMeter(),
    approvals: { async decide() { throw new Error("not wired"); } },
    identity: { deviceId: "dev", publicKeyEd25519: "dev", async sign() { throw new Error("not wired"); } },
  },
});

console.log(await agent.send("hello agent"));
```

`host` 의 모든 필드는 필수이며, 이것이 `HostContext` 정규 형태입니다
(`@nextain/agent-types`).

| 필드 | 용도 |
|---|---|
| `llm` | `LLMClient` — provider 호출 (Anthropic / OpenAI-compat / Vertex / Claude Code 구독) |
| `memory` | `MemoryProvider` — encode / recall / consolidate / close |
| `tools` | `ToolExecutor` — skills, bash, MCP, file-ops 또는 그 합성 |
| `logger` | 구조적 logger (level 인식) |
| `tracer` | OpenTelemetry 호환 tracer (테스트는 `NoopTracer`) |
| `meter` | 메트릭 meter (테스트는 `InMemoryMeter`) |
| `approvals` | `ApprovalBroker` — T2/T3 도구 승인 UI는 호스트 소유 |
| `identity` | tamper-evident audit 용 device key + `sign()` |

헬퍼(`InMemoryMemory`, `InMemoryToolExecutor`, `MockLLMClient`,
`NoopTracer`, `InMemoryMeter`, `ConsoleLogger`) 가 실제 backend 없는
경로를 한 줄 import 로 가능하게 해 줍니다.

## 실제 LLM 으로 교체

대부분의 호스트는 직접 provider 를 손으로 와이어링하기보다,
`naia-adk/naia-settings/llm.json` (SoT) 의 **cross-repo 3-role
구성**을 사용하는 편이 좋습니다. 표준 상세는
`docs/llm-config-standard.md` 참고.

호스트가 `LLMClient` 를 직접 구성해야 할 때는
`@nextain/agent-providers` 의 클라이언트를 사용합니다.

```ts
import { VercelClient } from "@nextain/agent-providers";
import { createAnthropic } from "@ai-sdk/anthropic";

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const llm = new VercelClient(anthropic("claude-haiku-4-5-20251001"));
```

OpenAI-compat gateway, Vertex AI, Claude Code 구독 provider
(`ai-sdk-provider-claude-code`, `backend:"claude-code"` — API key 없이
구독 크레딧 사용) 모두 동일 패턴입니다. `bin/` 진입점은
`bin/naia-agent.ts` 의 `buildLLMClientFromManifest` 에서 네 backend
를 모두 분기합니다.

## 실제 메모리 교체 — naia-memory

```ts
import { LiteMemoryProvider, OpenAICompatEmbeddingProvider } from "@nextain/naia-memory";

const embedder = new OpenAICompatEmbeddingProvider({
  baseURL: process.env.NAIA_EMBED_BASE_URL,
  model: process.env.NAIA_EMBED_MODEL,
  dims: Number(process.env.NAIA_EMBED_DIMS ?? 1024),
});
const memory = new LiteMemoryProvider({
  dbPath: "memory.sqlite",
  embedder,
  writesEnabled: true,
});
```

`LiteMemoryProvider` 는 `MemoryProvider` 와 옵션 인터페이스
`CompactableCapable` 을 구현 — Agent 의 `contextBudget` 초과 시
`memory.compact()` 가 호출되어 사전 계산된 rolling summary 가
즉시 반환됩니다.

end-to-end blessed 예제(sqlite + offline embedding) 는
`examples/hardened-sqlite-host.ts`. CLI 자체도 `--memory` 플래그로
동일 스택을 사용합니다 (Slice 3-XR-C).

## Skill 을 도구로 노출

naia-adk 워크스페이스의 skill 은 top-level `skills/<name>/SKILL.md`
에 둡니다. 두 줄이면 LLM 가시 도구로 연결됩니다.

```ts
import { FileSkillLoader, SkillToolExecutor } from "@nextain/agent-runtime";

const loader = new FileSkillLoader({
  workspaceRoot: "./my-workspace",
  skillsDir: "./my-workspace/skills",
  invoker: async (desc, input) => ({ content: await runSkill(desc, input.args) }),
});
const tools = new SkillToolExecutor({ loader });
```

`tools` 를 host 에 주입하면 Agent 의 LLM 이 디렉터리의 모든
`SKILL.md` 를 도구로 인식합니다. CLI 도 `--skills-dir <path>` 로
동일 loader 를 노출합니다 (Slice 3-XR-J). 메커니즘은 ADK 비종속 —
Slice 3-XR-L 이 코어 변경 0 으로 onmam-adk 를 동일 표면에서 검증.

## MCP 서버 추가

```ts
import { MCPClient, MCPToolExecutor } from "@nextain/agent-runtime";

const github = new MCPClient({
  name: "github",
  command: "mcp-server-github",
  defaultTier: "T2",
});
await github.connect();

const tools = new MCPToolExecutor([github]);
```

MCP 도구는 충돌 방지를 위해 `server:tool` 로 namespace 됩니다.

## Composite tool executor (bash + file-ops + skills + MCP)

실 호스트는 거의 항상 여러 executor 를 합성합니다. CLI 자체가
내장 + 선택적 ADK skill loader 의 composite 로 동작합니다.

```ts
import {
  CompositeToolExecutor,
  InMemoryToolExecutor,
  createBashSkill,
  createFileOpsSkills,
  FileSkillLoader,
  SkillToolExecutor,
  MCPToolExecutor,
  MCPClient,
} from "@nextain/agent-runtime";

const builtins = new InMemoryToolExecutor([
  createBashSkill(),
  ...createFileOpsSkills({ workspaceRoot: "./workspace" }),
]);

const skills = new SkillToolExecutor({
  loader: new FileSkillLoader({
    workspaceRoot: "./my-adk",
    skillsDir: "./my-adk/skills",
  }),
});

const github = new MCPClient({ name: "github", command: "mcp-server-github", defaultTier: "T2" });
await github.connect();

const tools = new CompositeToolExecutor({
  subs: [
    { id: "builtins", executor: builtins },   // bash + read/write/edit/list_files
    { id: "adk-skills", executor: skills },   // naia-adk / onmam-adk top-level skills/
    { id: "mcp", executor: new MCPToolExecutor([github]) },
  ],
});
```

**Sub 순서는 trust boundary**: 신뢰가 강한 소스를 앞에 둡니다
(built-ins → first-party ADK skills → MCP). 같은 이름은 먼저
등록한 sub 가 이깁니다. 뒤의 sub 는 shadow 됩니다.
`CompositeToolExecutor` 는 shadow 발생 시 경고를 emit 하며,
Slice 3-XR-L 통합 시나리오가 이 속성을 검증합니다
(`ownerOf("channel-management") === "naia-adk"`,
`shadowedNames().length >= 9`).

`createFileOpsSkills({ workspaceRoot })` 는 `read_file`,
`write_file`, `edit_file`, `list_files` 를 등록 — `normalizeWorkspacePath`
(D09) 로 워크스페이스 root 에 바운드됩니다. Slice 3-XR-I 가
`gemma4:31b` 의 native tool-call 로 loop 를 end-to-end LIVE 검증
(Group P, 6/6).

## 스트림 관찰

`sendStream()` 은 모든 전이에 구조적 이벤트를 yield 합니다.

```ts
for await (const ev of agent.sendStream("solve this")) {
  switch (ev.type) {
    case "text":          // text_delta token
    case "thinking":      // thinking_delta token
    case "tool.started":  // tool.name / invocation.input
    case "tool.ended":    // invocation / result
    case "compaction":    // droppedCount / realtime (precomputed?)
    case "usage":         // input/output/cache tokens
    case "turn.ended":    // assistantText (final)
    case "tool.error.halt": // ≥ N 회 연속 도구 에러 → 턴 정지
  }
}
```

**채널 중복 주의**: `llm.chunk` 는 SDK 원본 stream 을, `text` /
`thinking` 은 동일 delta 의 편의 파생본을 운반합니다. 둘 다
구독하지 마세요.

## 승인 & 티어

skill / 도구는 tier (T0/T1/T2/T3) 를 선언합니다. Agent 의
`ToolExecutor.execute()` 자체는 정책을 강제하지 않습니다 —
승인 게이팅이 필요하면 `GatedToolExecutor` 로 감쌉니다.

```ts
import { GatedToolExecutor } from "@nextain/agent-runtime";

const gated = new GatedToolExecutor({
  inner: tools,
  approvals: hostApprovalBroker, // your UI-backed broker
  requireApproval: new Set(["T2", "T3"]),
});
```

`ApprovalBroker` 는 `HostContext` 필드 — 호스트의 broker 가
사용자에게 (CLI prompt, Tauri modal, HTTP push …) 요청을 제시하고
`{ status: "approved" | "denied" | "timeout" }` 를 resolve 합니다.

## 장기 세션

- Agent 는 `estimateTokens(request)` 가 `contextBudget` (기본 80_000)
  을 넘으면 자동 compact. `CompactableCapable` 이면
  `memory.compact()` 위임, 아니면 history window 슬라이드.
- `maxConsecutiveToolErrors` (기본 3) — 도구가 연속 실패하면 턴
  정지. `tool.error.halt` 이벤트로 surface.
- `agent.close()` 는 세션을 `closed` 로 보내지만 공유 `memory` 는
  닫지 않습니다 — 호스트가 `memory.close()` 책임.

## 실시간 compaction (naia-memory)

naia-memory `MemorySystem.compact()` 는 알려진 `sessionId` 가
들어오면 `encode()` 동안 갱신된 per-session rolling summary 를
`realtime: true` 와 함께 반환합니다. Agent 는 이 플래그를
`compaction` 이벤트로 전파하여 UI 가 "summary 즉시" vs
"summary 새로 생성" 을 표시할 수 있게 합니다.

어댑터에서 `sessionId` 전달을 보장:

```ts
async encode(input) {
  await sys.encode(
    { content: input.content, role: input.role, ... },
    { sessionId: input.context?.sessionId },
  );
}
```

## Service-manifest 호스팅 (선언형)

호스트가 `HostContext` 를 코드로 짜는 대신 agent 를 선언적으로
기술하고 싶으면 `*.service.json` manifest 를 사용합니다. `bin`
진입점이 LLM client, memory binding, persona 를 manifest 로부터
조립합니다.

```bash
pnpm naia-agent --service ./my-app.service.json "hello"
```

`llm.backend` 지원 값:

| backend | 인증 | 비고 |
|---|---|---|
| `openai-compatible` | host env (`OPENAI_*`) | 범용 OpenAI-compat / 로컬 Ollama / vLLM |
| `anthropic` | host env (`ANTHROPIC_API_KEY`) | Anthropic 직접 |
| `vertex` | host env (`VERTEX_PROJECT_ID` + `VERTEX_REGION`) | Vertex Anthropic |
| `claude-code` | Claude Code 구독 (API key 없음) | 구독 크레딧; `docs/auth-not-logged-in.md` 참고 |
| `langgraph` / `rag-retriever` | reserved | 스키마는 수용; dispatcher 는 보류 (Slice 3-XR-K) |

스키마 SoT 는 `naia-adk/docs/service-manifest-schema.md` 에 있음.

## Integration 시나리오 = 호스트 reference

Slice 3-XR-G / I / J / L / M / N / O 가 hermetic
`integration-scenarios.test.ts` + `bin-user-scenarios.test.ts`
(100+ 사용자 관점 spawn-test — live LLM, memory recall, tool-loop,
persona, secrets, service manifest, REPL, cross-OS) 를 출하했습니다.
production 형태의 패턴은 `packages/cli-app/src/__tests__/` 에서
바로 읽을 수 있습니다 — 외부 harness 에서 `bin` 을 어떻게 구동하고
LLM vibe 가 아니라 stderr tool marker, file-system invariant,
SQLite probe 로 어떻게 assert 하는지 보여줍니다.

## 완전 예제 (repo)

`examples/` 의 reference host:

| 파일 | 내용 |
|---|---|
| `minimal-host.ts` | mock 1턴 tool-hop |
| `compaction-host.ts` | mock memory 의 `CompactableCapable` |
| `hardened-sqlite-host.ts` | sqlite + offline embedding (blessed naia-memory 스택) |
| `tool-error-halt.ts` | 연속 에러 halt |
| `skill-loader-host.ts` | SKILL.md YAML 파싱 |
| `skill-tool-host.ts` | skill 을 1급 도구로 |
| `composite-host.ts` | 다중 executor 합성 + shadow 경고 |

실행: `pnpm exec tsx examples/<name>.ts`

## 패키지 개요

| 패키지 | 용도 |
|---|---|
| `@nextain/agent-types` | zero-dep 계약 (`LLMClient`, `MemoryProvider`, `ToolExecutor`, `Event`, …) |
| `@nextain/agent-protocol` | wire protocol (stdio frame) |
| `@nextain/agent-core` | Agent loop |
| `@nextain/agent-runtime` | 헬퍼: `GatedToolExecutor`, `FileSkillLoader`, `SkillToolExecutor`, `MCPClient`, `CompositeToolExecutor`, `createBashSkill`, `createFileOpsSkills`, mocks |
| `@nextain/agent-providers` | `LLMClient` 구현 (`VercelClient`, Anthropic, Vertex, Claude Code) |
| `@nextain/agent-observability` | 기본 `Logger` / `Tracer` / `Meter` |
| `@naia-adk/skill-spec` | `SKILL.md` 포맷 spec |
| `@nextain/naia-memory` | `MemoryProvider` 레퍼런스 구현 |

## License

Apache 2.0.
