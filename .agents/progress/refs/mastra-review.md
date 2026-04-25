# ref-mastra review — 2026-04-25

**Source**: https://github.com/mastra-ai/mastra (commit b97a0594, v1.0.x, 147MB monorepo)  
**License**: Dual (Apache 2.0 core + Enterprise License for `ee/` directories)  
**Context**: Y Combinator W25 (~$13M), 22.3K GitHub stars, Gatsby founders, 1.0 released 2026-01  

---

## 1. 무엇인가

Mastra는 TypeScript-first AI agent framework로, 다음을 통합한 완전한 스택을 제공:

- **Agent class**: 도구 호출, 메모리, 음성 기능, 모델 라우팅 내장
- **ToolSet registry**: Zod 스키마 기반 타입 안전 tool 정의 (Tool 클래스, createTool factory)
- **Workflow engine**: DAG 기반 장기 실행 작업 (`.then()`, `.branch()`, `.parallel()`, suspend/resume)
- **Memory system**: 3-tier (conversation history, working memory, observational memory)
- **Evals framework**: 내장 스코어러 (prebuilt + custom)
- **RAG integration**: Document, reranking, GraphRAG 지원
- **Studio**: 웹 IDE (Playground UI, 실시간 추적, agent 테스트)
- **Mastra 중앙 hub**: 모든 컴포넌트 등록·관리 (agents, workflows, tools, scorers, memory, vectors)

핵심: 28개 packages (monorepo, pnpm workspace), 단일 진입점 `new Mastra({ agents, workflows, ... })`.

---

## 2. 우리 도메인과의 거리 (매우 가까움 ★★★★★)

| 측면 | naia-agent | Mastra | 비고 |
|---|---|---|---|
| **TypeScript** | ESM, Node ≥22 strict | ESM, modern TS strict | 동일 스택 |
| **Embeddable runtime** | 4-repo 분리 (runtime ⊂ naia-agent pkg) | monorepo 전체가 runtime (no split) | 구조 차이 |
| **Multi-LLM support** | Anthropic/OpenAI/Google (provider로 주입) | 40+ providers, ModelRouter 중앙 | Mastra 더 포괄적 |
| **DI-first** | HostContext 단순 객체 주입 | RequestContext + DI hub (Mastra 클래스) | naia-agent 더 간단 |
| **Zero-runtime-dep** | 원칙 (packages/core만 런타임) | 부분 (storage/memory 선택적, core는 경량) | naia-agent 더 엄격 |
| **Tool system** | Tool type + tool-executor.ts | Tool 클래스 + createTool factory | 유사 |
| **Memory** | MemoryProvider 4 + N capability 패싯 | 3-tier built-in (history/working/observational) | Mastra 더 통합 |
| **Workflow** | Agent loop (D1~D8 결정) | DefaultExecutionEngine + handlers | 다른 철학 |
| **Eval** | 미포함 (매트릭스 §D 신규) | 내장 Evals package + prebuilt scorers | **Mastra 강점** |
| **Studio (web UI)** | 아니오 (host 책임) | 포함 (Playground + Editor) | **차이 명확** |

**도메인 가장 가까운 이유**: 둘 다 TypeScript embeddable agent runtime. Mastra의 통합도 높지만(studio, eval, rag), 우리 모듈식 4-repo 원칙과는 맞지 않음.

---

## 3. 차용 가능한 패턴 후보

### 3.1 Agent 클래스 시그니처 + 다이나믹 argument 패턴
**출처**: `packages/core/src/agent/agent.ts` (6K+ lines), `types.ts`  
**패턴**: 
```typescript
interface AgentConfig {
  id, name, instructions, model, tools, memory, ...
}
export class Agent<TAgentId, TTools, TOutput, TRequestContext = unknown> { }
```
**우리와의 차이**: 
- Mastra: 모든 config 항목이 `DynamicArgument<T, TRequestContext>`로 표현 (런타임 해석)
- naia-agent: HostContext 일괄 주입, config는 static

**가치**: Mastra의 `DynamicArgument` 패턴은 tier/user/region 기반 동적 config 해석에 유용. 우리 매트릭스 C22(DI 컨테이너 단순화)과 부분 겹침.

---

### 3.2 Tool 정의 패턴 (Zod schema + execution context)
**출처**: `packages/core/src/tools/tool.ts`, `types.ts`  
**패턴**:
```typescript
export class Tool<TSchemaIn, TSchemaOut, TSuspend, TResume, TContext extends ToolExecutionContext> { }
const createTool = (config: { id, description, inputSchema, outputSchema, execute, ... }) => Tool
interface ToolExecutionContext { runId?, workflowId?, suspend?, resumeData?, mastra?, ... }
```
**우리와의 차이**: 
- Mastra: Tool 클래스 + factory, suspend/resume 내장, execution context 풍부 (workflow/MCP/approval context)
- naia-agent: ToolAction type alias, context는 minimal (sessionId, tier, decision broker)

**가치**: Mastra의 `suspend/resume` 패턴은 human-in-the-loop와 workflow 상호작용에 명시적. 우리 D05(tool context 패턴)과 일치.

---

### 3.3 Workflow system (DefaultExecutionEngine + handler 분산)
**출처**: `packages/core/src/workflows/default.ts`, `handlers/` (step, entry, sleep, control-flow)  
**패턴**: DAG 기반, retry 관리, suspend/resume 1급 지원, 실행 그래프 직렬화
**우리와의 차이**: 
- Mastra: explicit workflow DSL (createStep, .then, .branch, .parallel) + execution engine
- naia-agent: agent loop (D1~D8), workflow 아직 매트릭스 §C22 이연

**가치**: Mastra의 step retry 관리 + suspend/resume는 long-running task에 필요. 우리 매트릭스 §F D12 "workflow long-running" 후보와 직결.

---

### 3.4 Evals framework (scorer, prebuilt + custom)
**출처**: `packages/evals/src/` (scorers/, utils/)  
**패턴**:
```typescript
interface MastraScorer { run(input, output, expected) => score }
// Prebuilt: accuracy, relevance, toxicity, custom code-based
```
**우리와의 차이**: 
- Mastra: 공식 evals package, prebuilt + custom scorer 패턴
- naia-agent: 평가 메커니즘 전혀 없음 (매트릭스 §E02 테스트 커버리지 부족)

**가치**: **신규 후보**. Mastra evals 패턴은 agent 품질 반복에 필수. 매트릭스 §D 신규 항목 (D-eval-scorers)로 추가 가치 높음.

---

### 3.5 Memory 3-tier 설계 (conversation + working + observational)
**출처**: `packages/memory/src/index.ts`, `processors/`  
**패턴**: 
- Conversation history: 모든 메시지 저장
- Working memory: agent 상태 (JSON, 동적 업데이트)
- Observational memory: 임베딩 기반 의미론적 회상 (벡터 검색)

**우리와의 차이**: 
- Mastra: 메모리 3-tier built-in, message list + working memory tool + OM processor 모두 내장
- naia-agent: MemoryProvider 추상화 (4 + N), alpha-memory 구현별, 통합도 낮음

**가치**: 우리 A09(MemoryProvider 4 + N)와 부분 겹침. Mastra의 구조화된 3-tier는 naia-adk skill memory blueprint 설계에 참고 가능 (§D-memory-tiers).

---

### 3.6 DI 접근: Mastra 중앙 hub + RequestContext
**출처**: `packages/core/src/mastra/index.ts` (Config 인터페이스, 107K+ lines), `di/index.ts` (RequestContext)  
**패턴**:
```typescript
const mastra = new Mastra({ agents, workflows, storage, memory, logger, ... })
// RequestContext: thread-local, hook-based request data 전달
```
**우리와의 차이**: 
- Mastra: 중앙 Mastra 클래스가 모든 컴포넌트 등록·조정 (big hub)
- naia-agent: HostContext 간단한 객체 주입 (provider pattern)

**가치**: C22(DI 컨테이너 단순화)의 "service factory 함수 + host 명시 주입" 과 유사. Mastra의 hook 메커니즘은 참고 가능 (observability, logger interception).

---

### 3.7 Model routing + fallback (multi-provider support)
**출처**: `packages/core/src/llm/model/router.ts`, agent 설정  
**패턴**:
```typescript
model: 'openai/gpt-4' | { id: ..., apiKey: ... } | [
  { model: ..., maxRetries: 2, modelSettings: {...} },
  { model: ..., maxRetries: 1 }
]
```
**우리와의 차이**: 
- Mastra: 40+ providers, dynamic model fallback arrays with per-entry settings
- naia-agent: provider 주입 (Anthropic, OpenAI, Google)

**가치**: Mastra의 dynamic fallback array + `DynamicArgument<..., TRequestContext>` 는 tier 기반 model selection에 유용 (§D-model-fallback-arrays).

---

## 4. 명시적으로 채택 안 할 이유

### B13+ 재확인: Monorepo 구조
Mastra는 28개 packages의 단일 monorepo. 우리는 4-repo 분리 (naia-os, naia-agent, naia-adk, alpha-memory).  
**이유**: 
- zero-runtime-dep contract (runtime 의존성 명확화) 필요
- host(naia-os) 별도 배포 주기
- 우리 매트릭스 B13 이미 결정

---

### Studio (web UI) 미채택
Mastra는 Playground + Editor UI 통합. 우리는 CLI/Tauri shell로 분리.  
**이유**: 
- host 책임 분리 (naia-os가 UI 담당)
- embeddable runtime은 UI 비의존

---

### Enterprise License (`ee/` directory)
Mastra의 auth, 고급 기능 일부가 Enterprise License 대상.  
**정책**: Apache 2.0 코어만 참고. Enterprise 부분은 제외.

---

### RAG + Vector integration (선택적)
Mastra의 rag package (GraphRAG, reranking) 우리 필요에 맞지 않음 (지금은).  
**이연**: C04(prompt caching 정책) 이후 재평가.

---

## 5. 매트릭스 영향 평가

### 5.1 §A (이미 채택된 결정) 충돌 검증
**점검**: A01~A15와 Mastra 패턴 비교.
- **A01 (Stream-first API)**: Mastra도 stream 지원 (Agent.stream(), network()). 충돌 없음.
- **A05 (Tier T0~T3 + GatedToolExecutor)**: Mastra는 approval 중심. 우리 tier 시스템과 직교. 충돌 없음.
- **A09 (MemoryProvider 4 + N)**: Mastra 3-tier와 부분 겹침. 우리는 더 추상화. 호환 가능.
- **A12 (MCP 4단계)**: Mastra MCP server 지원 있음. 우리와 독립적.
- **A13 (Skill 1등 시민)**: Mastra는 workspace + skill 개념 있음. 우리와 비슷.

**결론**: **§A 항목 수정 필요 없음**. 우리 결정이 Mastra보다 더 간단/엄격.

---

### 5.2 §C (이연) → §A 승격 후보
**C22 (DI 컨테이너 패턴)**: 
- Mastra: Mastra 중앙 클래스 + RequestContext hook 패턴
- 우리: "service factory 함수 + host 명시 주입" 결정
- **영향**: Mastra의 hook 메커니즘은 C22 구체화에 참고. 하지만 우리 더 간단한 목표 유지.

**C21 (Fixture-replay E2E)**:
- Mastra: LLM recorder (`packages/_llm-recorder`), execution serialization
- 우리: 현재 mock only
- **영향**: Mastra의 serialization 패턴 참고 가능. 우리 R3+ slice에서.

---

### 5.3 §D (신규 채택 권고) 추가 항목

#### D-eval-scorers (P1, M 공수)
**소재**: `packages/evals/src/scorers/`  
**패턴**: 
- MastraScorer interface (run: (input, output, expected) => { score: number })
- Prebuilt: accuracy (code execution), relevance (embedding-based), toxicity, custom
- 우리 부재: 평가 메커니즘 전무

**권고**: 
- Slice 3+에서 naia-agent 통합 평가 시스템 추가
- Agent + Tool 콘텐츠 품질 반복
- 매트릭스 신규 항목: `D-eval-scorers` (P1)

---

#### D-memory-tiers-structured (P2, S~M 공수)
**소재**: `packages/memory/src/` 3-tier 패턴  
**패턴**: 
- Conversation history (message list)
- Working memory (JSON state, update tool)
- Observational memory (embedding-based semantic search)

**우리와의 차이**: 
- A09(MemoryProvider 4 + N)는 추상화만
- Mastra의 구체적 3-tier는 naia-adk skill memory spec 설계 참고

**권고**: 
- Phase 2에서 alpha-memory reference impl 보강
- Skill memory contract 구체화 (working + observational)
- 매트릭스 신규: `D-memory-tiers-blueprint` (P2)

---

#### D-model-fallback-dynamic (P1, S 공수)
**소재**: `packages/core/src/agent/types.ts`, Agent.model config  
**패턴**: DynamicArgument<MastraModelConfig | ModelWithRetries[], TRequestContext>

**우리 현재**: 단일 provider 주입, 런타임 선택 권한 없음.  
**Mastra 장점**: Fallback array + tier/user 기반 동적 선택

**권고**: 
- D01 DANGEROUS_COMMANDS 이후 도입 (Slice 2)
- LLMClient 인터페이스 확장 (tier → model mapping)
- 매트릭스 신규: `D-provider-fallback-tiers` (P1)

---

#### D-tool-suspend-resume-explicit (P1, S 공수)
**소재**: `packages/core/src/tools/types.ts`, Tool.suspend/resumeSchema  
**패턴**: ToolExecutionContext의 suspend() + resumeData, workflow와 상호작용

**우리 현재**: Tool context minimal, suspend 개념 없음.  
**차용 가치**: D05(tool context 패턴) 보강 + workflow 준비 (C22 이후)

**권고**: 
- Phase 2에서 long-running task 지원 시 도입
- Tool 타입 확장 (suspendSchema, resumeSchema)
- 매트릭스 신규: `D-tool-suspend-explicit` (P2)

---

### 5.4 §B (거부) 추가 확정

**B17: Mastra monorepo 패키지 의존 (신규)**
- Mastra는 28개 packages 강결합
- 우리 4-repo 분리 원칙과 양립 불가
- 결정: **거부** (B13 재확정)

**B18: Studio web IDE (신규)**
- host(naia-os) 책임 분리 원칙
- 결정: **거부**

---

## 6. R0 채택/거부/이연 권고 (한 줄씩)

| 항목 | 결정 | 근거 |
|---|---|---|
| Agent 시그니처 + DynamicArgument | **이연** (C22 → §D) | DI 컨테이너 패턴 정의 후 |
| Tool 클래스 + suspend/resume | **이연** (§D-tool-suspend) | Workflow phase 2 후 |
| Evals framework 패턴 | **신규 채택** (§D P1) | 평가 메커니즘 부재, 높은 가치 |
| Memory 3-tier 구조 | **참고** (§D-memory-tiers) | alpha-memory blueprint 보강 |
| Model fallback array | **신규 채택** (§D P1) | Slice 2 이후 |
| Workflow DefaultExecutionEngine | **이연** (§F D12) | Phase 2 workflow 정식화 후 |
| Monorepo 28-package 구조 | **거부** (B17) | 4-repo 분리 원칙 |
| Studio UI 통합 | **거부** (B18) | host 책임 분리 |

---

## 7. 열린 질문

### Q1. DynamicArgument vs HostContext 간단 주입?
Mastra의 `DynamicArgument<T, TRequestContext>` 는 강력하지만 복잡. 우리 매트릭스 C22(단순화)는 여전히 필요한가, 아니면 Mastra 패턴이 더 나은가?  
**잠정 답**: C22는 "service factory 함수" 수준으로 유지. DynamicArgument는 opt-in (Phase 2).

### Q2. Observational Memory 벡터화 시점?
Mastra OM은 벡터 저장소 강의존. 우리 zero-runtime-dep는 이를 제약. OM 도입은 Phase 2 vector integration 이후?  
**잠정 답**: 맞음. 매트릭스 §D-memory-tiers-blueprint (P2).

### Q3. Evals scorers — internal-only vs public API?
우리 evals 도입할 때, Mastra처럼 prebuilt scorer 제공할 것인가, 아니면 user 정의 scorer만 지원할 것인가?  
**잠정 답**: Phase 1은 user-defined + 1~2 prebuilt (accuracy). Phase 2에 확장.

---

## 참고

- **Mastra 공식 docs**: https://mastra.ai/docs
- **GitHub**: https://github.com/mastra-ai/mastra
- **License mapping**: Mastra LICENSE.md (Apache 2.0 + Enterprise dual)
- **우리 비교**: ref-adoption-matrix.md §A (이미 채택 14건) vs Mastra 패턴
- **다음 ref**: LangGraph TS, Vercel AI SDK (task #24)
