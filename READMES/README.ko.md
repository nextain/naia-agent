[English](../README.md) | [한국어](README.ko.md)

# naia-agent

**AI 코딩 에이전트 런타임.** 호스트(데스크톱 앱·CLI·서버)가 가져다 붙여 AI 코딩 에이전트를 만드는 라이브러리 — 루프·툴·compaction·메모리·LLM 라우팅.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../LICENSE)

> ⚠️ **초기 개발 중.** 공개 인터페이스가 아직 확정되지 않았습니다. v0.1 전까지는 breaking change가 있을 수 있어요.

## 철학 — 의존이 아니라 인터페이스

`naia-agent`는 동반 레포들과 **런타임 의존이 아닌 "공개된 인터페이스"로만 연결**됩니다.

- **투명합니다**: 모든 인터페이스는 `@naia-agent/types`에 명세되고 문서화되며 버전이 붙습니다. 누구든 읽고 직접 구현할 수 있어요.
- **서로 묶이지 않습니다**: `naia-adk`·`alpha-memory`·호스트들은 **`naia-agent`를 import하지 않습니다**. 그냥 계약(interface)을 구현할 뿐. `naia-agent` 역시 그들을 import하지 않습니다 — 구체 구현체를 주입받아 호출합니다.
- **추상화되어 있습니다**: 런타임은 어떤 LLM 프로바이더·메모리 백엔드·스킬 소스가 쓰이는지 모릅니다. 바꿔 끼워도 나머지가 그대로 돕니다.

Ports & Adapters(헥사고날) 아키텍처를 생태계 단위로 확장한 구조예요. 계약만 지키면 각 레포는 언제든 독립적으로 교체할 수 있습니다.

```
                     계약 정의
 ┌──────────────────────────────────────────┐
 │   @naia-agent/types (공개 퍼블리시)       │
 │   LLMClient · MemoryProvider ·           │
 │   SkillLoader · ToolExecutor · ...       │
 └───────┬─────────────────┬────────────────┘
         │ 타입만 import   │ 타입만 import
 ┌───────▼──────┐    ┌─────▼──────────┐
 │ naia-adk     │    │ alpha-memory   │   구현체
 │ (Skill       │    │ (MemoryProvider│   (naia-agent
 │  소스)       │    │  구현)         │    런타임에
 └──────────────┘    └────────────────┘    의존 안 함)

 ┌─────────────────────────────────────────────┐
 │ 호스트 (naia-os·CLI·서버·서드파티 앱)        │
 │ · 구체 구현체를 만들고                       │
 │ · 시작 시 naia-agent 런타임에 주입            │
 └─────────────────────────────────────────────┘
```

## 각 레포의 역할

### naia-os — 호스트 (프론트엔드 + OS 배포)
- **무엇인가**: Tauri 기반 데스크톱 앱 + Bazzite Linux OS 이미지.
- **담당**: UI, 3D VRM 아바타, 사용자 설정, OS 통합(파일 피커·알림·OAuth·stronghold), API 키 저장, 디바이스 아이덴티티, 승인 UI.
- **naia-agent와의 관계**: *호스트*. `LLMClient`·`MemoryProvider` 같은 구체 구현체를 만들어서 시작 시점에 `naia-agent`에 주입합니다.
- **독립성**: naia-agent는 naia-os 없이도 돕니다(CLI나 서버 호스트 안에서). naia-os도 이론상 다른 런타임으로 교체 가능 — 같은 stdio 프로토콜을 따르기만 하면.

### naia-agent — 런타임 엔진 (이 레포)
- **무엇인가**: 에이전트 루프, 툴 디스패치, 컨텍스트 관리, compaction, 스킬 실행.
- **담당**: `@naia-agent/types` 계약과 그것을 구현한 레퍼런스 런타임.
- **다른 레포와의 관계**: *계약 소비자*. 인터페이스를 통해서만 바깥과 소통합니다. `naia-adk`나 `alpha-memory`의 런타임 코드를 import하지 않아요. 프로바이더·저장소 백엔드·UI에 대한 직접 지식이 없습니다.
- **독립성**: Node.js가 도는 곳이면 어디서든 실행됩니다. 내놓는 인터페이스 외에 외부 의존이 없어요.

### naia-adk — 워크스페이스 포맷 표준
- **무엇인가**: 툴 비종속 워크스페이스 포맷 (디렉터리 구조·컨텍스트 파일·스킬 정의). Claude Code·OpenCode·Codex·naia-agent 등 어떤 AI 코딩 툴이든 읽을 수 있습니다.
- **담당**: `.agents/`·`.users/` 디렉터리 규약, `agents-rules.json` 스키마, SKILL.md 포맷, fork chain(`naia-adk` → `naia-business-adk` → `{org}-adk` → `{user}-adk`).
- **naia-agent와의 관계**: *소비되는 포맷*. naia-agent가 naia-adk 포맷을 읽어 스킬을 로드합니다. naia-adk는 naia-agent에 의존하지 않아요.
- **독립성**: Claude Code만으로, OpenCode만으로, 또는 섞어서 쓸 수 있습니다 — 특정 런타임에 묶이지 않습니다.

### alpha-memory — 메모리 구현체
- **무엇인가**: 메모리 시스템 (에피소드·시맨틱·절차적). 중요도 필터링, 지식 그래프 추출, 시간 기반 망각.
- **담당**: 자체 저장 스키마, 4-store 아키텍처, 교체 가능한 벡터 백엔드.
- **naia-agent와의 관계**: *`MemoryProvider` 인터페이스의 한 구현*. naia-agent는 인터페이스 뒤의 블랙박스로 취급. 같은 인터페이스를 구현하는 다른 메모리 시스템이면 교체 가능.
- **독립성**: `@nextain/alpha-memory`로 퍼블리시되며 naia-agent가 아닌 어떤 도구에서도 사용할 수 있습니다.

## 아키텍처 (런타임 레이어)

런타임 로직(루프·툴)과 I/O 로직(네트워크·UI)을 일부러 레이어로 분리했습니다:

```
[L1] Host               naia-os / CLI / server
                        프로세스, I/O, 의존성 주입                       ↑ 임베드
─────────────────────────────────────────────────────────────────────
[L2] Agent (이 레포)     naia-agent
                        루프 · 툴 · compaction · hot memory             ↓ 호출
─────────────────────────────────────────────────────────────────────
[L3] LLM Client         LLMClient 인터페이스 (+ 어댑터)
                        Gateway · Direct · Mock 구현체                   ↓ HTTP
─────────────────────────────────────────────────────────────────────
[L4] Routing Gateway    any-llm 같은 게이트웨이
                        프로바이더 선택 · Fallback · 인증                 ↓
─────────────────────────────────────────────────────────────────────
[L5] Providers          Anthropic / OpenAI / Google / 로컬 모델
```

에이전트는 주입받은 `LLMClient` 인터페이스만 압니다. 어떤 프로바이더·게이트웨이·프로토콜인지 모릅니다.

## 공개되는 인터페이스 (`@naia-agent/types`)

모든 계약은 런타임 의존 없는 하나의 패키지에 있습니다. 누구든 구현할 수 있어요.

### `LLMClient`
`naia-agent`가 언어모델과 이야기하는 유일한 통로. 프로바이더를 직접 감싸거나(Anthropic·OpenAI 등), 게이트웨이(any-llm)를 감싸거나, 테스트용 Mock을 쓸 수 있습니다. 스트리밍·툴콜·프롬프트 캐시가 모두 계약에 포함.

### `MemoryProvider`
장기 메모리와 세션 로그. `alpha-memory`가 레퍼런스 구현. 같은 인터페이스만 지키면 로컬 JSON·SQLite·원격 벡터 DB·자체 저장소 등 무엇이든 구현 가능.

### `SkillLoader`
워크스페이스에서 스킬 정의를 읽어옴 (지금은 naia-adk 포맷, 확장 가능). `SkillDescriptor` 객체로 변환해 런타임이 디스패치할 수 있게 만듭니다.

### `ToolExecutor`
개별 툴콜 실행 (파일 I/O·명령 실행·네트워크·MCP 프록시). 구현체가 tier 정책(T0–T3)과 승인 흐름을 강제.

### 도메인 타입
`Session`·`Conversation`·`Message`·`ToolCall`·`ToolResult`·`Event`·`CompactionPolicy`·`TokenBudget`·`TierLevel`·`ApprovalRequest`. 구현체들 사이에서 안정적으로 유지되는 타입들.

모든 계약은 오픈소스로 공개됩니다. 숨겨진 확장점도, 사적인 ABI도 없습니다.

## 누가 임베드하는가

- **[naia-os](https://github.com/nextain/naia-os)** — Tauri 데스크톱 앱 (공식 레퍼런스 호스트)
- **CLI** — `claude-code`·`opencode`·`codex`와 같은 계층의 터미널 에이전트
- **HTTP 서버** — 원격·브라우저·모바일 클라이언트용
- **서드파티 앱** — AI 코딩 제품을 만드는 누구든

모두 같은 `naia-agent`를 쓰므로, 표면(GUI·CLI·API)이 달라도 엔진 동작은 동일합니다.

## 현재 상태

- [x] 레포 생성
- [x] pnpm workspace 스캐폴드 (`packages/core`)
- [x] `LLMClient` 인터페이스 스텁
- [ ] `@naia-agent/types` 패키지 (계약들)
- [ ] 코어 루프 골격
- [ ] 툴 실행
- [ ] Compaction
- [ ] 스킬 로더 (naia-adk 워크스페이스 읽기)
- [ ] 메모리 클라이언트 (alpha-memory 래핑)
- [ ] 레퍼런스 호스트: naia-os에 임베드
- [ ] CLI 호스트
- [ ] v0.1 공개 인터페이스 freeze

## 개발

```bash
pnpm install
pnpm build
```

워크스페이스 구조:

```
naia-agent/
├── packages/
│   ├── types/       # @naia-agent/types — 계약들 (계획)
│   └── core/        # @naia-agent/core — 루프·툴·compaction (작업 중)
├── package.json     # pnpm workspace 루트
└── tsconfig.json    # TypeScript project references
```

초기 설계 논의는 [Issues](https://github.com/nextain/naia-agent/issues)에서.

## 왜 별도 레포로 뺐나요

- **`naia-os`에 두지 않은 이유** — `naia-os`는 프론트엔드와 OS 배포 레포. 런타임을 빼내야 다른 호스트(CLI·서버·서드파티)가 같은 엔진을 재사용할 수 있습니다.
- **`naia-adk`에 두지 않은 이유** — `naia-adk`는 **워크스페이스 포맷**입니다. git 저장소나 npm 패키지처럼 정적이고 이식 가능하며 툴에 종속되지 않아요. 런타임은 그 반대 — 상태가 있고 프로세스에 묶입니다. 섞으면 "에이전트가 작업하는 대상"과 "에이전트를 굴리는 엔진"의 경계가 흐려집니다.
- **`claude-code`·`opencode` 포크가 아닌 이유** — 그것들은 완성된 CLI 제품. `naia-agent`는 임베드되도록 설계된 라이브러리이지 독립 실행 바이너리가 아닙니다.

## 라이선스

Apache License 2.0. [LICENSE](../LICENSE) 참고.

```
Copyright 2026 Nextain Inc.
```

## 링크

- **Naia OS** — [github.com/nextain/naia-os](https://github.com/nextain/naia-os)
- **Naia ADK** — [github.com/nextain/naia-adk](https://github.com/nextain/naia-adk)
- **Alpha Memory** — [github.com/nextain/alpha-memory](https://github.com/nextain/alpha-memory)
- **Nextain** — [nextain.io](https://nextain.io)
