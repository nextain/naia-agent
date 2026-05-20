# LLM Config Standard — naia-agent

> **언어**: [English](../../../docs/llm-config-standard.md) · 한국어 (이 파일)

**최초 작성**: 2026-04-25 (Slice 1c+, R3)
**최종 개정**: 2026-05-20 (Slice 3-XR-B / E / F / G 출하 — login + libsecret + 3-role 정본 + service manifest)
**Scope**: naia-agent CLI (`bin/naia-agent.ts`) + embedded host context
**Status**: stable — additive only (새 provider/key 는 MINOR, 깨는 변경은 MAJOR)

본 문서는 LLM provider 설정의 정규 표준입니다. naia-agent 및 멀티툴
하네스(CLAUDE / GEMINI / OPENCODE / CODEX mirror)가 동일 표준을
따릅니다. 외부 도구 의존은 없습니다(openclaw / Anthropic 외부 gateway
등 무관).

본문에서 사용자별 설정 디렉터리는 portable 하게 `<HOME>/.naia-agent/`
로 표기합니다. 코드 블록 안에서는 실제 shell 표기를 그대로 둡니다.

---

## 1. 환경변수 정규 (priority order)

### 1.1 Provider resolution priority

아래 순서는 `bin/naia-agent.ts` 의 `buildLLMClient()` 와 정확히
동일합니다 — 첫 매치 wins:

```
1) ANTHROPIC_API_KEY (+ optional ANTHROPIC_BASE_URL) → Anthropic 직접
2) OPENAI_API_KEY + OPENAI_BASE_URL                  → OpenAI-compat (generic)
3) GLM_API_KEY                                        → zai/Zhipu GLM (단축형)
4) VERTEX_PROJECT_ID + VERTEX_REGION                  → Anthropic on Vertex AI
5) (none)                                             → ERROR, exit 3 (CLI 에는 mock fallback 없음)
```

**규칙**: 첫 매치가 wins. 여러 키가 동시에 존재하면 위 순서에서
최상위 행을 선택합니다.

> 주의: OpenAI 분기는 `OPENAI_API_KEY` **와** `OPENAI_BASE_URL` 둘 다
> 필요합니다 — `OPENAI_API_KEY` 단독으론 의도적으로 부족(공개 OpenAI
> endpoint 우발 호출 방지). 로컬 Ollama / vLLM 은 loopback baseURL 로
> 이 분기를 거칩니다.

### 1.2 환경변수 표

| 변수 | 필수? | 기본값 | 용도 |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | (provider 1) | — | Anthropic 인증 |
| `ANTHROPIC_BASE_URL` | optional | `https://api.anthropic.com` | Anthropic-compat gateway 라우팅 |
| `ANTHROPIC_MODEL` | optional | `claude-haiku-4-5-20251001` | 모델 ID |
| `OPENAI_API_KEY` | (provider 2) | — | OpenAI-compat 인증 |
| `OPENAI_BASE_URL` | (provider 2) | — | endpoint URL |
| `OPENAI_MODEL` | optional | `glm-4.5-flash` (단축형 기본) | 모델 ID |
| `GLM_API_KEY` | (provider 3) | — | zai/Zhipu GLM 인증 (단축) |
| `GLM_BASE_URL` | optional | `https://open.bigmodel.cn/api/paas/v4` | zai endpoint |
| `GLM_MODEL` | optional | `glm-4.5-flash` | 모델 ID |
| `VERTEX_PROJECT_ID` | (provider 4) | — | GCP project (또는 `GOOGLE_CLOUD_PROJECT`) |
| `VERTEX_REGION` | (provider 4) | — | region (또는 `GOOGLE_CLOUD_LOCATION`) |
| `NAIA_ADK_PATH` | optional | — | naia-adk workspace 경로 (`naia-settings/llm.json` 탐색용) |
| `NAIA_AGENT_ENV` | optional | — | `.env` 파일 경로 override |
| `NAIA_AGENT_CONFIG` | optional | — | JSON config 파일 경로 override |
| `NAIA_AGENT_MEMORY_DB` | optional | — | `--memory` SQLite 경로 override (워크스페이스 격리) |
| `NAIA_SUB_*` / `NAIA_EMBED_*` | optional | — | `llm.json` `sub` / `embedded` 롤 노출 |

---

## 2. 3-role 정본 config (`naia-settings/llm.json`)

**크로스레포 Single Source of Truth** 는
`naia-adk/naia-settings/llm.json`. 세 개의 role + `version: 1` 입니다:

```jsonc
{
  "version": 1,
  "main":     { "provider": "openai-compat", "baseUrl": "...", "model": "...", "apiKeyRef": "OPENAI_API_KEY" },
  "sub":      { "provider": "openai-compat", "baseUrl": "...", "model": "..." },
  "embedded": { "provider": "ollama-embed", "baseUrl": "...", "model": "...", "dims": 1024 }
}
```

| Role | 용도 | 소비처 |
|---|---|---|
| `main` | 대화형 Agent LLM | `naia-agent` direct 모드 (실제 동작 agent 를 구동) |
| `sub` | Reviewer / auxiliary subagent LLM | subagent 호출 (two-tier) |
| `embedded` | 기억 recall 용 임베딩 모델 | memory host / `--memory` recall |

지원 `provider` 값: `openai-compat` | `ollama-embed` | `anthropic` |
`glm` (로컬 Ollama / vLLM 은 `openai-compat` / `ollama-embed` 로, 인증
불요).

`naia-agent` 는 `NAIA_ADK_PATH` (workspace root) 로 이 파일을 찾아,
`main` 을 §1 의 provider resolution 변수(`OPENAI_*` /
`ANTHROPIC_*` / `GLM_*`)에 매핑합니다(`process.env` 에 이미 있는
키는 건드리지 않음). `sub` / `embedded` 는 `NAIA_SUB_*` /
`NAIA_EMBED_*` 로 노출됩니다.

### 2.1 시크릿 정책 — 평문 절대 금지

`llm.json` 은 git-tracked backup unit 입니다. **raw API key 가 절대
들어가서는 안 됩니다**:

- `apiKeyRef` 는 **환경변수 NAME** (Slice A, 현재) 또는 **OS keychain
  엔트리 NAME** (Slice B, 기기키 암호화 — 출하 완료)을 담습니다. 실제
  시크릿은 `process.env` 또는 OS keychain 에 있고 — 이 파일에는 절대
  들어가지 않습니다.
- **컨벤션이 아니라 강제**: `naia-agent` 리더는 role 에 평문-시크릿-
  유사 키(`apiKey` / `key` / `token` / …) 또는 값(`sk-…` / `AIza…` /
  40-hex / …)이 있으면 `llm.json` 전체를 거부합니다(warn + skip;
  값은 로깅 안 됨). git 에 raw key 가 조용히 흘러들어가지 않도록
  거부합니다.
- 로컬 Ollama / vLLM 은 키 불요 — `apiKeyRef` 를 그냥 생략하세요
  (loopback / private `baseUrl` 은 dummy key 자동; 원격 URL 은 **자동
  적용 안 됨**).

### 2.2 레거시 JSON config (역호환, role 없음)

flat per-provider `JSON` (main / sub / embedded 분할 없음)도 역호환
용도로 여전히 허용됩니다:

```json
{
  "anthropic": {
    "apiKey": "sk-ant-...",
    "baseUrl": "https://api.anthropic.com",
    "model": "claude-haiku-4-5-20251001"
  },
  "openai": {
    "apiKey": "sk-...",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4"
  },
  "glm": {
    "apiKey": "...",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "model": "glm-4.5-flash"
  },
  "vertex": {
    "projectId": "your-gcp-project",
    "region": "us-east5"
  }
}
```

**자동 변환**: camelCase / kebab-case 키 → SCREAMING_SNAKE_CASE
환경변수.

- `anthropic.apiKey` → `ANTHROPIC_API_KEY`
- `glm.baseUrl` → `GLM_BASE_URL`
- `vertex.projectId` → `VERTEX_PROJECT_ID`

`process.env` 가 항상 wins — JSON config 는 미설정 키만 채웁니다.
**신규 배포는 §2 의 3-role `naia-settings/llm.json` 사용을 권장**
(레거시 형태보다).

---

## 3. 파일 위치 우선순위

### 3.1 `.env` 검색 (first match wins)

1. `--env <path>` CLI 플래그
2. `NAIA_AGENT_ENV` 환경변수
3. 현재 cwd 의 `.env`
4. 현재 cwd 의 `naia-agent.env` (opinionated 이름)
5. 사용자 글로벌 `.naia-agent/.env`

### 3.2 JSON config 검색

1. `--config <path>` CLI 플래그
2. `NAIA_AGENT_CONFIG` 환경변수
3. 현재 cwd 의 `.naia-agent.json`
4. 사용자 글로벌 `.naia-agent/config.json`

### 3.3 종합 우선순위

```
process.env (이미 export 됨)
   ↓ (덮어쓰지 않음 — 비어있는 키만 fill)
naia-settings/llm.json     ← 크로스레포 SoT, NAIA_ADK_PATH 로 탐색
   ↓
.env 파일 (§3.1 순서대로 첫 매치)
   ↓
JSON config 파일 (§3.2 순서대로 첫 매치)
```

`bin/naia-agent` 는 `main()` 진입 시 `loadEnvAndConfig()` 를 호출해
위 순서를 적용합니다. shell 에 이미 export 된 `process.env` 값이
항상 wins.

> 업그레이드 주의(이전 prerelease 와의 차이): `loadEnvAndConfig()`
> 가 배선되면 `.env` / `naia-agent.env` / 사용자 글로벌
> `.naia-agent/config.json` 이 *이제부터* 실제 로드됩니다(이전엔
> 로더 미호출로 무시됨). 업그레이드 전 cwd 에 무관한 `.env` 가 없는
> 지 확인하세요. shell 에 export 된 `process.env` 는 영향 없음(항상
> wins).

### 3.4 `naia-settings/llm.json` (크로스레포 정본 요약)

SoT = `naia-adk/naia-settings/README.md`. 3-role `{ main, sub, embedded }`.
`naia-agent` 는 `NAIA_ADK_PATH` 로 파일을 찾아, `main` 을 §1 의
provider resolution 변수에 매핑합니다(`process.env` 에 이미 있는
키는 건드리지 않음). `sub` / `embedded` 는 `NAIA_SUB_*` /
`NAIA_EMBED_*` 로 노출. **평문 키 금지** — `apiKeyRef`(env 변수
NAME, 또는 Slice B 이후 OS keychain 엔트리 NAME)만. 로컬 Ollama /
vLLM 은 키 불요(openai-compat resolver 가 loopback sentinel 자동
적용). 모델 / tier 분기 없음.

### 3.5 `--no-tools`

native tool-calling 미지원 모델(예: 로컬 Ollama gemma3n)용. Agent
에 도구를 0 개 부착합니다. 모델 무관 범용 플래그(특정 모델 분기
아님).

### 3.5b `--memory`

영속 장기기억 on. `@nextain/naia-memory` `LiteMemoryProvider` +
`naia-settings` `embedded` 임베더 + `<recall>` marker recall
프로토콜(naia-agent#41 v2)을 배선합니다. `--system` 미지정 시
agent 는 언어중립 recall-protocol 페르소나 + lean 기본 contract 를
받습니다. 임베더 / SQLite 실패 시 ephemeral 로 graceful degrade(크
래시 X). 기본 off — 무회귀. 모델 / 로케일 무관(소형모델 marker
leak 은 #41 caveat).

> 단일 글로벌 스토어(기본): 기본 DB 는 사용자 글로벌
> `.naia-agent/memory/cli.sqlite` 에 위치합니다. *모든* 디렉터리 /
> 프로젝트의 `--memory` 호출이 이를 공유합니다(프로젝트 A 의 사실이
> 프로젝트 B 에서 회상됨 — 의도된 개인비서 동작이자 기밀 footgun).
> 워크스페이스별 격리는 `NAIA_AGENT_MEMORY_DB=<path>` 로 분리.

### 3.6 `naia-agent login` (설정 영속 + OS keychain)

```
pnpm naia-agent login --adk <path>
  [--main "provider|baseUrl|model[|apiKeyRef]"]
  [--sub  "provider|baseUrl|model[|apiKeyRef]"]
  [--embedded "provider|baseUrl|model|dims[|apiKeyRef]"]
  [--key REF=VALUE]
```

- `<adk>/naia-settings/llm.json` 에 구조 필드만 기록 — **raw key 는
  절대 미기록**. `--key REF=VALUE` 는 **OS keychain** (Linux 에선
  libsecret / Secret Service, 기기키 암호화)에 시크릿을 저장하고
  `llm.json` 은 `apiKeyRef` 로 이름만 참조합니다.
- keychain 사용 불가 시 login 은 **거부**합니다(평문 fallback 없음)
  — shell `export` 안내. 비-Linux 에선 store 가 "unavailable" 로
  degrade — 평문 경로는 열리지 않습니다.
- `naiaAdkPath` 를 사용자 글로벌 `.naia-agent/config.json` (mode
  600) 에 영속화. **login 이후** `naia-agent` 호출은 `NAIA_ADK_PATH`
  export 없이도 `naia-settings/llm.json` 을 로드합니다(§3.4).
  env-only 모드로 되돌리려면 해당 파일을 제거하거나 안의
  `naiaAdkPath` 를 제거하세요.
- `apiKeyRef` 는 **NAME** 만 — `apiKeyRef` 슬롯에 raw 시크릿을
  넣으면 login 이 WRITE 경계에서 role 을 거부합니다(Slice 3-XR-G).
- `naia-agent show` 는 현 해석된 설정을 표시하며 시크릿 값은 절대
  출력하지 않습니다(NAME 만).

---

## 4. 보안 표준

### 4.1 파일 권한

- 사용자 글로벌 `.naia-agent/.env` 권장 모드: **600** (owner-only
  read/write).
- 프로젝트 로컬 `.env` 도 동일 권장.
- 파일 생성 후 `chmod 600` 적용.

### 4.2 `.gitignore` (모든 프로젝트 강제)

```
.env
.env.local
naia-agent.env
.naia-agent.json
.naia-agent/
```

### 4.3 노출 금지 규칙

- 코드는 키 **값** 을 stdout / stderr / log 에 절대 출력 금지
- 키 **NAME** 출력은 허용 (예: `ANTHROPIC_API_KEY loaded`)
- commit message, PR description, error message 에 키 inline 금지

### 4.4 cleanroom 단독 의존 금지 (F09)

- LLM provider 구현 시 `ref-cc-cleanroom` 라인 직접 복붙 금지
- OWASP / RFC / 공식 SDK docs 중 하나 이상을 cross-reference

---

## 5. 멀티툴 하네스 표준화

본 표준은 도구 무관:

- **Claude Code** — `AGENTS.md` mirror 가 본 표준을 가리킴; 사용자
  글로벌 `.naia-agent/.env` 자동 로드
- **opencode / Codex** — 둘 다 `AGENTS.md` 직접 읽음; 본 표준 적용
- **Gemini CLI** — `GEMINI.md` mirror 또는 `.gemini/settings.json`
  에서 본 표준 가리킴
- **naia 자체 도구** (진행 중) — `AGENTS.md` 직접 읽음; 본 표준
  적용

도구별 추가 LLM 설정은 각 도구의 `.{tool}/` 디렉터리에 두되,
**`forbidden_actions` 은 항상 본 표준을 따릅니다**.

---

## 6. 신규 provider 추가 절차

새 provider(Mistral, Cohere 등) 추가 시:

1. **환경변수 정규화**: `<PROVIDER>_API_KEY` 와 필요 시
   `<PROVIDER>_BASE_URL` / `_MODEL`.
2. **OpenAI-compat 우선 시도**: 새 provider 가 OpenAI-compat 이면
   `OPENAI_API_KEY` + `OPENAI_BASE_URL` 재사용. 추가 코드 0.
3. **non-OpenAI-compat 케이스**: `packages/providers/src/<provider>.ts`
   신설 + resolver 분기 확장.
4. **본 docs §1.2 표 update** + 크로스패키지 매트릭스(§D) 추가.
5. **example 파일 update** (`naia-agent.env.example`).
6. **PR template 매트릭스 ID 인용** (`addresses D##`).

---

## 7. 모델 명명 규약

| Provider | 형식 예시 |
|---|---|
| Anthropic 직접 | `claude-haiku-4-5-20251001`, `claude-opus-4-7` |
| Anthropic on Vertex | `claude-haiku-4-5@20251001` (Vertex 형식 — `@` 사용) |
| OpenAI / OpenAI-compat | provider 별 (`gpt-4`, `glm-4.5-flash`, `mixtral-8x7b`, …) |

`<PROVIDER>_MODEL` 환경변수로 default override.

---

## 8. `--service <manifest>` (Slice 3-XR-J / R6 / SB-1)

`--service <*.service.json 경로>` 플래그는 provider 환경변수 대신
naia-adk 형식의 **service manifest** 를 선택합니다. manifest 는 데
이터(workspace-local, Part-A contract 아님)이며, 로더는 고정 backend
enum 으로 LLM 클라이언트를 빌드합니다:

| `llm.backend` | 상태 | 인증 출처 | 비고 |
|---|---|---|---|
| `openai-compatible` | **shipped** | `OPENAI_API_KEY` 또는 `NAIA_SERVICE_API_KEY` (host env) | `baseURL` 신뢰 게이트 강제(loopback / private / operator allowlist) |
| `anthropic` | **shipped** | `ANTHROPIC_API_KEY` (host env) | `ANTHROPIC_BASE_URL` 존중 |
| `vertex` | **shipped** | `VERTEX_PROJECT_ID` + `VERTEX_REGION` (host env) | — |
| `claude-code` | **shipped** | Claude subscription (API key 없음) | `ai-sdk-provider-claude-code` 통한 in-process; subscription-credit 정책(naia-agent#39) |
| `langgraph` | reserve stub | n/a | 스키마는 값 허용; 디스패처는 Slice 3-XR-K 로 보류 |
| `rag-retriever` | reserve stub | n/a | 스키마는 값 허용; 디스패처는 Slice 3-XR-K 로 보류 |

API 키는 manifest 에서 **절대** 읽지 않습니다 — schema §4 (host env
only, 4-repo plan A.6 "LLM key = shell stronghold"). 알 수 없는
backend 는 exit 3 + stable stderr 로 fail closed.

---

## 9. 본 표준의 변경 정책

- **MINOR (additive)** — 새 provider, 새 환경변수, 새 JSON 키. 기존
  동작 모두 보존.
- **MAJOR (breaking)** — 환경변수 이름 변경, JSON shape 변경,
  resolution-order 변경.
- 본 docs `2026-04-25` 시점 = v0.1 — additive-only 규칙 시행 중.

매트릭스 cross-link:

- §A20 (env loader) — Slice 1c, file
  `packages/runtime/src/utils/env-loader.ts`
- §A21 (OpenAI-compat client) — Slice 1c+, file
  `packages/providers/src/openai-compat.ts`
- §B22 (cleanroom 라인 복붙 금지) — F09 와 cross-reference

---

## 10. 참고 — example 파일

- `naia-agent.env.example` (repo root) — `naia-agent.env` 로 복사 후
  키 입력
- `.naia-agent.example.json` (repo root) — JSON 변형, 키 입력
- 둘 다 gitignored(`*.example` suffix 만 git 에 commit)

---

## 변경 이력

- **2026-04-25** (Slice 1c+) — 초기 표준. 4 provider + `.env` /
  JSON auto-load + 보안 + 멀티툴 하네스 호환.
- **2026-05-20** (Slice 3-XR-B / E / F / G) — `naia-agent login` +
  `naia-agent show` 출하; OS keychain (libsecret) 통합; 3-role
  `naia-settings/llm.json` 이 정본 크로스레포 SoT; `--service
  <manifest>` 플래그 + backend enum (`openai-compatible` /
  `anthropic` / `vertex` / `claude-code` + 예약 `langgraph` /
  `rag-retriever`); WRITE 경계의 평문 시크릿 거부.
