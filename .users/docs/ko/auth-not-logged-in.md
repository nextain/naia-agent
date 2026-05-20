# 로그인이 안 됐다? — naia-agent provider 인증 가이드

> **언어**: [English](../../../docs/auth-not-logged-in.md) · 한국어 (이 파일)

naia-agent 는 LLM 자격증명을 **함께 배포하지 않습니다**.
**사용자 본인의** Claude / OpenAI / Gemini / GLM 구독 또는 API key
위에서 동작합니다. 사용 가능한 자격증명이 전혀 없을 경우 CLI 는
실행 가능한 안내와 함께 깔끔하게 종료하며, 활성 CLI 경로에는
silent mock fallback 이 없습니다.

## 빠른 확인 — 나는 어느 provider 에 인증되어 있는가?

| Provider (role: main / sub / embedded) | 필요한 인증 | 로그인 방법 |
|---|---|---|
| **Claude** (`claude-code` backend — 구독, API key 없음) | Claude Code 로그인 (Pro/Max/Team/Ent 플랜) **또는** `ANTHROPIC_API_KEY` | `claude` 명령으로 1회 OAuth 로그인, 또는 `export ANTHROPIC_API_KEY=...` |
| **Codex** (subagent / official SDK — ChatGPT 구독) | Codex CLI 로그인 (ChatGPT 플랜) **또는** `OPENAI_API_KEY` | Codex CLI 로 로그인, 또는 `OPENAI_API_KEY` 설정 |
| **Gemini** (**naia account / any-llm gateway** 경유, 또는 subagent 로 `gemini-cli`) | naia gateway 자격증명 (권장) **또는** `gemini-cli` OAuth (Google/Gemini 플랜) | naia gateway 사용 (`backend:"openai-compatible"` + gateway baseURL), 또는 `gemini` login |
| **GLM** (coding 플랜) | `GLM_API_KEY` | `export GLM_API_KEY=...` |
| **Ollama / vLLM** (로컬, 인증 없음) | 없음 — 로컬 엔드포인트 | 로컬 서버 실행 (`backend:"openai-compatible"` → `http://localhost:...`) |

## Claude Code 구독 (API key 없이) — `backend:"claude-code"`

Claude Pro/Max/Team/Ent 플랜 사용자가 API key 발급 없이 사용하길
원한다면, naia-agent 는 Claude Agent SDK 를 경유하는 전용
`claude-code` backend (`ai-sdk-provider-claude-code`) 를 제공합니다.
호출당 구독 크레딧 (월 한도, per-account, 2026-06-15 정책) 을
소모하며, API-key 달러가 아닙니다.

```bash
pnpm naia-agent --service ./my-app.service.json
```

manifest 예:

```jsonc
{
  "schemaVersion": "0.1.0",
  "name": "my-app",
  "llm": { "backend": "claude-code", "model": "claude-haiku-4-5-20251001" }
}
```

크레딧을 소모하지 않고 라우팅이 올바른지 확인:

```bash
NAIA_AGENT_DRYRUN=1 pnpm naia-agent --service ./my-app.service.json
```

dry-run 게이트가 dispatcher arm 을 assert 하고 (Slice 3-XR-G
`G3` DRYRUN 시나리오; Slice 3-XR-M `M2` 에서 라우팅 표면 확정)
LLM 호출 전에 종료합니다. 실제로 1턴 live 호출 (크레딧 소모)을
하려면 `NAIA_AGENT_CLAUDECODE_LIVE=1` 로 opt-in (Slice 3-XR-M
`M2`). 기본 OFF.

인증은 Claude Code CLI 자체(`claude` login / OAuth) 가 담당 —
naia-agent 는 토큰을 보거나 proxy 하지 않습니다.

## 어떤 agent CLI 에도 로그인이 안 됐다면?

- **권장**: 모든 role 에 **naia account / any-llm gateway** 를 사용
  (`backend:"openai-compatible"` + gateway `baseURL`). 자격증명
  하나로 끝, per-CLI 로그인 불필요.
- **또는** 필요한 role 의 ecosystem 중 최소 하나에 로그인.
- **main** 은 동작하는 provider 가 필요합니다. **sub / embedded** 는
  subagent / embedding 호출 — 해당 CLI 가 로그인되어 있거나
  naia gateway 로 라우팅되어야 합니다.
- **provider 가 전혀 없으면** → `naia-agent` 는 실행 가능한
  메시지와 함께 exit 3 (CLI 활성 경로에 silent mock fallback 없음).

`bin` 은 에러에 두 빠른 경로를 모두 안내합니다:

```
naia-agent: no provider configured.
  → run `pnpm naia-agent login --adk <path> --main "provider|baseUrl|model[|apiKeyRef]"`,
  → or set ANTHROPIC_API_KEY / OPENAI_API_KEY+OPENAI_BASE_URL / GLM_API_KEY,
  → or point NAIA_ADK_PATH at a naia-adk workspace with naia-settings/llm.json.
  See docs/llm-config-standard.md + docs/user-guide.md.
```

## naia-agent 가 사용자에게 알려야 하는 것 (UX 계약 — nextain/naia-agent#39 트래킹)

선택된 provider 가 인증되지 않은 경우 naia-agent 는 raw stack
trace 대신 **명확하고 실행 가능한** 메시지를 emit 합니다:

```
naia-agent: provider=claude-code not authenticated.
  → run `claude` and sign in (Pro/Max plan), or set ANTHROPIC_API_KEY,
  → or switch this role to the naia gateway (backend:"openai-compatible").
  See docs/auth-not-logged-in.md.
```

(`anthropic` / `vertex` backend 는 이미 pre-check + guide;
`claude-code` / `codex` / subagent backend 도 같은
capability-aware pre-flight + guidance — nextain/naia-agent#39
하 adversarial + structural review 로 구현됨.)

## 보안 / 정책 리마인더

- naia-agent 는 자격증명을 저장하거나 proxy 하지 않습니다. 인증은
  **사용자와 provider** (Anthropic / OpenAI / Google / Zhipu) 사이의
  관계입니다.
- distributed build 는 claude.ai/ChatGPT 로그인을 서비스로 제공할
  수 **없습니다** (provider 정책) — 각 사용자가 자신의 plan/key 로
  인증해야 합니다. nextain/naia-agent#38 (ToS / 배포) 참고.
- 구독 사용량은 **사용자 본인의** plan 크레딧에서 차감됩니다
  (예: Claude Agent SDK 월 크레딧, 2026-06-15 정책), per-account,
  pool 아님.
- API key 는 `pnpm naia-agent login --key REF=VALUE` 로 OS 키체인
  (libsecret / Secret Service) 에 device-key 암호화 저장됩니다.
  `llm.json` 에는 평문 key 가 절대 들어가지 않고, `apiKeyRef` NAME
  (env-var 또는 keychain entry) 만 들어갑니다.
