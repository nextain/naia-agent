[English](../README.md) | [한국어](README.ko.md)

> 사용자 문서 mirror: [`.users/docs/`](../.users/docs/) (다국어). 엔지니어링 문서(영문 정본)는 [`docs/`](../docs/). 기여 가이드: [CONTRIBUTING.md](../CONTRIBUTING.md).

# naia-agent

`naia-agent`는 AI 에이전트를 돌리는, 교체 가능한 런타임 엔진입니다. 에이전트를 에이전트답게 만드는 부분 — 대화 루프, 기억 회상과 저장, 토큰 예산 관리, 도구 호출 — 을 직접 소유하고, 제품마다 달라지는 부분(어떤 언어 모델을 쓸지, 어떤 기억 저장소를 쓸지, 사용자에게 어떤 화면을 보여줄지)은 전부 바깥에서 주입받습니다.

게임 엔진을 떠올리면 이해가 쉽습니다. 게임 엔진은 루프와 물리, 에셋 파이프라인을 돌리고, 그림과 레벨과 입력 장치는 개발자가 얹습니다. `naia-agent`는 에이전트 루프를 돌리고, LLM 클라이언트와 기억 백엔드와 호스트 UI는 개발자가 얹습니다. 셋 중 무엇을 바꿔도 루프는 그대로 돕니다.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../LICENSE)

## 무엇을 하는가

모든 턴은 같은 흐름을 따르며, 그 흐름은 [`packages/core/src/agent.ts`](../packages/core/src/agent.ts)의 `Agent` 클래스가 이끕니다.

**회상하고, 답하고, 기억한다.** 사용자 메시지가 들어오면 에이전트는 먼저 주입된 기억 프로바이더에게 관련 맥락을 물어, 상위 결과를 시스템 프롬프트에 얹습니다. 도구 루프를 돌려 답을 만든 다음, 사용자 메시지와 답변을 모두 기억에 다시 저장해 다음 턴이 회상할 수 있게 합니다. 기억 저장소 자체는 바깥에 있습니다. 에이전트는 `MemoryProvider` 인터페이스만 알 뿐, 그 뒤에 어떤 데이터베이스가 있는지는 모릅니다.

**등급과 승인을 갖춘 도구 루프.** 모델은 도구를 호출할 수 있고, 에이전트는 호출을 하나씩 실행해 결과를 되먹인 뒤 모델이 다음 행동을 정하게 합니다(홉 한도까지). 모든 도구는 등급(T0~T3)을 지니므로, 위험한 작업이 실행되기 전에 호스트가 사람의 승인을 요구할 수 있습니다. 도구가 계속 실패하면 에이전트는 홉 예산을 다 쓰는 대신 턴을 멈춥니다.

**맥락이 너무 커지면 압축(compaction).** 매 모델 호출 전에 에이전트는 요청 크기를 어림합니다. 토큰 예산을 넘고 기억 프로바이더가 지원하면, 에이전트는 오래된 턴을 요약해 달라고 기억에 요청하고 그 요약을 히스토리에 다시 끼워 넣습니다. 이때 자르는 지점은 항상 턴 경계라, 도구 호출이 짝을 잃는 일이 없습니다. 압축을 하고도 예산이 여전히 한계 근처면, 에이전트는 인수인계(handoff) 뭉치를 내보내 새 세션이 이어받게 할 수 있습니다.

**`<recall>` 재회상 마커.** 작은 로컬 모델은 기억을 더 달라고 네이티브 도구 호출을 내지 못하는 경우가 많습니다. 그래서 에이전트는 모델의 평범한 텍스트에서 `<recall>질의</recall>` 마커도 함께 지켜봅니다. 마커를 보면 다시 한 번 회상을 돌려 모델이 재시도하게 합니다(스스로 무한 반복하지 않도록 깊이를 제한합니다). 남은 마커 찌꺼기는 최종 답변에서 걷어냅니다.

**스킬 디렉터리와 MCP 브리지.** 에이전트는 스킬 디렉터리에서 스킬 정의를 읽어 옵니다(`--skills-dir`). 여기서 가리키는 경로는 스킬 루트 그 자체로, 스킬마다 `<이름>/SKILL.md`를 담은 디렉터리이며 `naia-adk/skills/`가 그 예입니다. 또한 Model Context Protocol(MCP)로 말하는 외부 도구를 다리 놓아 붙일 수 있습니다. 기본 제공 예시 하나는 코드 인텔리전스용 외부 [`codegraph`](https://github.com/colbymchenry/codegraph) 바이너리로 이어지는 브리지로, `--enable-codegraph`로 켭니다. 바이너리나 인덱스가 없으면 에이전트는 이를 건너뛰고 계속 진행합니다.

회상에 대해서는 과장하기 쉬우니 분명히 해 둡니다. **naia-agent에는 검색 증강 생성(RAG) 리트리버가 내장돼 있지 않습니다.** 실제로 있는 것은 (a) 위에서 설명한 외부 `codegraph` 바이너리로 가는 MCP 브리지, 그리고 (b) 지금은 `null`을 돌려주는 예약 스텁 상태인 `rag-retriever` 서비스 백엔드뿐입니다. 회상은 완성된 기능이 아니라 끼워 넣는 자리로 보시면 됩니다.

## 왜 이렇게 만들었나

전체 설계는 포트와 어댑터(헥사고날 아키텍처)를 파일이 아니라 레포 단위로 적용한 것입니다. 계약은 의존성이 없는 단일 패키지 `@nextain/agent-types`에 모여 있습니다. 나머지 전부 — LLM 프로바이더, 기억 시스템, 호스트 애플리케이션 — 는 계약을 구현하고 주입됩니다. 어떤 동반 레포도 `naia-agent`를 import하지 않고, 코어 런타임도 그들 중 무엇도 import하지 않습니다. 오직 계약을 통해서만 말합니다(단 하나의 의도된 예외는 번들 커맨드라인 호스트로, 아래에서 다룹니다). 인터페이스를 지키는 한 어느 쪽이든 갈아 끼울 수 있습니다.

바로 그 경계가 이 런타임을 이식성 있게, 또 프라이버시를 지키게 만듭니다. 호스트는 클라우드 LLM을 붙일 수도, 같은 기기의 로컬 모델을 붙일 수도 있습니다. 기억은 기기를 떠나지 않는 인프로세스 SQLite 파일을 가리킬 수도, 원격 벡터 저장소를 가리킬 수도 있습니다. 엔진은 알지도, 상관하지도 않습니다. Naia 생태계에서 이것이 핵심입니다. 모델 자체는 흔한 부품이고, 오래가는 가치는 에이전트 계층 — 기억, 맥락, 도구 정책, 그리고 그것들을 엮는 루프 — 에 있습니다.

```
                    계약 정의
 ┌──────────────────────────────────────────────┐
 │   @nextain/agent-types  (공개 배포)            │
 │   LLMClient · MemoryProvider ·                │
 │   ToolExecutor · SkillLoader · ...            │
 └───────┬──────────────────────┬───────────────┘
         │ 구현                  │ 구현
 ┌───────▼──────┐        ┌───────▼─────────┐
 │ naia-adk     │        │ naia-memory     │   (naia-agent에
 │ (스킬        │        │ (MemoryProvider │    런타임 의존
 │  포맷)       │        │  레퍼런스)      │    없음)
 └──────────────┘        └─────────────────┘

 ┌──────────────────────────────────────────────┐
 │ 호스트: naia-os · CLI · 서버 · 서드파티 앱     │
 │  구체 구현을 생성해 naia-agent 런타임에 주입   │
 └──────────────────────────────────────────────┘
```

네 레포의 역할은 깔끔하게 나뉩니다. **naia-os**는 대표 호스트로, UI·3D 아바타·API 키 저장·승인 화면을 소유하는 Tauri 데스크톱 앱입니다. 구현체를 만들어 주입합니다. **naia-agent**(이 레포)는 런타임 엔진이자 공개 계약의 정본입니다. **naia-adk**는 도구 비종속 워크스페이스 포맷(디렉터리 레이아웃, 컨텍스트 파일, 스킬 정의)으로, 어떤 AI 코딩 도구든 읽습니다. **naia-memory**는 레퍼런스 `MemoryProvider`로, 중요도 필터링과 시간 감쇠를 갖춘 에피소드/의미/절차 기억 시스템입니다. 지금은 워크스페이스 로컬 링크(`package.json`의 `file:../naia-memory`, 소스에서 직접 import)로 소비하며, 독립된 `@nextain/naia-memory` 레지스트리 배포는 예정되어 있으나 아직 이루어지지 않았습니다. 옛 문서에서는 *alpha-memory*로 부르기도 합니다.

한 가지는 분명히 짚어 둡니다. **코어 런타임은 naia-memory를 import하지 않습니다.** `MemoryProvider` 인터페이스로만 말합니다. 예외는 [`bin/naia-agent.ts`](../bin/naia-agent.ts)의 **번들 CLI**입니다. 이쪽은 `@nextain/naia-memory`를 직접 import해서, 호스트가 기억을 손수 엮지 않아도 `pnpm naia-agent --memory`가 바로 동작하게 합니다.

## 레포 구조

런타임은 열여섯 개 패키지로 이루어진 pnpm 워크스페이스입니다. 먼저 만나게 될 것들:

- `packages/types` — `@nextain/agent-types`. 런타임 의존이 없는 계약(LLMClient, MemoryProvider, ToolExecutor, SkillLoader, Session, Event 등). 나머지 전부가 이것에 의존합니다.
- `packages/core` — `@nextain/agent-core`. `Agent` 클래스: 루프, 회상/저장, 압축, 인수인계, 도구 홉 처리. 이 레포의 심장입니다.
- `packages/runtime` — `@nextain/agent-runtime`. 실전 도구들: 인메모리·목 구현, 도구 실행기, 스킬 로더, MCP 클라이언트, codegraph 브리지, CLI 헬퍼.
- `packages/cli-app` — `@nextain/agent-cli-app`. `naia-agent` 바이너리 뒤의 REPL(read-eval-print loop)과 명령 배선.
- `bin/naia-agent.ts` — 호스트 없이 도는 커맨드라인 진입점. `core` + `runtime` + `providers`를 엮고, 영속성을 위해 `naia-memory`를 import할 수 있습니다.

나머지가 그 주변을 채웁니다. `protocol`(호스트↔에이전트 와이어 포맷), `providers`(LLM 클라이언트 — 여러 프로바이더를 아우르는 Vercel AI SDK 기반 클라이언트 + Naia Lab 게이트웨이), `observability`(기본 Logger/Tracer/Meter), `naia-agent`(집약 번들 패키지), `testing`(fixture-replay 하네스), `benchmarks`, `verification`, `workspace`, 그리고 서브 에이전트 어댑터 네 종(`adapter-*` — pi, shell, opencode 두 종). 엔진이 실제로 도는 모습을 가장 명확히 보려면 [`examples/minimal-host.ts`](../examples/minimal-host.ts)를 보세요. 네트워크도 키도 없이 인프로세스 목만으로 도구 호출을 낀 2턴 대화를 끝까지 돌립니다.

## 시작하기

```bash
pnpm install
pnpm build
```

CLI를 바로 쓰려면 프로바이더 키를 저장하고 대화를 시작합니다. `login`은 비밀 값을 운영체제 키체인(리눅스 libsecret, macOS Keychain, 윈도우 DPAPI)에 맡기고, 값이 아니라 키 이름만 기록합니다. 비밀 값이 평문 파일에 쓰이거나 화면에 출력되는 일은 없습니다.

```bash
# 키 저장 (anthropic | openai | glm | vllm | ollama | claude-code)
pnpm naia-agent login --key anthropic

# 단발 실행
pnpm naia-agent "tool-hop 루프가 뭔지 두 문장으로 설명해줘."

# 세션 동안 기억 유지 (회상 + <recall> 마커 프로토콜)
pnpm naia-agent --memory "내 프로젝트 이름은 Nirvana야."

# ADK 스킬 디렉터리에서 스킬 로드 + 파일 조작 활성
pnpm naia-agent --enable-file-ops --skills-dir path/to/naia-adk/skills "..."
```

Vertex AI 위의 Anthropic은 사정이 다릅니다. 저장할 키가 없으므로 `login` 프로바이더가 아닙니다. 대신 호스트의 `VERTEX_PROJECT_ID`와 `VERTEX_REGION` 환경 변수를 CLI가 읽어 Vertex 경로로 자동 라우팅합니다.

알아 두면 좋은 플래그: `--no-tools`(도구 호출 끄기, 네이티브 함수 호출이 없는 모델용), `--enable-codegraph [경로]`(codegraph 바이너리가 있으면 브리지), `--system "..."`(페르소나 주입), `--service <manifest>`(매니페스트 기반 LLM + 기억 + 페르소나), `--repl`(대화형 강제). 전체 사용 가이드는 [docs/user-guide.md](../docs/user-guide.md), LLM 설정 표준은 [docs/llm-config-standard.md](../docs/llm-config-standard.md)에 있습니다.

처음 볼 순서: 루프는 [`packages/core/src/agent.ts`](../packages/core/src/agent.ts), 그다음 루프가 의존하는 기억 계약 [`packages/types/src/memory.ts`](../packages/types/src/memory.ts), 이어서 실제 호스트가 전부를 엮는 [`bin/naia-agent.ts`](../bin/naia-agent.ts), 마지막으로 끝까지 돌려 보는 [`examples/minimal-host.ts`](../examples/minimal-host.ts). 기여 규약은 [CONTRIBUTING.md](../CONTRIBUTING.md)에 있습니다.

테스트와 스모크 예제:

```bash
pnpm test                    # 전 패키지
pnpm smoke:agent             # examples/minimal-host.ts (목, 네트워크 없음)
pnpm smoke:naia-memory       # examples/naia-memory-host.ts (SQLite 영속)
```

## 계약 안정성

Phase 1은 공개 계약(`@nextain/agent-types`와 와이어 프로토콜)을 2026-04-21에 동결했습니다. 이후로는 추가만 가능하며, 형태를 깨는 변경은 MAJOR 버전 상승과 4주 사전 공지가 필요합니다. Phase 2 — 런타임 본체: 코어 루프, 도구 실행 런타임, 압축, 스킬 로더, MCP 브리지, CLI 호스트 — 는 구현되어 출시된 상태입니다([CHANGELOG.md](../CHANGELOG.md)의 Slice 3-XR-*와 #68 참고).

## 로드맵

몇몇 표면은 일부러 스텁으로 두고, 필요할 때 여는 상태입니다.

- **`langgraph`·`rag-retriever` 서비스 백엔드**는 예약되어 있습니다. 매니페스트 enum이 값은 받고 CLI는 우아하게 물러나지만, 실제 구현은 뒤로 미뤄져 있습니다.
- **음성 파이프라인** 연동은 naia-os / naia-omni 영역입니다. `naia-agent`는 LLM 두뇌 역할만 하고, 오디오 하드웨어·스트리밍 프로토콜·음성 서비스 내부 구현은 담지 않습니다.
- **opencode ACP 어댑터**는 Phase 2 항목입니다. Phase 1 경로는 `opencode run --format json`을 감쌉니다.

## 왜 별도 레포인가

`naia-agent`가 naia-os 안에 있지 않은 이유는, 독립 런타임이라야 다른 호스트(CLI, 서버, 서드파티 앱)가 같은 엔진을 재사용할 수 있기 때문입니다. naia-adk 안에 있지 않은 이유는, 그쪽은 정적이고 이식 가능한 *워크스페이스 포맷*인 반면 런타임은 상태를 지니고 프로세스에 묶여 있기 때문입니다. 둘을 섞으면 "에이전트가 무엇을 다루는가"와 "무엇이 에이전트를 돌리는가"가 뒤엉킵니다. 또한 `claude-code`나 `opencode`의 포크도 아닙니다. 그것들은 완결된 CLI 제품이고, `naia-agent`는 임베드되도록 설계된 라이브러리입니다.

## 라이선스

Apache License 2.0. [LICENSE](../LICENSE) 참고.

```
Copyright 2026 Nextain Inc.
```

## 링크

- **Naia OS** — [github.com/nextain/naia-os](https://github.com/nextain/naia-os)
- **Naia ADK** — [github.com/nextain/naia-adk](https://github.com/nextain/naia-adk)
- **Naia Memory** — [github.com/nextain/naia-memory](https://github.com/nextain/naia-memory)
- **Nextain** — [nextain.io](https://nextain.io)
