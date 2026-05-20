# @nextain/agent-types

> **언어**: [English](../../../../packages/types/README.md) · 한국어 (이 파일)

Naia 생태계의 zero-runtime-dep 공개 컨트랙트 패키지.

**ESM 전용, Node ≥ 22.** TypeScript 5.0+ 필요.

이 패키지는 타입만 들어있고 런타임 코드는 없습니다. LLM SDK·파일시스템
라이브러리 같은 런타임 의존성을 끌어오지 않고도 어떤 컨슈머에서든 안전하게
의존할 수 있습니다.

## 구성

`src/index.ts` 에서 재내보내기 — 모든 export 가 타입(또는 const 타입
alias)이며, 런타임 값은 하나도 없습니다:

- **LLM 컨트랙트** (`llm.ts`) — `LLMClient`, `LLMRequest`, `LLMResponse`,
  `LLMMessage`, `LLMRole`, `LLMContentBlock`, `LLMContentDelta`,
  `LLMStreamChunk`, `LLMUsage`, `LLMImageSource`, `ToolDefinition`,
  `PromptCacheHint`, `StopReason`.
- **메모리 프로바이더** (`memory.ts`) — `MemoryProvider` 기본 컨트랙트
  (`encode` / `recall` / `consolidate` / `close`) 와 선택적 Capability
  인터페이스 (`BackupCapable`, `EmbeddingCapable`, `KnowledgeGraphCapable`,
  `ImportanceCapable`, `ReconsolidationCapable`, `TemporalCapable`,
  `ContradictionFilterCapable`, `SessionRecallCapable`, `CompactableCapable`)
  및 `isCapable()` 구조적 가드.
- **이벤트** (`event.ts`) — `Event`, `ErrorEvent`, `Severity`.
- **Voice / observability / session / approval / host** — `voice.ts`,
  `observability.ts` (`Logger`, `Tracer`, `Meter`), `session.ts`,
  `approval.ts` (`ApprovalBroker`), `host.ts` (`HostContext`,
  `HostContextCore`, `DeviceIdentity`).
- **툴 실행** (`tool.ts`) — `ToolExecutor`, `ToolInvocation`,
  `ToolExecutionResult`, `ToolExecutionContext`, `ToolDefinitionWithTier`,
  `TierLevel`, `TierPolicy`.
- **Hybrid Wrapper 추가분 (R4, 2026-04-26)** — `stream.ts`
  (`NaiaStreamChunk` 통합 멀티모달 스트림), `sub-agent.ts`,
  `verification.ts`, `workspace.ts`.
- **Background / Active brain (R4 #26)** — `spike.ts`.

### Slice 3-XR 시리즈 반영 사항

Slice 3-XR 시리즈에서 다음 추가분이 합쳐졌습니다 (모두 하위 호환 — 기존
discriminated union 에 새 union arm 추가 없음, 선택 필드만 추가):

- **`MemoryProvider` 확장** — naia-memory 와의 R2.5 정렬:
  `RecallOpts` 에 `project` / `sessionId` 추가; `MemoryHit` 에 `createdAt` /
  `updatedAt` 추가; `ConsolidationSummary` 에 `factsUpdated` /
  `episodesProcessed` 추가; `EncodeOpts` 신설; `BackupCapable` 가 password
  필수(AES-256-GCM 방식); `ReconsolidationCapable.findContradictions` 는
  새 content + 선택적 existing ID 목록을 받음; `TemporalCapable.applyDecay`
  가 prune 개수를 반환; `recallWithHistory` 는 `atTimestamp` 가 필수이며
  `RecallOpts` 전체 모양을 받음.
- **툴 정의 모양** — `ToolDefinitionWithTier` (D10) 에
  `isConcurrencySafe`, `isDestructive`, `searchHint`, `contextSchema` 추가;
  `ToolExecutionContext` (D11) 에 sub-agent 슈퍼바이저 게이트용 `tier` 와
  `env` 추가.
- **스트림 청크 타입** — `LLMStreamChunk` (Anthropic SSE 모양 — start /
  content_block_start / content_block_delta\* / content_block_stop / usage /
  end) 와, 더 넓은 `NaiaStreamChunk` union 이 멀티모달 delta
  (`audio_delta`, `image_delta`), sub-agent 라이프사이클
  (`session_start` / `session_progress` / `session_end` /
  `session_aggregated`), 워크스페이스 가시성 (`workspace_change`), 검증
  (`verification_start` / `verification_result`), 정직 보고
  (`report`), 적대적 리뷰
  (`review_request` / `review_finding`) 를 추가.
- **Manifest / host wiring** — 가벼운 호스트와 프로덕션 호스트를 위한
  `HostContext` / `HostContextCore` 분리; `DeviceIdentity` 가 호스트에서
  보관하는 Ed25519 키로 서명. CLI 진입점은 환경/naia-adk 매니페스트에서
  프로바이더 + 메모리 설정을 읽어 시작 시 `HostContext` 를 조립합니다 —
  LLM 쪽은 `@nextain/agent-providers` 참고.

## 사용 예

```typescript
import type { LLMClient, MemoryProvider, Event } from "@nextain/agent-types";

function makeAgent(llm: LLMClient, memory: MemoryProvider) {
  // ... 구현 코드는 다른 곳에 있습니다. 이 패키지는 형태만 정의합니다.
}
```

## Naia 4-repo 생태계의 일부

- [naia-agent](https://github.com/nextain/naia-agent) — 런타임 엔진 (이 레포)
- [naia-os](https://github.com/nextain/naia-os) — Tauri 데스크톱 셸
- [naia-adk](https://github.com/nextain/naia-adk) — 워크스페이스 포맷 + 스킬 라이브러리
- [naia-memory](https://github.com/nextain/naia-memory) — `MemoryProvider` 레퍼런스 구현

## 라이선스

Apache 2.0.
