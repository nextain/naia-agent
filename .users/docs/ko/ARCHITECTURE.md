# naia-agent 아키텍처

> **언어**: [English](../../../docs/ARCHITECTURE.md) · 한국어 (이 파일)

> **R4(`architecture-hybrid.md`)에 의해 supersede됨** — 이 문서는 R0~R3 canonical 기록(v0.1.0 freeze, 2026-04-21)입니다. Hybrid Wrapper 아키텍처(R4 lock, 2026-04-26)는 `docs/architecture-hybrid.md`에 있고 additive입니다. 두 문서는 의도적으로 공존합니다: F06(immutable 설계 결정 보존)에 따라 R0~R3 결정은 역사 기록으로 여기 보존됩니다. 신규 결정은 matrix 또는 R4 문서로 들어갑니다. **현재 아키텍처는 `architecture-hybrid.md`를 먼저 읽으세요.**

상태: Phase 1 freeze (v0.1.0, 2026-04-21). 요약 수준 문서이며, 정규
SoT는 `alpha-adk/.agents/progress/naia-4repo-migration-plan.md` (Part A)
입니다.

## 철학 — 의존이 아닌 인터페이스

네 개의 Naia 레포(`naia-os`, `naia-agent`, `naia-adk`, `naia-memory`)는
**공개된 인터페이스**로만 결합하며 런타임 의존으로 결합하지 않습니다.

- **투명** — 모든 인터페이스가 `@nextain/agent-types`,
  `@nextain/agent-protocol`, `@naia-adk/skill-spec` 중 하나에 명세됨.
  문서화·버전관리·공개.
- **비결속** — 동반 레포는 런타임을 import 하지 않습니다. 계약만
  구현하고, 호스트가 구체 구현을 주입합니다.
- **추상** — LLM provider, memory backend, skill 소스, 호스트 무엇이든
  교체 가능. 나머지는 변경되지 않음.

생태계 규모의 Ports & Adapters입니다.

## 레포 맵

| Repo | 역할 |
|------|------|
| `naia-os` | Host — Tauri shell, 3D avatar, OS 이미지 (Bazzite) |
| **`naia-agent`** (이 레포) | Runtime 엔진, LLMClient 구현, observability 기본값 |
| `naia-adk` | 워크스페이스 포맷 + skills 라이브러리 (`@naia-adk/skill-spec`) |
| `naia-memory` | `MemoryProvider` 레퍼런스 구현 |

## 패키지 맵 (naia-agent, R0~R3)

아래 R0~R3 레이아웃은 v0.1.0 freeze 시점의 canonical 패키지 맵입니다.
R4는 `adapters/`, `workspace/`, `verification/`, `memory/`, `apps/cli/`
를 추가하고 일부 패키지를 demote합니다 (live 맵은
`architecture-hybrid.md` §2; 현재 디스크 레이아웃:
`adapter-opencode-acp`, `adapter-opencode-cli`, `adapter-shell`,
`cli-app`, `core`, `observability`, `protocol`, `providers`, `runtime`,
`types`, `verification`, `workspace`).

```
@nextain/agent-types       — contracts (zero-runtime-dep)
@nextain/agent-protocol    — wire protocol (zero-runtime-dep)
@nextain/agent-core        — runtime loop + dispatch (WIP)
@nextain/agent-runtime     — tool exec + skill loader (future)
@nextain/agent-providers   — LLMClient 구현 (오늘 시점: AnthropicClient)
@nextain/agent-messengers  — channel adapters (future — Discord/TG)
@nextain/agent-observability — Logger/Tracer/Meter 기본 구현
@nextain/agent-cli         — bin 진입점 (future)
@nextain/agent-tts         — TTS 패키지 (Phase 2 X7)
@nextain/agent-testing     — 테스트 fixtures (future)
```

공개 계약은 세 패키지에 거주합니다:

| 패키지 | 내용 |
|---------|----------|
| `@nextain/agent-types` | LLMClient, MemoryProvider, Event, ErrorEvent, VoiceEvent, TierLevel, ToolExecutor, ApprovalBroker, HostContext, Logger/Tracer/Meter — 컨슈머가 필요한 모든 것 |
| `@nextain/agent-protocol` | StdioFrame + encode/parse. 분리되어 있어 wire break가 types MAJOR를 강제하지 않음. |
| `@naia-adk/skill-spec` | SkillDescriptor, SkillLoader, SkillManifest. skills가 워크스페이스 포맷 관심사이지 런타임 관심사가 아니므로 naia-adk 레포에 거주. |

## 의존성 그래프 (cycle 없음)

```
types, protocol, skill-spec   ← zero-runtime-dep, 런타임 간 cross-dep 없음
      ▲       ▲       ▲
      │       │       │
     (계약 패키지 간 type-only import 허용)
      │       │       │
core, runtime, providers, messengers, observability   ← impl 패키지
      ▲
      │ embeds
      │
   naia-os shell / CLI host
```

규칙:

- 계약 패키지(`types`, `protocol`, `skill-spec`)는 zero-runtime-dep.
- 구현 패키지는 계약 패키지를 자유롭게 import.
- 계약 패키지는 구현 패키지를 **절대** import하지 않음.
- `@naia-adk/skill-spec`은 `@nextain/agent-types`의 `TierLevel`을 import
  하지 않고 자체 `SkillTier`를 정의(동일 값) — claude-code/opencode/codex
  컨슈머에 대해 skill-spec을 tool-agnostic하게 유지.

## 런타임 레이어

```
[L1] Host               naia-os / CLI / server
                        프로세스, I/O, 의존성 주입                       ↑ embeds
───────────────────────────────────────────────────────────────────────
[L2] Agent (이 레포)    naia-agent
                        Loop · tools · compaction · hot memory          ↓ calls
───────────────────────────────────────────────────────────────────────
[L3] LLM Client         LLMClient 인터페이스 (+ adapters)
                        구체: Gateway / Direct / Mock                   ↓ HTTP
───────────────────────────────────────────────────────────────────────
[L4] Routing Gateway    any-llm 또는 동등 게이트웨이
                        provider 선택 · fallback · auth                 ↓
───────────────────────────────────────────────────────────────────────
[L5] Providers          Anthropic / OpenAI / Google / 로컬 모델
```

agent는 주입된 `LLMClient` 인터페이스에만 의존합니다. 어떤 provider인지,
게이트웨이인지, 네트워크 프로토콜인지 알지 못합니다.

## 계약 요약

정규 정의는 각 패키지의 소스 + README를 참조. 간단 목록:

**`LLMClient`** — `generate(req) → Response` 와 `stream(req) → AsyncIterable<Chunk>`. 스트리밍, tool-call, prompt cache 포함. [llm.ts](../../../packages/types/src/llm.ts)

**`MemoryProvider`** — `encode / recall / consolidate / close` + 7개 선택적 Capability(Backup, Embedding, KnowledgeGraph, Importance, Reconsolidation, Temporal, SessionRecall). [memory.ts](../../../packages/types/src/memory.ts)

**`ToolExecutor`** — `execute(invocation, signal) → result`. Tier 게이트. [tool.ts](../../../packages/types/src/tool.ts)

**`ApprovalBroker`** — `decide(request) → decision`. Shell이 UI 소유, runtime이 state 소유. [approval.ts](../../../packages/types/src/approval.ts)

**`HostContext`** — 의존성 주입 표면(llm, memory, tools, approvals, identity, logger, tracer, meter). 최소 부분 집합 `HostContextCore` 제공. [host.ts](../../../packages/types/src/host.ts)

**`Event` / `ErrorEvent` / `VoiceEvent`** — observability 백본. 모든 구현은 주요 state 전환에서 emit MUST. `ErrorEvent.severity`는 `TierLevel`과 구분(naming collision 회피). [event.ts](../../../packages/types/src/event.ts) · [voice.ts](../../../packages/types/src/voice.ts)

**`Logger` / `Tracer` / `Meter`** — observability 계약. `@nextain/agent-observability` 기본 구현: ConsoleLogger, NoopTracer, InMemoryMeter. [observability.ts](../../../packages/types/src/observability.ts)

## 버저닝 (plan A.8)

각 패키지 독립 semver. 공유 version train 없음.

- `@nextain/agent-types` — MAJOR = shape break, MINOR = additive, PATCH = internal
- `@nextain/agent-protocol` — 독립; wire break ≠ types break
- `@naia-adk/skill-spec` — 독립; naia-adk 태그와 lockstep 아님
- 구현 패키지 — 계약보다 앞서 자유롭게 이동

Breaking change는 v0.1 이후 4주 사전 공지 필요 (plan A.11 communication
정책). v0.1 이전(현재) — 잦은 breaking 예상.

## 보안 경계 (plan A.6 / A.11)

| 관심사 | 소유자 |
|---------|-------|
| 디바이스 identity (Ed25519) | shell stronghold → `HostContext.identity` 주입 |
| LLM API 키 | shell stronghold → 호스트 생성 시 `LLMClient`에 주입 |
| Discord bot token, OAuth | shell stronghold → init 시 messengers에 주입 |
| Tier T0-T3 승인 UI | shell |
| Tier 강제 | `runtime.ToolExecutor` |
| 크레딧 대시보드 | shell |
| 크레딧 사용량 emit | providers (`HostContext.meter` 경유) |
| 감사 로그 | shell (tamper-evident, 최소 보존) |
| OS-level 통합, 패키징 | shell |

## 상태 트래커 (R0~R3 freeze)

| Phase 1 | 상태 |
|---------|:---:|
| T1 `@nextain/agent-types` v0.1.0 | ✓ |
| T2 `@nextain/agent-protocol` v0.1.0 | ✓ |
| T3 `@naia-adk/skill-spec` v0.1.0 (naia-adk 레포) | ✓ |
| T4 `@nextain/agent-observability` v0.1.0 | ✓ |
| T5 `HostContext` + `VoiceEvent` + 전 계약 | ✓ |
| T6 `MemoryProvider` façade | ✓ (naia-memory audit + mem0 dual audit 완료) |
| T7 `docs/ARCHITECTURE.md` (이 파일) | ✓ |
| T8 v0.1.0 freeze — additive-only 규칙 활성 | ✓ ([CHANGELOG.md](../../../CHANGELOG.md) 참조) |

## 포인터

- **R4 live 아키텍처**: `docs/architecture-hybrid.md`
- **R4 vision (parent)**: `docs/vision-statement.md`
- 마이그레이션 plan (정규 SoT): `alpha-adk/.agents/progress/naia-4repo-migration-plan.md`
- Memory façade 감사: `docs/memory-provider-audit.md`
- 음성 파이프라인 감사: `docs/voice-pipeline-audit.md`
- README (최상위): `../README.md`
