# `.users/docs/` — User-facing docs (multi-language mirror)

This directory hosts **user-facing** translations of the documents in
`docs/`. The English originals in `docs/` are the canonical engineering
SoT (read by tooling, AI maintainers, contributors). The translations
here exist for end users and Korean-first contributors.

---

## 한국어 독자 안내 (Korean Reading Guide)

### 권장 읽기 순서

| 순서 | 파일 | 내용 |
|:---:|---|---|
| 1 | [`ko/vision-statement.md`](ko/vision-statement.md) | naia-agent 란 무엇인가 — 동기·차별화·4-repo 책임 분리 |
| 2 | [`ko/architecture-hybrid.md`](ko/architecture-hybrid.md) | 현재 아키텍처 (R4 lock) — 레이어 구조·패키지 맵 |
| 3 | [`ko/user-guide.md`](ko/user-guide.md) | 빠른 시작 — CLI 설치·로그인·첫 실행 |
| 4 | [`ko/auth-not-logged-in.md`](ko/auth-not-logged-in.md) | 인증 가이드 — Claude/OpenAI/Ollama 각 provider 설정 |
| 5 | [`ko/llm-config-standard.md`](ko/llm-config-standard.md) | LLM 설정 표준 — env 우선순위·service manifest |

### 심화 문서 (필요 시)

| 파일 | 내용 |
|---|---|
| [`ko/adapter-contract.md`](ko/adapter-contract.md) | Sub-agent adapter 계약 — SubAgentAdapter·Verifier·WorkspaceWatcher |
| [`ko/stream-protocol.md`](ko/stream-protocol.md) | NaiaStreamChunk 통합 스트림 프로토콜 |
| [`ko/naia-memory-wire.md`](ko/naia-memory-wire.md) | naia-memory 연결 spec — `--memory` 플래그·서비스 모드 |
| [`ko/memory-provider-audit.md`](ko/memory-provider-audit.md) | MemoryProvider façade 감사 — capability 커버리지 |
| [`ko/log-policy.md`](ko/log-policy.md) | 로그 정책 — 레벨·포맷·redact 규칙 |
| [`ko/hosting-guide.md`](ko/hosting-guide.md) | 임베드 가이드 — naia-agent를 host에 내장하는 방법 |
| [`ko/voice-pipeline-audit.md`](ko/voice-pipeline-audit.md) | Voice 경계 선언 — naia-agent가 담당하지 않는 것 |
| [`ko/packages/types/README.md`](ko/packages/types/README.md) | `@nextain/agent-types` 패키지 가이드 |
| [`ko/packages/providers/README.md`](ko/packages/providers/README.md) | `@nextain/agent-providers` 패키지 가이드 |

### 레거시 참고 (역사 보존용)

| 파일 | 내용 |
|---|---|
| [`ko/ARCHITECTURE.md`](ko/ARCHITECTURE.md) | R0~R3 아키텍처 (v0.1.0 freeze, superseded — 현재 아키텍처는 `architecture-hybrid.md`) |

---

## Structure

```
.users/docs/
├── README.md           # this file
├── ko/                 # Korean mirrors
│   ├── vision-statement.md
│   ├── architecture-hybrid.md
│   ├── user-guide.md
│   ├── auth-not-logged-in.md
│   ├── llm-config-standard.md
│   ├── adapter-contract.md
│   ├── stream-protocol.md
│   ├── naia-memory-wire.md
│   ├── memory-provider-audit.md
│   ├── log-policy.md
│   ├── hosting-guide.md
│   ├── voice-pipeline-audit.md
│   ├── ARCHITECTURE.md     # R0~R3 legacy
│   └── packages/
│       ├── types/README.md
│       └── providers/README.md
└── (future) ja/        # Japanese
```

## Rules

1. **`docs/<file>.md` (English)** is the canonical source. Edit there first.
2. **`.users/docs/<lang>/<file>.md`** is a translation mirror. When the
   English source moves, the mirrors move with it.
3. Each translated file MUST start with a language chooser:
   ```markdown
   > **언어**: [English](../../../docs/<file>.md) · 한국어 (이 파일)
   ```
4. Cross-references inside Korean mirrors point to other Korean mirrors
   (same `ko/` folder), not back to `docs/`.
5. Stale mirrors are flagged in the file's frontmatter or top note. If
   a translation falls behind the English source, mark it explicitly.

## Why this split?

`docs/` lives under the engineering surface (AI tooling reads it, CI
gates fire on it, OSS readers expect English-first). `.users/` is the
user-facing surface — Korean, future Japanese / Chinese / etc. — and
must not gate engineering work. The two have different audiences and
different change cadences; mixing them in one directory creates the
hybrid-language confusion we just cleaned up.

## Current mirrors (Korean)

| File | KO mirror | Status |
|---|---|---|
| `docs/vision-statement.md` | [`ko/vision-statement.md`](ko/vision-statement.md) | up-to-date |
| `docs/architecture-hybrid.md` | [`ko/architecture-hybrid.md`](ko/architecture-hybrid.md) | up-to-date |
| `docs/user-guide.md` | [`ko/user-guide.md`](ko/user-guide.md) | up-to-date |
| `docs/auth-not-logged-in.md` | [`ko/auth-not-logged-in.md`](ko/auth-not-logged-in.md) | up-to-date |
| `docs/llm-config-standard.md` | [`ko/llm-config-standard.md`](ko/llm-config-standard.md) | up-to-date |
| `docs/adapter-contract.md` | [`ko/adapter-contract.md`](ko/adapter-contract.md) | up-to-date |
| `docs/stream-protocol.md` | [`ko/stream-protocol.md`](ko/stream-protocol.md) | up-to-date |
| `docs/naia-memory-wire.md` | [`ko/naia-memory-wire.md`](ko/naia-memory-wire.md) | up-to-date |
| `docs/memory-provider-audit.md` | [`ko/memory-provider-audit.md`](ko/memory-provider-audit.md) | up-to-date |
| `docs/log-policy.md` | [`ko/log-policy.md`](ko/log-policy.md) | up-to-date |
| `docs/hosting-guide.md` | [`ko/hosting-guide.md`](ko/hosting-guide.md) | up-to-date |
| `docs/voice-pipeline-audit.md` | [`ko/voice-pipeline-audit.md`](ko/voice-pipeline-audit.md) | up-to-date |
| `docs/ARCHITECTURE.md` | [`ko/ARCHITECTURE.md`](ko/ARCHITECTURE.md) | up-to-date (legacy R0~R3) |
| `docs/agent-loop-design.md` | [`ko/agent-loop-design.md`](ko/agent-loop-design.md) | up-to-date |
| `packages/types/README.md` | [`ko/packages/types/README.md`](ko/packages/types/README.md) | up-to-date |
| `packages/providers/README.md` | [`ko/packages/providers/README.md`](ko/packages/providers/README.md) | up-to-date |

## Docs NOT mirrored (English-only)

- `docs/compaction-survey.md` — in-progress slice record; KO mirror planned at slice close

Future languages (`ja/`, `zh/`, …) land under `.users/docs/<lang>/`
with the same lang-chooser pattern.
