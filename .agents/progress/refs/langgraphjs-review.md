# ref-langgraphjs review — 2026-04-25

**Source**: https://github.com/langchain-ai/langgraphjs (commit 7f3320cd, 48.7K LoC)
**License**: MIT
**Note**: LangChain ecosystem. 42K npm weekly downloads, prod-ready adoption (Replit/Uber/LinkedIn/GitLab). 우리 도메인과 부분 겹침 (multi-agent + stateful orchestration).

---

## 1. 무엇인가

StateGraph 기반 stateful agent orchestration framework. **Pregel 메시지 패싱 엔진** 위에 구축된 graph-first 추상화:
- **StateGraph**: node + edge 기반 workflow (채널 리듀서로 상태 관리)
- **Checkpointing**: BaseCheckpointSaver 추상화 (in-memory, sqlite, postgres 구현체 제공)
- **Human-in-the-loop**: interrupt() 함수 + Command.resume() 패턴
- **Prebuilt agents**: createReactAgent (ReAct), ToolNode, AgentExecutor
- **Streaming**: Token-by-token + intermediate step visibility
- **Sub-graph**: nested StateGraph + Send() 패턴으로 다중 에이전트

핵심 설계: **superstep-based** 실행 (각 단계 후 상태 checkpoint → fault-recovery + time-travel 가능).

---

## 2. 우리 도메인과의 거리 (부분 겹침)

**같음**:
- TypeScript multi-LLM agent framework
- Stream-first API (token 단위 가시성)
- Tool/skill 실행 추상화 (ToolNode + StructuredTool)
- Memory/session 생명주기 관리
- Human-in-loop approval 패턴

**다름 (모델 충돌)**:
- **Graph vs Stream-first**: LangGraph는 DAG 그래프 추상화 우선. 우리는 D1(stream-first single agent loop) 결정 완료 — graph 오버헤드 주지 않음
- **LangChain ecosystem 강결합**: @langchain/core (Runnable, ChatModel, Tool) 필수. 우리는 zero-runtime-dep 원칙 (B09, B06 거부 참고)
- **Python parity 우선**: JS 구현이 Python 따라잡기 모드. 신규 features 지연
- **채널 리듀서 vs stream state**: StateGraph의 "reducer per channel" 패턴은 정적 스키마 가정. 우리의 CompactableCapable + stream-driven state 갱신 더 유연
- **Checkpoint 직렬화**: JSON-serializable 상태 가정. 우리는 가변 타입 (VoiceEvent, MemoryProvider impl) 지원

**우리 우위**:
- Zero-runtime dependency (B09 거부)
- DI-first (service factory 패턴, A.22 추천)
- Tool tier 정책 (GatedToolExecutor, A05)
- Provider-agnostic LLMClient (A10 Anthropic 구현체)
- Single TS stack (B07, B14 거부)

---

## 3. 차용 가능한 패턴 후보 (5개)

### P1. Checkpointing 아키텍처 (§C05 multi-session과 연결)
```
BaseCheckpointSaver (추상) → put/get/list (tuple = channel states + metadata)
```
우리 사용처: session.resume(checkpointId). sqlite/postgres 스토어 선택지. **채택 가치**: 중간-높음. 우리 HostContext 1-session 한계 해소 가능 (C05 트리거 조건).

### P2. interrupt()/Command.resume() 패턴 (human-in-the-loop)
```typescript
const approval = interrupt({ reason: "Need human approval" });
// UI/daemon 응답 후:
graph.stream(new Command({ resume: approval }));
```
우리 사용처: ApprovalBroker.decide() 대체 후보. **채택 가치**: 높음. Mastra needsApproval 패턴과 비교 필요 (task #24).

### P3. createReactAgent 템플릿 (§F 결정 누락)
```typescript
const agent = createReactAgent({ llm, tools });
await agent.invoke({ messages: [...] });
```
ReAct 루프 기본 구현 제공. **채택 가치**: 낮음. 우리는 이미 A01(stream-first) 결정 → 기본 패턴 차용 불필요. 참고용만.

### P4. Sub-agent spawn 패턴 (§C02 defer)
```typescript
// Node 내서:
yield Send("agent_2", { input });
// Multi-instance, 병렬 가능
```
**채택 가치**: 높음-중간. C02 트리거 조건 (Phase 2+) 만족 시 LangGraph 패턴 정식화 검토.

### P5. Durability 설정 (checkpointer 선택)
```typescript
config = { configurable: { checkpointer: sqlite } }
```
쓰기 정책 추상화. **채택 가치**: 낮음. 우리는 host가 MemoryProvider 주입 (A09 4+N capability).

---

## 4. 명시적으로 채택 안 할 이유

### B17. @langchain/core 의존성 (zero-runtime-dep 위배)
LangGraph → @langchain/core 필수 (Runnable, ChatModel, BaseMessage, Tool 인터페이스). 번들 크기 큼 (B09, B06과 동일 사유).

### B18. StateGraph 채널 리듀서 패턴
`channels: { key: reducer }` 방식은 **정적 상태 스키마** 가정. 우리는 CompactableCapable(A02) + stream-driven 갱신이 더 적합. Graph 추상화 시 D1(stream-first) 결정 위배.

### B19. Python parity 의존
신규 feature는 Python 먼저 구현 후 JS 포팅. TS 단일 스택 우리에게 불필요한 friction.

### B20. JSON 직렬화 강제
Checkpoint tuple은 JSON-serializable 가정. VoiceEvent(visemeId: ARKit | Oculus | custom) 같은 가변 타입 지원 제한 (E03).

---

## 5. 매트릭스 영향 평가

### §C02 Sub-agent spawn (defer → 조건부 승격)
LangGraph의 Send() 패턴은 정식이고 검증됨. Phase 2 진입 시 우리 spec과 대조 → C02 → A## 또는 우리 별도 패턴 정의.

### §C05 Multi-session concurrency (defer → 조건부 승격)
Checkpointing + thread_id 추상화로 1 HostContext = N Session 가능. Checkpoint list 폴링 or SDK threading API 필요. P1 (높음) 우선순위 가능.

### §D (신규 후보 추가 여부)
- **D09 (P2)**: Interrupt hook pattern (28-event 후보) — 우리 hook 정의 후 mapper 작성 필요 (§C11 deferred). LangGraph 패턴 참고용.
- **D10 (P2)**: StateGraph template (optional) — 우리가 graph 도입하면. 현재는 defer (D1 결정).

---

## 6. R0 채택/거부/이연 권고

| 결정 | 대상 | 근거 |
|---|---|---|
| **이연** | Checkpointing 아키텍처 (P1) | §C05 트리거(multi-session) 시 재평가. 현재 1-session 모델 충분 |
| **이연** | interrupt()/resume() (P2) | Mastra 비교 후 (task #24) ApprovalBroker 통합 검토 |
| **거부** | @langchain/core 직접 의존 | B17 (zero-runtime-dep 위배) |
| **거부** | StateGraph 채널 리듀서 | B18 (D1 stream-first 결정과 모델 충돌) |
| **참고** | createReactAgent 템플릿 | 기본 ReAct 구조 이해. 차용 안 함 (A01 이미 구현) |
| **이연** | Sub-agent Send() | C02 자동 진입 시 정식 채택 검토 |

**R1 액션**: C02, C05 트리거 확인 → 필요 시 C→D 승격 후 구현 우선순위 조정.

---

## 7. 열린 질문 (3개)

1. **interrupt() vs ApprovalBroker**: Mastra needsApproval (task #24)과 비교하면, 어느 패턴이 우리 host abstraction과 더 잘 맞는가? LangGraph는 checkpointer 필수인가?

2. **Checkpoint durability**: SQLite/Postgres 선택이 Phase 1 (메모리만) → Phase 2 (분산) 마이그레이션 경로에 영향? alpha-memory의 MemoryProvider 추상화와 orthogonal?

3. **StateGraph vs Custom Graph**: D1(stream-first)를 지키면서 graph 레벨의 복잡도(다중 에이전트, 조건부 라우팅)를 어떻게 표현? Send() + Command 패턴만으로 충분한가, 아니면 우리 고유 DSL 필요?

---

## 참고 문서

- LangGraph core: `/libs/langgraph-core/src/{graph,pregel,prebuilt}`
- 매트릭스 §C02 (sub-agent), §C05 (multi-session): `ref-adoption-matrix.md`
- 우리 stream-first 결정: `docs/agent-loop-design.md` D1
- Zero-runtime-dep: AGENTS.md §B09, B06
