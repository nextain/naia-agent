[English](../README.md) | [한국어](README.ko.md)

# naia-agent

**AI 코딩 에이전트 런타임.** 호스트가 임베드해 AI 코딩 에이전트를 얻는 라이브러리 — 루프, 툴, compaction, 메모리, LLM 라우팅.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../LICENSE)

> **v0.1.0 — Phase 1 freeze (2026-04-21).** 공개 계약은 이 시점부터 추가만 가능(additive-only)합니다. 형태를 깨는 변경은 MAJOR 버전 상승 + 4주 사전 공지가 필요합니다 ([CHANGELOG.md](../CHANGELOG.md) 참고).

## 철학 — 의존이 아닌 인터페이스

`naia-agent`는 동반 레포들과 런타임 의존이 아니라 **공개된 인터페이스**로 연결됩니다.

- **투명함**: 모든 인터페이스는 `@nextain/agent-types`에 명세·문서화·버전 관리됩니다 — 누구나 읽거나 구현할 수 있도록 개방되어 있습니다.
- **비결속**: 동반 레포(`naia-adk`, `alpha-memory`, 호스트)는 `naia-agent`를 import하지 **않습니다**. 계약을 구현할 뿐입니다. `naia-agent`도 그들을 import하지 않으며 — 의존성 주입으로 구체 구현을 받습니다.
- **추상화**: 런타임은 어떤 LLM 프로바이더, 어떤 메모리 백엔드, 어떤 스킬 소스가 쓰이는지 전혀 모릅니다. 무엇을 바꿔도 나머지는 그대로입니다.

이는 Ports & Adapters(헥사고날) 아키텍처를 생태계 규모로 적용한 것입니다. 계약을 지키는 한 각 레포는 독립적으로 교체 가능합니다.

```
                    defines contracts
 ┌──────────────────────────────────────────┐
 │   @nextain/agent-types (published, public)  │
 │   LLMClient · MemoryProvider ·           │
 │   SkillLoader · ToolExecutor · ...       │
 └───────┬─────────────────┬────────────────┘
         │ imports only    │ imports only
         │ types           │ types
 ┌───────▼──────┐    ┌─────▼──────────┐
 │ naia-adk     │    │ alpha-memory   │   implementations
 │ (Skill       │    │ (MemoryProvider│   (no runtime dep
 │  source)     │    │  impl)         │    on naia-agent)
 └──────────────┘    └────────────────┘

 ┌─────────────────────────────────────────────┐
 │ Host (naia-os, CLI, server, 3rd-party app)  │
 │ · constructs concrete implementations       │
 │ · injects them into naia-agent runtime      │
 └─────────────────────────────────────────────┘
```

## 각 레포의 역할

### naia-os — 호스트 (프론트엔드 + OS 배포)
- **무엇인가**: Tauri 기반 데스크톱 앱 + Bazzite Linux OS 이미지.
- **무엇을 소유하나**: UI, 3D VRM 아바타, 사용자 대상 설정, OS 수준 통합(파일 선택기, 알림, OAuth stronghold), API 키 저장, 디바이스 신원, 승인 UI.
- **naia-agent와의 관계**: *호스트* — `LLMClient`, `MemoryProvider` 등 구체 구현을 생성해 시작 시 `naia-agent`에 주입.
- **독립성**: naia-agent는 naia-os 없이도 동작합니다(예: CLI나 서버 호스트 안에서). naia-os 역시 같은 stdio 프로토콜을 따르는 한 다른 런타임으로 교체할 수 있습니다.

### naia-agent — 런타임 엔진 (이 레포)
- **무엇인가**: 에이전트 루프, 툴 디스패치, 컨텍스트 관리, compaction, 스킬 실행.
- **무엇을 소유하나**: `@nextain/agent-types` 계약과 그것을 읽는 레퍼런스 구현.
- **다른 레포와의 관계**: *계약의 소비자* — 인터페이스를 통해서만 호출합니다. `naia-adk`나 `alpha-memory`의 런타임 코드를 import하지 않습니다. 프로바이더·스토리지 백엔드·UI를 직접 알지 못합니다.
- **독립성**: naia-agent는 Node.js가 도는 곳이면 어디서나 실행됩니다. 의존하는 것은 자신이 공개하는 인터페이스뿐, 그 외엔 없습니다.

### naia-adk — 워크스페이스 포맷 표준
- **무엇인가**: 도구 비종속 워크스페이스 포맷(디렉터리 레이아웃, 컨텍스트 파일, 스킬 정의). Claude Code, OpenCode, Codex, naia-agent, 향후 도구 등 어떤 AI 코딩 도구든 읽습니다.
- **무엇을 소유하나**: `.agents/`/`.users/` 디렉터리 컨벤션, `agents-rules.json` 스키마, SKILL.md 포맷, 포크 체인(`naia-adk` → `naia-business-adk` → `{org}-adk` → `{user}-adk`).
- **naia-agent와의 관계**: *소비되는 포맷*. naia-agent는 naia-adk 포맷을 읽어 스킬을 로드합니다. naia-adk는 naia-agent에 의존하지 않습니다.
- **독립성**: naia-adk는 Claude Code만, OpenCode만, 또는 임의 조합으로 쓸 수 있습니다 — 런타임 결속 없음.

### alpha-memory — 메모리 구현체
- **무엇인가**: 중요도 필터링, 지식 그래프 추출, 시간 기반 감쇠를 갖춘 메모리 시스템(episodic, semantic, procedural).
- **무엇을 소유하나**: 자체 스토리지 스키마, 4-store 아키텍처, 플러그형 벡터 백엔드.
- **naia-agent와의 관계**: *`MemoryProvider`의 한 구현*. naia-agent는 인터페이스 뒤의 블랙박스로 취급합니다. 다른 메모리 시스템이 같은 인터페이스를 구현해 대체할 수 있습니다.
- **독립성**: alpha-memory는 `@nextain/naia-memory`로 배포되며 naia-agent만이 아니라 무엇이든 사용할 수 있습니다.

## 아키텍처 (런타임 레이어)

런타임 관심사(루프, 툴)는 I/O 관심사(네트워크, UI)와 레이어로 분리됩니다:

```
[L1] Host               naia-os / CLI / server
                        Process, I/O, dependency injection           ↑ embeds
─────────────────────────────────────────────────────────────────────
[L2] Agent (this repo)  naia-agent
                        Loop · tools · compaction · hot memory        ↓ calls
─────────────────────────────────────────────────────────────────────
[L3] LLM Client         LLMClient interface (+ adapters)
                        Concrete: Gateway / Direct / Mock             ↓ HTTP
─────────────────────────────────────────────────────────────────────
[L4] Routing Gateway    any-llm or equivalent
                        Provider selection · fallback · auth          ↓
─────────────────────────────────────────────────────────────────────
[L5] Providers          Anthropic / OpenAI / Google / local models
```

에이전트는 주입된 `LLMClient` 인터페이스에만 의존합니다 — 어떤 프로바이더가, 어떤 게이트웨이가, 어떤 네트워크 프로토콜이 호출을 나르는지 전혀 알지 못합니다.

## 공개되는 인터페이스 (`@nextain/agent-types`)

모든 계약은 런타임이 없는 단일 패키지에 들어 있습니다. 누구나 구현할 수 있습니다:

### `LLMClient`
`naia-agent`가 언어 모델과 대화하는 유일한 통로. 구현체는 프로바이더를 직접(Anthropic/OpenAI/…), 게이트웨이(any-llm)로, 또는 mock(테스트)으로 감쌉니다. 스트리밍, 툴 호출, 프롬프트 캐싱이 모두 계약의 일부입니다.

### `MemoryProvider`
장기 메모리와 세션 로그. `alpha-memory`가 레퍼런스 구현입니다. 다른 것들도 같은 인터페이스를 구현할 수 있습니다 — 로컬 JSON, SQLite, 원격 벡터 DB, 커스텀 스토어.

### `SkillLoader`
워크스페이스(현재는 naia-adk 포맷, 다른 포맷으로 확장 가능)에서 스킬 정의를 읽습니다. 런타임이 디스패치할 수 있는 `SkillDescriptor` 객체를 생성합니다.

### `ToolExecutor`
개별 툴 호출(파일 I/O, 명령 실행, 네트워크, MCP 프록시)을 실행합니다. 구현체는 tier 정책(T0–T3)과 승인 플로우를 강제합니다.

### 도메인 타입
`Session`, `Conversation`, `Message`, `ToolCall`, `ToolResult`, `Event`, `CompactionPolicy`, `TokenBudget`, `TierLevel`, `ApprovalRequest`. 구현체 전반에서 안정적입니다.

모든 계약은 오픈소스로 공개됩니다. 숨겨진 확장점도, 비공개 ABI도 없습니다.

## 누가 임베드하는가

- **[naia-os](https://github.com/nextain/naia-os)** — Tauri 데스크톱 앱 (대표 레퍼런스 호스트)
- **CLI** — `claude-code`, `opencode`, `codex`의 동류
- **HTTP 서버** — 원격 / 브라우저 / 모바일 클라이언트용
- **서드파티 앱** — AI 코딩 제품을 만드는 누구든

모든 호스트가 동일한 `naia-agent` 런타임을 소비하므로, 표면이 무엇이든 동작이 일관됩니다.

## 현재 상태 — v0.1.0 (Phase 1 freeze)

**공개된 계약** (이 시점부터 추가만 가능):

- [x] `@nextain/agent-types` 0.1.0 — LLMClient / MemoryProvider / ToolExecutor / ApprovalBroker / HostContext / Event / ErrorEvent / VoiceEvent / Logger / Tracer / Meter / TierLevel / SessionLifecycle
- [x] `@nextain/agent-protocol` 0.1.0 — StdioFrame wire format
- [x] `@naia-adk/skill-spec` 0.1.0 — SkillDescriptor / SkillLoader (naia-adk 레포 내)
- [x] `@nextain/agent-providers` 0.1.0 — AnthropicClient
- [x] `@nextain/agent-observability` 0.1.0 — ConsoleLogger / NoopTracer / InMemoryMeter
- [x] `@nextain/agent-core` 0.1.0 — 계약 re-export (런타임 루프 WIP)

**Phase 2 (다음)**:

- [ ] 코어 루프 골격 (Strangler Fig X3)
- [ ] 툴 실행 런타임 (X2)
- [ ] Compaction
- [ ] 스킬 로더 (naia-adk 워크스페이스 읽기) (X4)
- [ ] MCP 브리지 (X4, #200 연속)
- [ ] stdio 프로토콜 flip-day (X5)
- [ ] 레퍼런스 호스트: naia-os 임베드 (X1 프로바이더는 이미 사용 가능)
- [ ] CLI 호스트
- [ ] 메신저 (X8)

## CLI 사용 (Slice 3-XR-E/F/G — Task #3)

`naia-agent` 는 호스트 없이 바로 쓸 수 있는 CLI 를 함께 제공합니다. 일상 흐름은 3 명령으로 충분합니다:

```bash
# 1) 설정 (디스크에 평문 키 없음 — libsecret OS keychain 사용)
pnpm naia-agent login --adk <naia-adk-path> \
  --main "openai-compat|http://127.0.0.1:11434/v1|gemma4:31b"

# 2) 확인 (값은 절대 출력 안 함 — apiKeyRef 이름만)
pnpm naia-agent show

# 3) 채팅
pnpm naia-agent --no-tools "한국어로 한 문장만 인사해줘"
```

핵심 플래그:

| 플래그 | 효과 |
|---|---|
| `--no-tools` | tool-calling 비활성화 (native function-calling 없는 모델용, 예: `gemma3n:e4b`). |
| `--enable-file-ops` | `read_file` / `write_file` / `edit_file` / `list_files` 스킬을 `bash` 와 함께 등록 (Slice 3-XR-I). |
| `--system "<text>"` | 페르소나 system rider 주입 (naia-os ChatPanel + 호스트 통합에 사용). |
| `--no-default-system` | 내장 `DEFAULT_SYSTEM_PROMPT` 생략 (소형 모델 도움, #41 v2). |
| `--memory` | 영속 `LiteMemoryProvider` (SQLite `lite_facts` + `<recall>` 마커 프로토콜). |
| `--service <manifest>` | 서비스 모드 (manifest 기반 LLM + memory + persona). |

사용자 가이드: [docs/user-guide.md](../docs/user-guide.md). LLM 설정 표준: [docs/llm-config-standard.md](../docs/llm-config-standard.md).

## 평가 & 벤치마크

`naia-agent` 는 자체 블랙박스 시나리오 하네스 + LLM-as-judge 를 함께 제공합니다 — 같은 하네스가 Ralph 루프 수렴 (`2-consecutive PASS`) 을 게이트하고서 push 합니다.

| 영역 | 파일 | 활성 시나리오 |
|---|---|---|
| 단위 (사용자 관점, CLI 플래그 메커니즘) | `packages/cli-app/src/__tests__/bin-user-scenarios.test.ts` | **22 active + 2 honest skips** (Slice 3-XR-F) |
| 통합 (ADK 생태계, LLM-as-judge) | `packages/cli-app/src/__tests__/integration-scenarios.test.ts` | **26 active + 1 dummy** (Slice 3-XR-G) |
| pi 기반 코딩 LIVE (native tool-calling) | 같은 파일의 Group P | **6 시나리오** (Slice 3-XR-I, 진행 중) |
| LLM-as-judge 하네스 | `packages/cli-app/src/__tests__/lib/llm-judge.ts` | GLM > OpenAI-compat > Anthropic; 엄격 JSON envelope; transport/parse 관용 |
| Tiered conversational recall bench (#41 v2) | `benches/conversational-recall/` | judge + harness, tier별 (8G / 24G / 48G) recall 점수 |
| Tier 비교 보고서 | `.agents/progress/tier-8g-vs-24g-comparison-2026-05-20.md` | 8G `gemma3n:e4b` vs 24G `gemma4:31b` |
| Cross-OS 호환성 sanity | `.agents/progress/cross-os-compat-results-2026-05-20.json` | 윈도 ↔ Linux 5 checks (4/5 PASS) |
| Multi-judge ensemble | (Slice 3-XR-H, 예정 — GLM + Codex + Claude verdict) | judge_disagreement_rate, provider별 편향 |

커버 그룹 (통합):

- **A** 24G 라이브 (`gemma4:31b`, thinking-mode 억제 = `Answer directly` + `max_tokens≥300`)
- **B** 코딩 동작 (프롬프트 레벨 read/explain, bug-spot, refactor)
- **C** tool-calling / pi 루프
- **E** business-adk reserve (LangGraph / RAG backend stub graceful)
- **F** naia-os 페르소나 주입 (`--system`)
- **H** 에러 처리
- **I** 보안 secret-shape 거절
- **K** 모델 비교 (e4b vs 31b)
- **P** pi 기반 코딩 LIVE (write/read/edit/list/bash + composite — Slice 3-XR-I)

보고서: `.agents/progress/integration-scenarios-{design,report,results}-2026-05-20.{md,json}`. CHANGELOG `[Slice 3-XR-*]` 항목.

정직 한계: judge 가 현재 단일 외주 (GLM HTTP). 멀티 프로바이더 ensemble (GLM + Codex CLI + Claude CLI) = Slice 3-XR-H — `feedback_pi_substrate_not_glm_only_2026_05_20` 참고.

## 개발

```bash
pnpm install
pnpm build
```

워크스페이스 레이아웃:

```
naia-agent/
├── packages/
│   ├── types/          # @nextain/agent-types — contracts
│   ├── protocol/       # @nextain/agent-protocol — wire format
│   ├── core/           # @nextain/agent-core — runtime scaffold
│   ├── providers/      # @nextain/agent-providers — AnthropicClient
│   └── observability/  # @nextain/agent-observability — defaults
├── scripts/smoke-anthropic.ts
├── package.json        # pnpm workspace root
└── tsconfig.json       # TypeScript project references
```

초기 설계 논의는 [Issues](https://github.com/nextain/naia-agent/issues)를 참고하세요.

## 왜 별도 레포로 뺐나요

- **`naia-os`에 두지 않음** — `naia-os`는 프론트엔드 + OS 배포입니다. 런타임을 분리하면 다른 호스트(CLI, 서버, 서드파티 앱)가 같은 엔진을 재사용할 수 있습니다.
- **`naia-adk`에 두지 않음** — `naia-adk`는 *워크스페이스 포맷*으로, git 레포나 npm 패키지에 가깝습니다: 정적·이식 가능·도구 비종속. 런타임은 그 반대입니다: 상태를 갖고 프로세스에 묶입니다. 둘을 섞으면 "에이전트가 무엇을 작업하는가"와 "무엇이 에이전트를 실행하는가"가 뒤섞입니다.
- **`claude-code`/`opencode`의 포크가 아님** — 그것들은 완성된 CLI 제품입니다. `naia-agent`는 독립 실행 바이너리가 아니라 임베드되도록 설계된 라이브러리입니다.

## 라이선스

Apache License 2.0. [LICENSE](../LICENSE) 참고.

```
Copyright 2026 Nextain Inc.
```

## 링크

- **Naia OS** — [github.com/nextain/naia-os](https://github.com/nextain/naia-os)
- **Naia ADK** — [github.com/nextain/naia-adk](https://github.com/nextain/naia-adk)
- **Naia Memory** (legacy: Alpha Memory) — [github.com/nextain/alpha-memory](https://github.com/nextain/alpha-memory)
- **Nextain** — [nextain.io](https://nextain.io)
