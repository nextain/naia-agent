# ref-opencode review — 2026-04-25

**Source**: https://github.com/sst/opencode (commit 91468fe45, latest-1069)
**Prior coverage**: `docs/agent-loop-design.md` 표 + 본 세션 Phase 1 explore 결과

## 1. 무엇인가

SST의 `opencode`는 AI 코딩 어시스턴트를 위한 Effect 기반 런타임. Session/Compaction/Logger 추상화 + MCP(local/remote) 지원. 형식화된 세션 압축 정책(PRUNE_MINIMUM=20K, PRUNE_PROTECT=40K, 동적 preserveRecent), Tool signature에 sessionID/directory/권한 포함, Drizzle ORM 영속화, Effect Layer 기반 DI.

## 2. 우리에게 이미 흡수된 영향

`docs/agent-loop-design.md` References 표에 명시:
- **D1 (Stream-first API)**: opencode의 Effect 스트림 기반 설계 참고 → `Agent.sendStream() / send()` 이원화
- **D2 (CompactableCapable)**: opencode의 형식화된 compaction을 추상화로 전환 → MemoryProvider가 capability 구현
- **D3 (Compaction policy)**: `contextBudget=80K`, `compactionKeepTail=6msgs` → opencode의 DEFAULT_TAIL_TURNS=2보다 관대

## 3. 추가 채택 후보 (Phase 1 explore 발견)

- **Tool context 패턴** (`packages/opencode/src/tools/types.ts`): Agent가 Tool 실행 시 sessionID, 작업 디렉터리, ask() 권한 함수를 context에 포함. 우리 D5 (Tool delegated via HostContext)와 보완 가능.
- **Logger.tag() + timestamp 편의** (`packages/opencode/src/logger/index.ts`): tag 기반 필터링, time-aware 이벤트 로깅. OTLP 통합 가능.
- **Compaction overflow 검사 + 동적 preserveRecent** (`packages/opencode/src/compaction/compactor.ts`): 메시지 수 기반 PRUNE 트리거, contextBudget 초과 시 `preserveRecent=context*25%` 자동 계산. D3에 구체 구현으로 추가.
- **"DI 컨테이너 패턴" 단순화** (`packages/opencode/src/app/index.ts` AppLayer.mergeAll): Effect의 Dependency Injection을 단순 객체 조합으로 표현하는 아이디어. zero-runtime-dep 제약 하에서는 service 레지스트리 패턴으로 차용 가능.

## 4. 명시적으로 채택 안 할 것

- **SQL/Drizzle ORM 영속화** (`packages/opencode/src/schema/`): NotEffect + zero-runtime-dep 원칙 위배. Session/Compaction 메타는 메모리 내 또는 host가 직렬화 책임.
- **Effect Layer 직접 의존**: `effect` 패키지(1000+ LoC bundle)를 contract에 추가하면 zero-runtime-dep 정의 위반. "DI 컨테이너 개념"만 단순 함수/객체 조합으로 재구현.
- **첫 commit Go+TUI 패턴**: opencode의 초기 설계는 Go 바이너리 + TUI. 우리는 TS 단일 스택 (Tauri shell은 별도 host로 분리).

## 5. fixture-replay 갭 (opencode에 없는 것)

opencode는 226개 unit test (bun test) 보유, fixture-replay는 부재 → Anthropic SDK 스트림의 결정적 재생 불가. **우리는 명시적으로 도입해야**:
- `StreamRecorder`: Tool calls와 LLM chunks를 JSON으로 녹화
- `StreamPlayer`: 동일 구조 재생하며 integration test 실행
- 효과: 네트워크 없이 E2E 검증 가능

## 6. R0 채택/거부/이연 권고

- **채택**: Tool context 패턴 (sessionID/directory/ask 권한), Logger.tag/time, compaction overflow + 동적 preserveRecent, "DI 컨테이너 패턴"(구현은 단순 객체 주입 + 레지스트리 함수)
- **거부**: SQL/Drizzle 영속화, Effect Layer 직접 의존
- **이연**: fixture-replay E2E 테스트 (R3+ Slice 단위로 도입; 현재는 smoke test + mock 수준)

## 7. 열린 질문

1. **DI 표현**: plan A.1은 "단순 객체 주입"인데, 우리 컨테이너 패턴이 정확히 어떤 형태? (예상 답: service factory 함수들 + host가 명시적으로 주입)
2. **Session 직렬화**: Compaction 메타(droppedCount, turn units)를 host가 어디에 저장? (예상 답: Host-specific — FS, IndexedDB, DB. Agent는 메모리 내만 책임)
3. **Fixture-replay 우선순위**: R1에 smoke + mock, R3에 fixture? (Phase 2 backlog 확인 필요)
