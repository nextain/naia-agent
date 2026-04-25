# ref-jikime-mem review — 2026-04-25

**Source**: https://github.com/jikime/jikime-mem (commit 0e3f6920)

## 1. 무엇인가 / 무엇이 아닌가

**메모리 백엔드**: SQLite + Chroma 하이브리드 벡터 검색. 프로젝트별 데이터 격리, MCP 프로토콜로 Chroma 연동.

**Capability**: 세션 관리(시작/종료), 프롬프트/응답/도구 사용 저장, 시맨틱 검색(하이브리드: SQLite LIKE + Chroma semantic). 웹 대시보드, CLI 도구, Claude Desktop MCP 토올.

**아닌 것**: AI 기반 압축(claude-mem과 달리 원본 저장만), consolidation/deduplication/decay 알고리즘 없음, 중요도 평점 없음, 의미 기반 요약 미구현. 통계 기반 세션 요약만.

**결정성**: Chroma Vector DB는 비결정성(cosine distance). SQLite는 결정성(LIKE). 하이브리드 점수는 비결정성.

## 2. 차용 가능한 패턴 후보

1. **프로젝트별 격리**: SQLite/Chroma를 프로젝트별 디렉토리(~/.jikime-mem/)와 컬렉션명(`jm__${projectId}`)으로 격리 → alpha-memory의 다중 프로젝트 지원 구조에서 차용 가능.

2. **Fire-and-forget Chroma 동기화**: 메인 응답을 블로킹하지 않으면서 비동기로 벡터 DB 동기화. `.catch()` 에러 로깅만 수행.

3. **하이브리드 검색 UI**: SQLite(키워드), Chroma(의미) 선택 가능 + 기본값 hybrid. 구현 방식 아님, 컨트롤 패턴만 차용.

4. **청크 분할**: 응답 데이터를 2000자 단위로 분할하여 Chroma에 저장 → 긴 문서의 벡터화 효율성.

5. **Hook 라이프사이클**: SessionStart(context), UserPromptSubmit(prompt), PostToolUse(observation), Stop(summary) 5개 훅으로 Claude Code 통합 → naia-agent/runtime의 관찰 포인트 설계.

**MemoryProvider 관점**: 불가. jikime-mem은 Claude Code 세션 전용 메모리 플러그인이며, alpha-memory의 계층화 구조(MemorySystem → MemoryAdapter → sqlite/mem0/qdrant)와 다름. jikime-mem은 중간 Adapter 역할이 아니라 전체 스택.

## 3. 명시적으로 채택 안 할 이유

1. **모놀리식 아키텍처**: jikime-mem은 Claude Code 플러그인 + worker 서비스 + Next.js 대시보드 + Chroma MCP로 전부 압축. alpha-memory의 "zero-runtime-dep contract + reference impl" 분리 구조 위배.

2. **외부 SDK 강결합**: `@modelcontextprotocol/sdk` 하드 의존. alpha-memory의 `MemoryProvider` 인터페이스만 노출하는 구조와 충돌.

3. **AI 처리 부재**: consolidation(episodic→semantic), dedup, importance 평점 없음. alpha-memory의 4+N capability(encode/recall/consolidate/compact) 중 consolidate 미구현 → memory-provider-audit.md의 `ConsolidationCapable` 불만족.

4. **Chroma 의존성**: Vector DB가 필수. alpha-memory는 embedding provider 주입 가능, 로컬/원격 벡터 DB 선택 가능. jikime-mem은 Chroma 고정, uv+Python 3.12 시스템 의존.

5. **Claude Code 전용**: SessionStart/Stop 훅은 Claude Code 플러그인 프레임워크 고정. naia-agent는 헤드리스 런타임이므로 직접 적용 불가.

## 4. 이미 우리에 반영된 부분

**memory-provider-audit.md와의 비교**:

- `MemoryProvider`의 4개 메서드(encode/recall/consolidate/close)는 jikime-mem 구조(저장/검색/요약/정리)의 상위 추상화.
- jikime-mem의 "원본 저장만"은 audit의 "Drop `ConsolidationResult` to `void`"와 경향 유사하나, audit은 α-memory의 consolidate 구현을 기대(audit §3 참조).
- 하이브리드 검색(SQLite+Chroma)은 audit의 `EmbeddingCapable` + 기존 벡터 DB 구조와 방향 일치. 그러나 audit은 "구현은 각 adapter 선택"을 명시.

**mem0 dual audit (audit §6)**:
- jikime-mem은 mem0 의존 없음. Chroma만 사용. mem0 audit과 독립적.

**기반이 없는 부분**:
- audit의 `TemporalCapable` (Ebbinghaus decay, deepRecall) — jikime-mem은 decay 미구현.
- audit의 `ImportanceCapable` (importance scoring) — jikime-mem은 원본 저장만, 평점 없음.

## 5. R0 채택/거부/이연 권고

- **거부**: jikime-mem을 alpha-memory 또는 naia-agent/runtime의 MemoryProvider 구현으로 재사용하지 않음. 모놀리식 구조 + Claude Code 플러그인 강결합.
- **이연**: "프로젝트별 격리", "fire-and-forget 동기화", "하이브리드 검색 UI" 패턴은 설계 문서화 단계에서 검토. alpha-memory 로드맵(alpha-memory#12)과 조율 필요.
- **채택 안 함**: 현재 R0 범위(naia-agent 4-repo hub runtime 설계)에서 jikime-mem 코드 통합 불필요. Claude Code 메모리 기능은 향후 별도 마이크로서비스/플러그인으로 분리.

## 6. 열린 질문

1. naia-agent의 headless 런타임이 Claude Code 플러그인 훅 생태계와 어떻게 연동하는가? (jikime-mem 대시보드는 Claude Code 전용인가, 아니면 general LLM agent에도 적용 가능?)
2. alpha-memory의 consolidate() 구현이 AI 기반(claude-mem 스타일) 또는 휴리스틱(jikime-mem 스타일) 중 어느 방향으로 결정되었는가?
3. Chroma vs hnswlib(alpha-memory LocalAdapter) vs Qdrant 선택의 성능/비용 trade-off 재평가 필요한가? (ref-claude-mem, ref-mem0와 함께)
