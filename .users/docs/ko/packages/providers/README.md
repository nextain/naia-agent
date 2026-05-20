# @nextain/agent-providers

> **언어**: [English](../../../../packages/providers/README.md) · 한국어 (이 파일)

naia-agent 의 LLMClient 구현체.

**ESM 전용, Node ≥ 22.** CJS 컨슈머는 동적 `import()` 를 사용해야 합니다.

## 활성 클라이언트

`src/index.ts` 기준으로 검증:

| Export | 모듈 | 용도 |
|---|---|---|
| `VercelClient` | `./vercel` | 임의의 Vercel AI SDK `LanguageModelV2` / `LanguageModelV3` 를 감싸는 메인 경로 (D44). Anthropic, OpenAI 호환(vLLM / GLM / Z.ai), Vertex Anthropic, Google Gemini, `ai-sdk-provider-claude-code` 구독 경로 모두 여기로 들어옵니다. |
| `LabProxyClient` | `./lab-proxy` | Naia Lab Gateway HTTPS, OpenAI 호환 모양, `naiaKey` 인증. |
| `LabProxyLiveClient` | `./lab-proxy-live` | Naia Lab Gateway WSS, vllm-omni `/v1/realtime` audio_delta 경로. |

별도의 `AnthropicClient` / `GeminiClient` / `OpenAICompatClient` /
`ClaudeCliClient` export 는 더 이상 없습니다 — Slice 5.x.4 (D44) 에서
하나의 Vercel 어댑터로 통합되며 모두 제거되었습니다. 아래 마이그레이션
표 참고.

### Claude Code (구독 사용, API key 불필요)

Claude Pro/Max 구독 경로는
[`ai-sdk-provider-claude-code`](https://www.npmjs.com/package/ai-sdk-provider-claude-code)
를 `VercelClient` 가 감싸는 형태로 동작합니다. 이 프로바이더는 사용자가
이미 설치한 `claude` CLI 를 실행하면서 구독 인증을 그대로 사용하므로
`ANTHROPIC_API_KEY` 가 필요 없습니다. CLI 바이너리가 `PATH` 에 있어야
하며(샌드박스 환경에서는 `flatpak-spawn --host` 경유) 동작합니다.

## VercelClient — 메인 경로 (D44)

하나의 어댑터가 임의의 [Vercel AI SDK](https://github.com/vercel/ai)
`LanguageModelV2` 또는 `LanguageModelV3` 인스턴스를 감싸 — 단일 경로로 50+
프로바이더에 도달할 수 있습니다. 호스트가 프로바이더를 선택해서 모델을
주입하고, naia-agent 런타임은 `LLMClient` 컨트랙트만 알면 됩니다.

Vercel 생태계는 V2 ↔ V3 스펙 마이그레이션 중이며 VercelClient 는 두 버전을
모두 받습니다. 스펙 V4+ 가 나오면 어댑터를 재작성해야 합니다 (스모크
`vercel-providers-compat.integration.test.ts` 가 이를 감지).

### 설치

이 패키지는 **2-tier 의존성 모델** 을 따릅니다 (5.x.6 cross-review P0-3
에서 명확화):

1. **자동 설치 기본 번들** (이 패키지의 `optionalDependencies`, 편의를
   위해 워크스페이스 루트의 `dependencies` 에도 미러링). `pnpm add
   @nextain/agent-providers` 가 best-effort 로 설치합니다 — 특정 플랫폼에서
   하나가 빠지더라도 허용됩니다:
   - `@ai-sdk/anthropic` — Anthropic API
   - `@ai-sdk/google` — Google Gemini
   - `@ai-sdk/openai-compatible` — vLLM / vllm-omni / LM Studio / Ollama / OpenRouter / 등
   - `zhipu-ai-provider` — Z.ai coding plan / Zhipu GLM
   - `ai-sdk-provider-claude-code` — Claude Pro/Max 구독

2. **Peer 의존성** (호스트가 **반드시** 설치 — 버전 핀 권한 보유):
   - `ai` (Vercel 코어)
   - `@ai-sdk/provider` (타입 import)
   - `ws` (`LabProxyLiveClient` 사용 시에만)

B21 매트릭스 항목이 demote 된 이유: Vercel SDK 50-provider sprawl 우려가
해소되었습니다 — 본 패키지가 기본 번들로 5개만 자동 설치하고(그 외는 모두
opt-in), 호스트가 코어 버전을 핀합니다. 전체 배경은
`.agents/progress/ref-adoption-matrix.md` B21/D44 참고.

기본 번들 외 프로바이더가 필요한 외부 라이브러리 컨슈머는 peer 로 직접
설치하세요:

```bash
# 직접 API key 경로 (항상 사용 가능한 프로바이더)
pnpm add ai @ai-sdk/anthropic              # Anthropic
pnpm add ai @ai-sdk/openai                 # OpenAI
pnpm add ai @ai-sdk/google                 # Google Gemini
pnpm add ai @ai-sdk/openai-compatible      # vLLM / vllm-omni / LM Studio / Ollama / OpenRouter / 등

# CLI 구독 경로 (API key 없이 기존 구독 사용)
pnpm add ai ai-sdk-provider-claude-code    # Claude Pro/Max
pnpm add ai ai-sdk-provider-codex-cli      # ChatGPT Plus/Pro
pnpm add ai ai-sdk-provider-gemini-cli     # Gemini Code Assist

# Naia Lab / 커뮤니티
pnpm add ai zhipu-ai-provider              # Z.ai coding plan / Zhipu GLM
pnpm add ai @runpod/ai-sdk-provider        # RunPod (vLLM/SGLang)
```

### 사용 예

```typescript
import { createAnthropic } from "@ai-sdk/anthropic";
import { VercelClient } from "@nextain/agent-providers/vercel";

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const client = new VercelClient(anthropic("claude-opus-4-7"), {
  defaultMaxTokens: 8192,
});

// 단발 호출
const response = await client.generate({
  messages: [{ role: "user", content: "hello" }],
});

// 스트리밍
for await (const chunk of client.stream({
  messages: [{ role: "user", content: "tell me a story" }],
})) {
  if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
    process.stdout.write(chunk.delta.text);
  }
}
```

### 프로바이더 매트릭스 (호스트 주입 모델 팩토리)

| 프로바이더 | npm 패키지 | 인증 | 비고 |
|---|---|---|---|
| **Anthropic** | `@ai-sdk/anthropic` | `ANTHROPIC_API_KEY` | 직접 API |
| **Anthropic on Vertex** | `@ai-sdk/anthropic` (Vertex 모드) | gcloud ADC | `createVertexAnthropic({ project, location })` |
| **OpenAI** | `@ai-sdk/openai` | `OPENAI_API_KEY` | 직접 API |
| **Google Gemini** | `@ai-sdk/google` | `GEMINI_API_KEY` | 직접 API |
| **Google Vertex** | `@ai-sdk/google-vertex` | gcloud ADC | |
| **vLLM / LM Studio / Ollama / OpenRouter / 등** | `@ai-sdk/openai-compatible` | 서버별 | `baseURL` override |
| **vllm-omni (text 모드)** | `@ai-sdk/openai-compatible` | 서버별 | `/v1/chat/completions` |
| **Z.ai coding plan / Zhipu GLM** | `zhipu-ai-provider` | `ZAI_API_KEY` | `createZhipu({ baseURL: 'https://api.z.ai/api/paas/v4' })` |
| **Claude Pro/Max** | `ai-sdk-provider-claude-code` | 없음 (`claude` CLI 구독 사용) | 크로스 플랫폼 주의사항 참고 |
| **ChatGPT Plus/Pro** | `ai-sdk-provider-codex-cli` | 없음 (Codex CLI 사용) | |
| **Gemini Code Assist** | `ai-sdk-provider-gemini-cli` | 없음 (gemini-cli 사용) | |
| **RunPod** | `@runpod/ai-sdk-provider` | `RUNPOD_API_KEY` | vLLM/SGLang `baseURL` override 지원 |

### 프로바이더 resolution 우선순위 (CLI direct 모드)

`bin/naia-agent.ts` 의 `buildLLMClient()` 가 환경변수에서 **first-match-wins**
순서로 프로바이더를 결정합니다 (소스 코드 기준 검증):

1. **`ANTHROPIC_API_KEY`** → Anthropic (`@ai-sdk/anthropic`), 모델은
   `ANTHROPIC_MODEL` (기본 `claude-haiku-4-5-20251001`), 선택적으로
   `ANTHROPIC_BASE_URL` override.
2. **`OPENAI_API_KEY` + `OPENAI_BASE_URL`** → 범용 OpenAI 호환
   (`@ai-sdk/openai-compatible`), 모델은 `OPENAI_MODEL`.
3. **`GLM_API_KEY`** → Z.ai / Zhipu GLM (OpenAI 호환 경유,
   `name: "zhipu-glm"`), 모델은 `GLM_MODEL` (기본 `glm-4.5-flash`),
   `GLM_BASE_URL` 기본값 `https://open.bigmodel.cn/api/paas/v4`.
4. **`VERTEX_PROJECT_ID` + `VERTEX_REGION`** → `@ai-sdk/google` 의
   `createVertex` 로 Vertex AI 위 Anthropic, 모델은 `ANTHROPIC_MODEL`.
5. 그 외 — `naia-agent login` 또는 위 환경변수 경로를 안내하는 에러.

매니페스트 경로(`buildLLMClientFromManifest`) 는 추가로 `claude-code`
backend 를 지원하며, 이는 `ai-sdk-provider-claude-code` 를 로드해 구독
인증 흐름(API key 무관)을 사용합니다.

### 크로스 플랫폼 주의사항

Vercel AI SDK 패키지는 순수 JavaScript 라 Linux / macOS / Windows 모두
동작합니다. 특수 케이스:

- **CLI 구독 프로바이더** (`ai-sdk-provider-claude-code`, `-codex-cli`,
  `-gemini-cli`): 호스트 CLI 바이너리를 감싸므로 해당 CLI 가 `PATH` 에
  있어야 합니다. Linux/macOS 는 일반 설치, Windows 는 공식 인스톨러의
  `.cmd`/`.exe` 셰임을 사용하세요.
- **Flatpak / 샌드박스 환경**: 샌드박스된 naia-agent 프로세스가 호스트에
  설치된 CLI 를 못 볼 수 있습니다. 해결책:
  1. 직접 API key 프로바이더를 사용 (`@ai-sdk/anthropic` 등) — 호스트
     바이너리 불필요.
  2. CLI 호출을 `flatpak-spawn --host` 로 래핑 (고급).
  3. `LabProxyClient` (Naia Lab Gateway, naiaKey) 로 라우팅 — 로컬 CLI
     의존성 없음.
- **Windows 경로 이슈**: SDK 가 플랫폼 인지 경로 처리를 하므로 사용자
  코드에서 수동 변환 불필요. 특정 커뮤니티 프로바이더에서 이슈가 나오면
  그 프로바이더 레포에 이슈 등록.

## Lab Proxy 클라이언트 (Naia Lab Gateway, Vercel 비종속)

두 클라이언트는 `naiaKey` 인증으로 Naia Lab Gateway 를 통해 라우팅하며,
HTTPS/WSS 전용 naiaKey 전송과 Gateway-specific 라우팅 규칙이 들어있어
Vercel 어댑터 외부에 둡니다:

- **`LabProxyClient`** — HTTPS, OpenAI 호환 모양 (`/chat/completions`).
- **`LabProxyLiveClient`** — WSS, vllm-omni `/v1/realtime` audio_delta 경로.

```typescript
import { LabProxyClient } from "@nextain/agent-providers/lab-proxy";

const client = new LabProxyClient({
  naiaKey: process.env.NAIA_LAB_KEY!,
  gatewayUrl: "https://gateway.naia.example",
  defaultModel: "claude-opus-4-7",
});
```

## Slice 5.x.4 (D44) 제거 목록

자체 구현한 5개 클라이언트가 Vercel 백엔드 경로로 대체되며 제거되었습니다:

| 제거됨 | 대체 |
|---|---|
| `AnthropicClient` (`/anthropic`) | `VercelClient + @ai-sdk/anthropic` |
| `createAnthropicVertexClient` (`/anthropic-vertex`) | `VercelClient + @ai-sdk/anthropic` Vertex 모드 또는 `@ai-sdk/google-vertex` |
| `OpenAICompatClient` (`/openai-compat`) | `VercelClient + @ai-sdk/openai-compatible` |
| `GeminiClient` (`/gemini`) | `VercelClient + @ai-sdk/google` (또는 커뮤니티 `ai-sdk-provider-gemini-cli`) |
| `ClaudeCliClient` (`/claude-cli`) | `VercelClient + ai-sdk-provider-claude-code` |

전체 마이그레이션 배경은 프로젝트의
`.agents/progress/vercel-ai-sdk-adoption-2026-04-29.md` 참고.

## 컨트랙트

모든 클라이언트는 `LLMClient` 를 구현 — [`@nextain/agent-types`](../types)
참고.

**프로바이더별 블록 변형**: `thinking` / `redacted_thinking` 은 Anthropic
태생. Vercel SDK reasoning content (V2, V3 모두) 는 `thinking` 블록으로
매핑됩니다. 다른 프로바이더는 native content 를 알려진 LLMContentBlock
variant 중 가장 가까운 것으로 매핑하거나 어댑터 경계에서 drop —
union arm 을 새로 추가하지 않습니다.

**스펙 버전**: VercelClient 는 V2 (예: `@ai-sdk/anthropic@2.x`) 와 V3
(`@ai-sdk/google@3.x`, `@ai-sdk/openai-compatible@2.x`,
`ai-sdk-provider-claude-code@3.x`, `zhipu-ai-provider@0.3.x`) 를 받습니다.
V4+ 는 아직 지원되지 않으며 명시적 에러로 노출됩니다.

## 라이선스

Apache 2.0.
