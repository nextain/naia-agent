# LLM Config Standard — naia-agent

**작성일**: 2026-04-25 (Slice 1c+, R3)
**Scope**: naia-agent CLI (`bin/naia-agent.ts`) + embedded host context
**Status**: stable — additive only (semver MINOR for new providers/keys, MAJOR for breaking)

본 문서는 LLM provider 설정의 정규 표준. naia-agent + multi-tool harness(CLAUDE/GEMINI/OPENCODE/CODEX 등)가 동일 표준 따름. 외부 도구 의존 없음(openclaw/anthropic 외부 gateway 등 무관).

---

## 1. 환경변수 정규 (priority order)

### 1.1 Provider resolution priority

```
1) ANTHROPIC_API_KEY (+ optional ANTHROPIC_BASE_URL) → Anthropic 직접
2) OPENAI_API_KEY + OPENAI_BASE_URL                  → OpenAI-compat (generic)
3) GLM_API_KEY                                        → zai/Zhipu GLM (단축형)
4) VERTEX_PROJECT_ID + VERTEX_REGION                  → Anthropic on Vertex AI
5) (none)                                             → mock fallback
```

**규칙**: 첫 매치 wins. 동시 존재 시 위 순서대로.

### 1.2 환경변수 표

| 변수 | 필수? | 기본값 | 용도 |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | (provider 1) | — | Anthropic 인증 |
| `ANTHROPIC_BASE_URL` | optional | `https://api.anthropic.com` | Anthropic-compat gateway 라우팅 |
| `ANTHROPIC_MODEL` | optional | `claude-haiku-4-5-20251001` | 모델 ID |
| `OPENAI_API_KEY` | (provider 2) | — | OpenAI-compat 인증 |
| `OPENAI_BASE_URL` | (provider 2) | — | endpoint URL |
| `OPENAI_MODEL` | optional | `glm-4.5-flash` (GLM 단축 시) | 모델 ID |
| `GLM_API_KEY` | (provider 3) | — | zai/Zhipu GLM 인증 (단축) |
| `GLM_BASE_URL` | optional | `https://open.bigmodel.cn/api/paas/v4` | zai endpoint |
| `GLM_MODEL` | optional | `glm-4.5-flash` | 모델 ID |
| `VERTEX_PROJECT_ID` | (provider 4) | — | GCP project (또는 `GOOGLE_CLOUD_PROJECT`) |
| `VERTEX_REGION` | (provider 4) | — | region (또는 `GOOGLE_CLOUD_LOCATION`) |
| `NAIA_AGENT_ENV` | optional | — | .env 파일 경로 override |
| `NAIA_AGENT_CONFIG` | optional | — | JSON config 파일 경로 override |

---

## 2. JSON config shape

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

**자동 변환**: camelCase / kebab-case 키 → SCREAMING_SNAKE_CASE 환경변수.
- `anthropic.apiKey` → `ANTHROPIC_API_KEY`
- `glm.baseUrl` → `GLM_BASE_URL`
- `vertex.projectId` → `VERTEX_PROJECT_ID`

`process.env`가 항상 최우선 — JSON config는 미설정 키만 fill.

---

## 3. 파일 위치 우선순위

### 3.1 .env 검색 (first match wins)
1. `--env <path>` CLI 플래그
2. `NAIA_AGENT_ENV` 환경변수
3. `./.env` (cwd)
4. `./naia-agent.env` (cwd, opinionated 이름)
5. `~/.naia-agent/.env` (글로벌)

### 3.2 JSON config 검색
1. `--config <path>` CLI 플래그
2. `NAIA_AGENT_CONFIG` 환경변수
3. `./.naia-agent.json` (cwd)
4. `~/.naia-agent/config.json` (글로벌)

### 3.3 우선순위 종합

```
process.env (이미 export됨)
   ↓ (덮어쓰지 않음, 비어있는 키만 fill)
naia-settings/llm.json   ← 크로스레포 SoT, NAIA_ADK_PATH/naia-settings/llm.json
   ↓
.env 파일 (위 검색 순서대로 첫 매치)
   ↓
JSON config 파일 (위 검색 순서대로 첫 매치)
```

`bin/naia-agent`는 `main()` 진입 시 `loadEnvAndConfig()`를 호출해 위
순서를 실제 적용한다(이전엔 로더가 호출되지 않아 표준이 미발효였음 —
이 슬라이스에서 배선·수복).

> ⚠️ **업그레이드 주의**: 그 결과 `./.env` / `./naia-agent.env` /
> `~/.naia-agent/config.json`이 *이제부터* 실제 로드된다(이전엔 로더
> 미호출로 무시됨). 업그레이드 전 cwd에 무관한 `.env`가 없는지 확인.
> `process.env`(export된 변수)는 항상 최우선이라 영향 없음.

### 3.4 naia-settings/llm.json (크로스레포 정본)

SoT = `naia-adk/naia-settings/README.md`. 3-role `{main,sub,embedded}`.
`naia-agent`는 `NAIA_ADK_PATH`로 위치를 찾아 `main`을 위 provider
resolution 환경키(`OPENAI_*`/`ANTHROPIC_*`/`GLM_*`)로 매핑(미설정 키만),
`sub`/`embedded`는 `NAIA_SUB_*`/`NAIA_EMBED_*`로 노출. **평문 키 금지** —
`apiKeyRef`(env 변수명, Slice B에서 OS keychain)만. 로컬 Ollama/vLLM은
키 불요(openai-compat resolver용 sentinel 자동). 모델/tier 분기 없음.

### 3.5 `--no-tools`

native tool-calling 미지원 모델(예: 로컬 Ollama gemma3n)용. Agent에
도구를 부착하지 않음. 모델 무관 범용 플래그(특정 모델 분기 아님).

### 3.5b `--memory`

영속 기억 on. `@nextain/naia-memory` `LiteMemoryProvider` + naia-settings
`embedded` 임베더 + #41 `<recall>` recall. `NAIA_AGENT_MEMORY_DB`(없으면
`~/.naia-agent/memory/cli.sqlite`). `--system` 미지정 시 recall-프로토콜
페르소나 + lean 기본. 임베더/SQLite 실패 시 ephemeral로 graceful
degrade(크래시 X). 기본 off=무회귀. 모델 무관(소형모델 leak은 #41 caveat).

### 3.6 `naia-agent login` (설정 영속 + OS keychain)

```
pnpm naia-agent login --adk <path>
  [--main "provider|baseUrl|model[|apiKeyRef]"]
  [--sub  "provider|baseUrl|model[|apiKeyRef]"]
  [--embedded "provider|baseUrl|model|dims[|apiKeyRef]"]
  [--key REF=VALUE]
```

- `<adk>/naia-settings/llm.json`에 구성요소만 기록 — **키 값은 절대
  미기록**. `--key REF=VALUE`는 OS keychain(libsecret/Secret Service,
  **기기 키 암호화**)에 저장하고 `apiKeyRef`로 이름만 참조.
- keychain 불가 시 **거부**(평문 fallback 없음) — shell `export` 안내.
  비-Linux는 unavailable로 degrade(평문 경로 없음).
- `~/.naia-agent/config.json`에 `naiaAdkPath` 영속(mode 600). **주의**:
  이후 `naia-agent` 호출은 `NAIA_ADK_PATH` 없이도 naia-settings를
  자동 로드(§3.4). env-only로 되돌리려면 해당 파일/`naiaAdkPath` 제거.
- `apiKeyRef`는 *이름*만 — raw 시크릿을 넣으면 login이 쓰기 시점에 거부.

---

## 4. 보안 표준

### 4.1 파일 권한
- `~/.naia-agent/.env` 권장 mode: **600** (owner-only read/write)
- 프로젝트 단위 `.env`도 마찬가지 권장
- `chmod 600 ~/.naia-agent/.env` 명령으로 설정

### 4.2 .gitignore (모든 프로젝트 강제)
```
.env
.env.local
naia-agent.env
.naia-agent.json
.naia-agent/
```

### 4.3 노출 금지
- 코드는 키 **값**을 stdout/stderr/log에 절대 출력하지 않음
- 키 **이름**(예: `ANTHROPIC_API_KEY loaded`)만 출력 허용
- commit message, PR description, error message에 키 inline 금지

### 4.4 cleanroom 단독 의존 금지 (F09)
- LLM provider 구현 시 `ref-cc-cleanroom` 코드 라인 직접 인용 금지
- OWASP / RFC / 공식 SDK docs 출처 cross-reference 필수

---

## 5. Multi-tool harness 표준화

본 표준은 도구 무관:

- **Claude Code**: AGENTS.md mirror가 본 표준 가리킴. `~/.naia-agent/.env` 자동 로드
- **opencode / Codex**: AGENTS.md 직접 읽음 → 본 표준 적용
- **Gemini CLI**: GEMINI.md mirror 또는 `.gemini/settings.json`에서 본 표준 가리킴
- **naia 자체 도구** (향후): AGENTS.md 직접 읽음 → 본 표준 적용

도구별 추가 LLM 설정은 `.{tool}/` 디렉터리에 두되, **forbidden_actions은 본 표준 따름**.

---

## 6. 신규 provider 추가 절차

새 provider(예: Mistral, Cohere) 추가 시:

1. **환경변수 정규**: `<PROVIDER>_API_KEY` + 필요 시 `<PROVIDER>_BASE_URL` / `_MODEL`
2. **OpenAI-compat 우선 시도**: 새 provider가 OpenAI-compat이면 `OPENAI_API_KEY` + `OPENAI_BASE_URL`로 처리. 별도 코드 0
3. **OpenAI-compat 아닌 경우**: `packages/providers/src/<provider>.ts` 신설 + provider 분기 추가
4. **본 docs §1.2 표 update** + 매트릭스 §D 신규 항목 추가
5. **example config update** (`naia-agent.env.example`)
6. **PR template 매트릭스 ID 인용** (`addresses D##`)

---

## 7. 모델 명명 규약

| Provider | 형식 예시 |
|---|---|
| Anthropic 직접 | `claude-haiku-4-5-20251001`, `claude-opus-4-7` |
| Anthropic on Vertex | `claude-haiku-4-5@20251001` (Vertex 형식, `@` 사용) |
| OpenAI / OpenAI-compat | provider별 (e.g. `gpt-4`, `glm-4.5-flash`, `mixtral-8x7b`) |

`<PROVIDER>_MODEL` 환경변수로 default override 가능.

---

## 8. 본 표준의 변경 정책

- **MINOR (additive)**: 새 provider, 새 환경변수, 새 JSON 키. 기존 동작 보존
- **MAJOR (breaking)**: 환경변수 이름 변경, JSON shape 변경, 우선순위 변경
- 본 docs `2026-04-25` 시점 = v0.1 — additive-only 규칙 적용

매트릭스 § cross-link:
- §A20 (env-loader) — Slice 1c, file: `packages/runtime/src/utils/env-loader.ts`
- §A21 (OpenAI-compat client) — Slice 1c+, file: `packages/providers/src/openai-compat.ts`
- §B22 (cleanroom 라인 복붙 금지) — F09와 cross-reference

---

## 9. 참고 — example 파일

- `naia-agent.env.example` (프로젝트 root) — 사용자가 자체 키로 채워서 `naia-agent.env`로 rename
- `.naia-agent.example.json` (프로젝트 root) — JSON 사용자 채움
- 둘 다 .gitignore에 의해 commit 안 됨 (`.example` suffix만 commit 됨)

---

## 변경 이력
- **2026-04-25** (Slice 1c+): 초기 표준 정의. 4 provider + .env/JSON auto-load + 보안 + multi-tool harness 호환
