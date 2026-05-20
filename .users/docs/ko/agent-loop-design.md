# Agent Loop Design — 레퍼런스 및 결정

> **언어**: [English](../../../docs/agent-loop-design.md) · 한국어 (이 파일)

`packages/core/src/agent.ts` (Phase 2 X3 스캐폴드)의 설계 문서.
각 선택의 사유와 출처 자료를 기록합니다.

> **F06 immutability**: 아래 D1~D8 결정은 변경 불가입니다. 신규 결정은
> 문서 하단의 "Appended D decisions (Slice 3-XR series)" 섹션에 Dn matrix
> 행으로 append합니다 — D1~D8 본문에 inlining 금지.

## 검토한 레퍼런스

| 출처 | 위치 | 강점 | 약점 |
|---|---|---|---|
| **careti** (naia-os/agent 경유) | `naia-os/agent/src/index.ts` | 검증된 streaming, `MAX_TOOL_ITERATIONS` 루프, tool 파티셔닝(concurrent vs sequential), `pendingApprovals` Map 기반 tier 승인, token budget pre-flight(warn-only), MCP cleanup | budget 체크가 compact가 아닌 warn — compaction은 #185 Phase 2로 TODO |
| **opencode session/compaction** | `refs/ref-opencode/packages/opencode/src/session/{session,compaction,processor}.ts` | 정식 compaction 정책: `PRUNE_MINIMUM`, `PRUNE_PROTECT`, `preserveRecent`, turn 단위 입자도. DB 기반 영속성. | Effect + SQL 조합이 embeddable runtime 라이브러리로는 무겁다. zero-runtime-dep + DI-first 자세에는 과함. |
| **claude-code** (분석) | `.agents/progress/11-ref-cc-analysis.json` + naia-os README quote | 자동 compaction, `CLAUDE.md` 기반 memory 레이어 + subagent spawn | memory가 파일시스템·단방향 — 양방향 실시간 memory 업데이트 없음 |
| **naia-memory** | `projects/naia-memory/src/memory/index.ts` | 4-store 아키텍처, 백그라운드 consolidation (기본 30분), reconsolidation (모순 탐지), Ebbinghaus decay, 수동 트리거용 `consolidateNow(force)` | 현재 `consolidate()`는 백그라운드; 실시간 stream compaction은 후일 capability (별도 논의) |

## 결정

### D1. Stream-first API, `send()`는 drain 래퍼

```
Agent.sendStream(userText, signal?): AsyncGenerator<AgentStreamEvent>
Agent.send(userText, signal?): Promise<string>  // sendStream을 drain
```

**Why**: streaming은 naia-memory의 계획된 실시간 compaction과 호환되는
유일한 형태(generation을 진행 중 관찰하고 싶어함). `send()`는 단순 케이스를
단순하게 유지하기 위한 편의 래퍼.

Ref: careti(stream 기반) > opencode(Effect 경유 stream).

### D2. Compaction은 `CompactableCapable`로 MemoryProvider에 위임

```ts
// @nextain/agent-types/memory.ts
export interface CompactableCapable {
  compact(input: CompactionInput): Promise<CompactionResult>;
}
```

**Why**:
- **naia-memory 통합 타겟** — memory가 이미 consolidation을 소유; compaction은 자연스러운 확장.
- **실시간 미래** — naia-memory가 `compact()`를 on-demand에서 pre-computed로 진화시킬 수 있음 (`encode()` 호출 시점에 rolling summary 유지). Agent 코드는 변하지 않음.
- **graceful degradation** — `memory`가 capability를 구현하지 않으면 Agent는 단순 sliding-window truncation으로 fallback (tail N 유지, head drop).

Ref: opencode가 compaction을 정식화했지만 자체 DB에 결속함. 우리는
capability 인터페이스로 추상화하여 어떤 memory든 plug-in 가능.

### D3. Compaction 정책 상수 (agent 측)

| Param | 기본값 | Why |
|---|---:|---|
| `contextBudget` | 80_000 tokens | 대부분 128K+ context 모델에 안전 |
| `compactionKeepTail` | 6 messages | ~3 turn; opencode `DEFAULT_TAIL_TURNS = 2`에 약간 관대 |
| `estimateTokens` | chars/4 휴리스틱 | 호스트가 provider-accurate 토크나이저 주입 가능 |

매 LLM call 전에 (tool-hop 루프 내부에서) 트리거되므로 긴 tool-use 체인이
폭발하지 않고 결국 자체 compact됨.

### D4. Tool-hop 루프는 `maxToolHops`로 제한 (기본 10)

**Why**: careti의 `MAX_TOOL_ITERATIONS = 10` 일치. runaway loop 방지,
`turn.ended`에 stub 텍스트 `[agent stopped — reached max tool-hop budget]`로
조건 노출. Logger가 warning emit.

### D5. Tool 실행은 `HostContext.tools` + `tierForTool` resolver로 위임

Agent는 승인, tier 정책, 실제 실행을 구현하지 않습니다. caller가 준
resolver에서 tier를 받아 `ToolInvocation`을 구성하고 `HostContext.tools.execute()`에
위임합니다. tier 기반 승인 흐름은 `@nextain/agent-runtime`의 `GatedToolExecutor`로
감싸거나, 테스트용으로 plain executor 사용.

**Why**: plan A.6 일치 — tier 강제는 runtime의 `ToolExecutor` 구현에 거주,
shell이 `ApprovalBroker`로 승인 UI 소유.

Ref: careti의 `needsApproval(call.name)` → `waitForApproval(...)` 패턴
이지만 inline이 아닌 인터페이스 뒤로 factor.

### D6. Memory `encode`는 turn end, `recall`은 turn start

- Turn start: `recall(userText, { topK: 5 })` — memory hit를 system prompt에 주입
- Turn end: `encode(userText, "user")` + `encode(assistantText, "assistant")`

**Why**: 최소 viable 양방향 흐름. 고급 hook(mid-stream encoding, 선택적
tool-result encoding)은 후속 iteration으로 연기. 계약은 허용함 — stream-level
입자도가 필요한 memory는 sub-capability 추가 가능.

Note: `encode()` 에러는 catch + 로깅되며 turn을 실패시키지 않습니다 —
memory는 사용자 가시 응답에 non-critical.

### D7. 세션 생명주기는 Agent 소유

Agent가 `Session` 객체 소유, `@nextain/agent-types/session.ts`의
`ALLOWED_TRANSITIONS`로 전환. Logger로 `session.{created,active,...}`
이벤트 emit. `close()`는 `closed`로 전환 + `memory.close()` 호출.

**Why**: plan A.5 — `naia-agent/core`가 세션 전환 로직 소유; 저장소는 다른 곳.

### D8. `AgentStreamEvent` union이 모든 관찰 가능 항목 노출

```ts
type AgentStreamEvent =
  | { type: "session.started"; session }
  | { type: "turn.started"; userText; recalled }
  | { type: "llm.chunk"; chunk }
  | { type: "tool.started"; invocation }
  | { type: "tool.ended"; invocation; result }
  | { type: "compaction"; droppedCount; realtime }
  | { type: "usage"; usage }
  | { type: "turn.ended"; assistantText }
  | { type: "session.ended"; state };
```

**Why**: 호스트(TUI, web UI, 로깅)가 이벤트 리스너 부착 없이 내부 전환을
관찰 가능. `llm.chunk`는 low-level 케이스(토큰 단위 렌더링)를 위해 raw
`LLMStreamChunk` 전달.

Ref: opencode의 BusEvent는 더 정교(서비스 간 publish-subscribe); 우리는
embedded story 단순화를 위해 yielded union 사용.

## naia-memory 통합 로드맵

| Now (v0.1) | Next | Future |
|---|---|---|
| `encode`/`recall`/`consolidate`/`close` | `CompactableCapable` 경유 `compact()` | 실시간 compaction hook: memory가 LLM stream 관찰, rolling summary 유지, `compact()` 즉시 반환 |
| 백그라운드 consolidation (30분) | agent가 트리거하는 on-demand `consolidateNow()` | per-turn micro-consolidation (가볍고 예측 가능) |
| 벡터 검색으로 recall | 현재 세션에 편향된 recall | attention-aware recall (방금 말한 것) |
| — | `isCapable()`로 sub-capability 발견 | capability registry 자동 채움 |

## 연기 / 후속

- 실제 토크나이저 통합(provider-accurate count). 현재 chars/4
- `sub-agent` spawning (claude-code 패턴). Agent는 오늘 single-level
- runtime 경유 MCP 브리지 (X4, #200 연속)
- prompt caching 전략 — 현재 passthrough, 의견 있는 정책 보류
- 호스트 내 multi-session 동시성 — 하나의 HostContext = 하나의 Session (plan A.12)

## 테스트 표면

현재: `scripts/smoke-anthropic.ts`는 `Agent`가 아닌 `AnthropicClient`를
직접 exercise. `Agent` 레벨 smoke(InMemoryMemory + Mock LLM + Mock Tools)는
빌드 실행 가능해진 후속 commit에서.

---

## Appended D decisions (Slice 3-XR series)

이 행들은 F06에 따라 additive입니다. 위 D1~D8은 변경되지 않습니다. 각
항목은 간단한 prose 결정 + slice 인용 + code-evidence 포인터(레포 상대
경로)로 구성됩니다.

### D-9. `safeTurn` REPL 생존 래퍼

모든 CLI turn은 `safeTurn(agent, prompt, debug)`로 감싸지므로 단일 turn
실패(모델 서버 outage, `ECONNREFUSED`, tool 에러)가 actionable hint를
출력하고 **REPL/호스트 프로세스를 crash시키지 않습니다**. single-shot 모드는
같은 hint와 함께 코드 2로 깔끔히 종료; REPL은 per-turn 실패 사이에서
생존하며, Slice 3-XR-M의 multi-turn LIVE 테스트가 실제 프로세스 경계에서
이를 검증합니다.

- Slice: 3-XR-F (CHANGELOG `[Slice 3-XR-B.1]` + `[Slice 3-XR-F]`),
  3-XR-M(multi-turn REPL LIVE)에서 재검증.
- Evidence: `bin/naia-agent.ts` → `async function safeTurn(...)`.

### D-10. `stripRecallResidue` agent-loop sanitizer

소형 모델(예: `gemma3n:e4b`)이 잘못된 `<recall>` 마커(`<recalall>…`,
`<recal_l>…`, `<recal<…`, 외톨이 `</recall>`)를 emit합니다. strict recall
파서는 이를 올바르게 무시하지만, raw streaming이 잔재를 사용자 가시
텍스트로 leak했습니다. `@nextain/agent-core`에서 export되는 순수 함수
`stripRecallResidue(text)`가 이제 `turn.ended` 시 agent의 최종
`assistantText`에 적용됩니다. strict match/act는 변경 없음 (cross-review
불변식: leniency가 recall behavior에 도달하지 않음). bounded match
(`{0,256}`), line-anchored, 마커 없는 입력은 byte-identical로 반환.

- Slice: 3-XR-F (CHANGELOG `[Slice 3-XR-D]`).
- Evidence: `packages/core/src/agent.ts` → `export function
  stripRecallResidue(text: string)` + `packages/core/src/index.ts` export
  + `bin/naia-agent.ts`의 `turn.ended` 처리.

### D-11. `--memory` + `LiteMemoryProvider` CLI 바인딩

`pnpm naia-agent --memory`는 ephemeral `InMemoryMemory`에서 **영속**
`LiteMemoryProvider`(blessed `@nextain/naia-memory` 컴포넌트)로 전환하며,
naia-settings의 `embedded` embedder + `<recall>` recall 프로토콜에 연결됩니다.
DB 기본값은 `~/.naia-agent/memory/cli.sqlite` (`NAIA_AGENT_MEMORY_DB`로
override). embedder/DB 실패는 in-memory로 graceful 강등 — memory 때문에
crash 금지. opt-in; 기본 동작 변경 없음.

- Slice: 3-XR-C-mem (CHANGELOG `[Slice 3-XR-C]`).
- Evidence: `bin/naia-agent.ts` → `LiteMemoryProvider` import + CLI memory
  provider factory의 `--memory` branch; 단위 테스트
  `packages/runtime/src/__tests__/cli-memory.test.ts`.

### D-12. `--enable-file-ops` + `workspaceRoot` wiring

신규 `--enable-file-ops` 토글(기본 OFF — 동작 변경 없음). 활성 시
`bash`와 함께 `read_file` / `write_file` / `edit_file` / `list_files`를
등록합니다. `workspaceRoot`은 기존 `--workdir`에서 와이어링되므로 D09
`normalizeWorkspacePath`가 경계를 일관되게 강제합니다. **direct 모드
(`runDirect`)와 service 모드(`runService`) 모두**에 wiring되어 service
manifest가 같은 보호를 받습니다. 범용 토글 — per-model branching 없음
(`feedback_naia_agent_general_purpose_no_overfit` 가드 보존).

- Slice: 3-XR-I (CHANGELOG `[Slice 3-XR-I]`).
- Evidence: `bin/naia-agent.ts` → `--enable-file-ops` arg parsing +
  direct/service 경로의 `createFileOpsSkills({ workspaceRoot: args.workdir })`.

### D-13. `--skills-dir` + `FileSkillLoader` + `CompositeToolExecutor` + `normalizeInputSchemaForOllama`

`<root>/skills/**/SKILL.md` (또는 `onmam-adk/skills/`) 아래 파일 시스템
SKILL.md skill의 live 로딩을 `FileSkillLoader`로, `bash` + (선택적)
file-ops 위에 skill executor를 합성하는 `CompositeToolExecutor`를 통해 LLM에
노출합니다. 스키마는 Ollama 클라이언트용으로 `normalizeInputSchemaForOllama`로
정규화되어 OpenAI-shape function-call 스키마가 round-trip합니다. ADK-agnostic
— naia-adk와 onmam-adk가 동일 machinery 공유 (Slice 3-XR-L에서 onmam-adk가
bin/runtime 변경 0건임을 검증).

- Slice: 3-XR-J (CHANGELOG `[Slice 3-XR-J]` + 3-XR-L 확정).
- Evidence: `bin/naia-agent.ts` → `--skills-dir` parsing + `FileSkillLoader`로
  `CompositeToolExecutor` 구성; `packages/runtime/src/composite-tool-executor.ts`;
  `packages/runtime/src/skill-tool-bridge.ts` → `export function
  normalizeInputSchemaForOllama(...)`.

### D-14. `--repl`로 non-TTY stdin에서 REPL 강제

`--repl`은 stdin TTY 상태와 무관하게 readline REPL 루프를 강제합니다.
기본은 여전히 piped stdin을 single-shot turn(`readStdin` → 한 turn)으로
처리(기존 설계 유지). `--repl`은 harness multi-turn 테스트와 여러 prompt를
feed하는 shell 파이프라인을 위한 토글입니다. model-agnostic, 기본 OFF,
동작 변경 없음.

- Slice: 3-XR-M (CHANGELOG `[Slice 3-XR-M + 3-XR-N + 3-XR-O]` § M1/O2).
- Evidence: `bin/naia-agent.ts` → `--repl` arg parsing + REPL launcher의
  non-TTY branch.

### D-15. `--service backend=claude-code` 구독 라우팅 + DRYRUN 게이트

`*.service.json` manifest가 `llm.backend: "claude-code"`를 선언하면
**사용자의 Claude 구독**을 통해 Claude Agent SDK
(`ai-sdk-provider-claude-code`)로 라우팅됩니다 — API 키 불필요
(subscription credit, per-account, 캡, 정책 2026-06-15). runtime의
`coding-tool.ts`와 동일 패턴. `NAIA_AGENT_DRYRUN=1` env 게이트는 구독
크레딧 소비 없이 dispatcher arm을 assert합니다; opt-in
`NAIA_AGENT_CLAUDECODE_LIVE=1`이 실제 1-turn 호출을 실행합니다.

- Slice: 3-XR-G (manifest schema) / 3-XR-M (LIVE wire + DRYRUN gate)
  (CHANGELOG `[Slice 3-XR-G]` + `[Slice R6/SB-1.1]` + 3-XR-M § M2).
- Evidence: `bin/naia-agent.ts` → `buildLLMClientFromManifest`의
  `case "claude-code"` + `runService`의 `NAIA_AGENT_DRYRUN` branch.

### D-16. `langgraph` + `rag-retriever` 예약 backend stub

service-manifest `llm.backend`가 `"langgraph"`와 `"rag-retriever"`를
**예약 값**으로 받아들여, manifest 작성자가 dispatcher 구현보다 앞서 의도를
선언할 수 있습니다. bin은 이를 인식하고 self-explaining stderr 라인을 출력
후 깔끔히 종료합니다(silent unknown-backend 실패 없음). live dispatcher
(LangGraph 노드 라우팅 / RAG retriever + vector store + LLM hop)는 Slice
3-XR-K (business-adk)로 연기.

- Slice: 3-XR-J piggyback / 3-XR-K deferred (CHANGELOG `[Slice 3-XR-J]`,
  Task #23 pending).
- Evidence: `bin/naia-agent.ts` → `buildLLMClientFromManifest`의
  `case "langgraph": case "rag-retriever":` arm.

### D-17. 3-judge 앙상블 (GLM + Claude CLI + Codex CLI), opt-in `NAIA_JUDGE_ENSEMBLE=1`

integration-scenario의 LLM-as-judge는 세 개의 high-judgment 시나리오
(A1 / A4 / F2)에 대해 opt-in **3-judge 앙상블** 모드를 갖습니다: GLM
(기본 단일 judge) + `claude` CLI + `codex` CLI. 구독 비용을 제한하기 위해
기본 OFF(단일 GLM) — `NAIA_JUDGE_ENSEMBLE=1`이 앙상블을 활성화합니다. 앙상블
활성 실행 1회 = 3 시나리오 × 3 judge = 9 API/CLI 호출. 나머지 23 시나리오는
단일 GLM 유지 (mechanism-asserted, low judgment).

- Slice: 3-XR-H (CHANGELOG `[Slice 3-XR-H]`).
- Evidence: `packages/cli-app/src/__tests__/integration-scenarios.test.ts`
  → A1/A4/F2 경로 주위의 `NAIA_JUDGE_ENSEMBLE` env 게이트.
