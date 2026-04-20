[English](../README.md) | [한국어](README.ko.md)

# naia-agent

**AI 코딩 에이전트 런타임.** 임베드 가능한 라이브러리와 호스트 — 루프, 툴, compaction, 메모리, LLM 라우팅.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../LICENSE)

> ⚠️ **초기 개발 단계.** 공개 인터페이스 아직 불안정. v0.1 전까지 breaking change 예상.

## naia-agent란?

`naia-agent`는 Naia 오픈소스 AI 플랫폼의 **런타임 엔진**입니다. 호스트(데스크톱 앱, CLI, 서버)가 임베드해서 AI 코딩 에이전트 기능을 제공하는 **라이브러리**입니다.

일부러 **워크스페이스 포맷도 아니고 스토리지 시스템도 아닙니다** — 그런 것들은 각자 전담 프로젝트에 속합니다.

```
Naia 플랫폼 (레포 4개, 각자 하나의 역할)

┌──────────────────────────────┐
│  naia-os                     │  프론트엔드 — Tauri 데스크톱 셸, 3D 아바타, OS 이미지
└────────────┬─────────────────┘
             │ 임베드
┌────────────▼─────────────────┐
│  naia-agent  ← 여기          │  런타임 — 루프, 툴, compaction, LLM
└──┬───────────────────────┬───┘
   │ 읽기                  │ 읽기/쓰기
┌──▼──────────┐       ┌────▼──────────┐
│  naia-adk   │       │ alpha-memory  │
│  워크스페이스  │       │  저장소        │
│  + 스킬      │       │  + 세션        │
└─────────────┘       └───────────────┘
```

| 레포 | 역할 |
|------|------|
| [naia-os](https://github.com/nextain/naia-os) | 데스크톱 셸, 3D 아바타, OS 이미지 (Bazzite) |
| **naia-agent** (이 레포) | 런타임 엔진 — 루프, 툴, compaction, LLM 라우팅 |
| [naia-adk](https://github.com/nextain/naia-adk) | 워크스페이스 포맷 + 스킬 라이브러리 |
| [alpha-memory](https://github.com/nextain/alpha-memory) | 장기 메모리, 세션 로그 |

## 스코프

**포함:**

- 에이전트 루프 (읽기 → 판단 → 툴 → 관찰 → 반복)
- 툴 실행·디스패치
- 컨텍스트 관리와 compaction
- 세션 메모리 (hot buffer)
- 스킬 로딩·실행 (naia-adk 스킬 소비)
- LLM 클라이언트 추상화 — 프로바이더는 어댑터로 플러그인

**제외:**

- 워크스페이스 포맷·디렉터리 구조·스킬 정의 → [naia-adk](https://github.com/nextain/naia-adk)
- 장기 메모리·세션 간 저장·도구 간 공유 → [alpha-memory](https://github.com/nextain/alpha-memory)
- LLM 라우팅·Fallback·인증·크레딧 → 외부 게이트웨이 (예: [any-llm](https://github.com/nextain/any-llm))
- UI·렌더링·OS 통합 → 호스트 (예: [naia-os](https://github.com/nextain/naia-os))

## 아키텍처

`naia-agent`는 런타임 관심사(루프·툴)와 I/O 관심사(네트워크·UI)가 분리되도록 계층화되어 있습니다.

```
[L1] Host               naia-shell / CLI / server
                        프로세스, I/O, DI                          ↑ 임베드
─────────────────────────────────────────────────────────────────
[L2] Agent (여기)       naia-agent
                        루프 · 툴 · compaction · 메모리 (hot)       ↓ 호출
─────────────────────────────────────────────────────────────────
[L3] LLM Client         LLMClient 인터페이스 (+ 어댑터)
                        구현: Gateway / Direct / Mock              ↓ HTTP
─────────────────────────────────────────────────────────────────
[L4] Routing Gateway    any-llm 또는 동급
                        프로바이더 선택 · Fallback · 인증            ↓
─────────────────────────────────────────────────────────────────
[L5] Providers          Anthropic / OpenAI / Google / 로컬
```

에이전트는 주입된 `LLMClient` 인터페이스에만 의존합니다 — 어떤 프로바이더인지, 어느 게이트웨이인지, 어떤 네트워크 프로토콜인지 모릅니다. 호스트가 시작 시점에 구체 클라이언트를 주입합니다.

## 누가 naia-agent를 임베드하는가

`naia-agent`는 여러 호스트가 임베드하도록 설계됨:

- **[naia-os](https://github.com/nextain/naia-os)** — Tauri 데스크톱 앱 (플래그십 레퍼런스 호스트)
- **CLI** — `claude-code`, `opencode`, `codex`의 peer
- **HTTP 서버** — 원격·브라우저·모바일 클라이언트용
- **3rd party 앱** — AI 코딩 제품을 만드는 누구든

모든 호스트가 동일한 `naia-agent` 런타임을 소비하므로 표면(surface)과 관계없이 동작이 일관됩니다.

## 상태

- [x] 레포 생성
- [x] pnpm workspace 스캐폴드 (`packages/core`)
- [x] `LLMClient` 인터페이스 스텁
- [ ] 코어 루프 골격
- [ ] 툴 실행
- [ ] Compaction
- [ ] 스킬 로더 (naia-adk 워크스페이스 읽기)
- [ ] 메모리 클라이언트 (alpha-memory 읽기·쓰기)
- [ ] 레퍼런스 호스트: naia-os에 임베드
- [ ] CLI 호스트
- [ ] v0.1 공개 인터페이스 freeze

## 개발

```bash
pnpm install
pnpm build
```

워크스페이스 레이아웃:

```
naia-agent/
├── packages/
│   └── core/        # @naia-agent/core — 루프·툴·compaction (WIP)
├── package.json     # pnpm workspace 루트
└── tsconfig.json    # TypeScript 프로젝트 레퍼런스
```

초기 설계 논의는 [Issues](https://github.com/nextain/naia-agent/issues) 참고.

## 설계 논의

런타임을 별도 레포로 둔 이유(왜 `naia-os`나 `naia-adk` 안에 넣지 않았는가):

- **`naia-os`에 두지 않은 이유** — `naia-os`는 프론트엔드 + OS 배포 레포. 런타임을 분리해야 다른 호스트(CLI, 서버, 3rd party 앱)가 같은 엔진을 재사용 가능.
- **`naia-adk`에 두지 않은 이유** — `naia-adk`는 **워크스페이스 포맷**입니다. git 저장소나 npm 패키지와 유사 — 정적이고 이식 가능하고 툴 비종속. 런타임은 근본적으로 다름 (상태 있음, 프로세스 바운드). 섞으면 "에이전트가 작업하는 대상"과 "에이전트를 구동하는 것"의 경계가 무너짐.
- **`claude-code`/`opencode` 포크가 아닌 이유** — 그것들은 완전한 CLI 제품. `naia-agent`는 임베드되도록 설계된 라이브러리이지 독립 바이너리가 아님.

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
