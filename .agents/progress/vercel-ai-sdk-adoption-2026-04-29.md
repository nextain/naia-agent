---
session_id: 4c96aad1-d830-44c7-bfcc-2d77c2dff50c
phase: R5 (Vercel AI SDK 채택 정정)
status: in_progress
created: 2026-04-29
matrix_id: D44
supersedes: D23
---

# Vercel AI SDK 채택 정정 — 2026-04-29

## 0. 한 줄 요약

D23(Vercel AI SDK 보류) silent drift 정정 → D44 (Vercel AI SDK 로컬 LLM 단일 abstraction 채택). 자체 5개 provider (`anthropic` / `anthropic-vertex` / `gemini` / `openai-compat` / `claude-cli`) → `VercelClient` adapter 1개 + community provider로 대체. **lab-proxy 계열 + D43 audio layer는 보존**.

---

## 1. Trigger (사용자 directive 2026-04-29 누적)

| # | 사용자 직접 인용 |
|---|---|
| 1 | "vercel ai sdk를 쓰면 어쨌든 llm확보가 매우 쉬워지잖아?" |
| 2 | "저 7개는 사실상 예전 naia의 프로바이더들을 잘 가져온것과 차이가 별로 없는듯" |
| 3 | "추가 확인하고 싶은건 cli들의 지원, zai coding plan 사용 가능여부, 그리고 vllm지원" |
| 4 | "우리는 vllm-omni를 중점적으로 보고 있잖아" |
| 5 | "토큰이 딸리게 생겨서 naia계정, anyllm에서 runpod을 지원할 수 있을지도 고려해야 할것 같아" |
| 6 | "우선 vercel ai sdk 적용으로 정리하고 계획 세우고 작업 진행해 / 우리 any-llm의 runpod지원은 이후에 추가 논의하자" |

→ **결정**: D23 뒤집기 + B21 격하 + D44 신규 lock. RunPod = 별도 논의 (D45 후보).

---

## 2. D23 silent drift 진단

**기록 시점 (R4 hybrid pivot, 2026-04-26)**:
> D23: Vercel AI SDK 보류 — any-llm으로 충분 (multi-provider routing은 원격 gateway). 외부 distribution 시 재검토

**근거의 결함 3건**:

1. **any-llm gateway는 원격 naia 계정 한정**. 사용자 자체 키 환경에서는 multi-provider 확보 안 됨.
2. **자체 7개 provider는 carry-over**. 이전 naia-os/agent에서 5개가 그대로, 2개만 신규 (anthropic-vertex / lab-proxy-live). registry/factory routing layer는 오히려 후퇴.
3. **B21 거부 사유는 회피 가능한 sub-concern**. (1) `@ai-sdk/<provider>`는 optional peer dep로 두면 zero-runtime-dep 정신 보존, (2) `@ai-sdk/react` hooks는 별도 패키지, naia-agent는 headless라 import 안 함.

**왜 drift?**: R4 pivot 시점 "any-llm gateway가 50+ provider routing 자체 제공" 논리에 휩쓸려 **로컬 사용자 자체 키 use case가 매트릭스에 반영되지 않음**. cross-review 4건도 D23 재검토 흔적 없음.

---

## 3. 사용자 사전 확인 사항 (모두 ✓)

| 항목 | 결과 | 출처 |
|---|---|---|
| **Claude Code CLI** | `ai-sdk-provider-claude-code` (ben-vargas, v6 stable) — Pro/Max 구독 활용 (`@anthropic-ai/claude-agent-sdk` wrap) | `refs/ref-vercel-ai-sdk/content/providers/03-community-providers/10-claude-code.mdx` |
| **Codex CLI** | `ai-sdk-provider-codex-cli` (v6 stable) — ChatGPT Plus/Pro 구독 또는 OpenAI key | `13-codex-cli.mdx` |
| **Gemini CLI** | `ai-sdk-provider-gemini-cli` (v6 stable) — Gemini Code Assist 구독 | `18-gemini-cli.mdx` |
| **opencode SDK** | `ai-sdk-provider-opencode-sdk` (v6 stable) — `@opencode-ai/sdk` wrap | `31-opencode-sdk.mdx` |
| **Z.ai coding plan** | `zhipu-ai-provider` (Xiang-CH) — `createZhipu({ baseURL: 'https://api.z.ai/api/paas/v4' })` 명시 지원 | `44-zhipu.mdx` |
| **vLLM (텍스트)** | `@ai-sdk/openai-compatible` (공식) — vLLM/SGLang/OpenAI-compat baseURL 모두 호환 | `02-openai-compatible-providers/index.mdx` |
| **vllm-omni (텍스트)** | 동일 — vllm-omni도 `/v1/chat/completions` HTTP는 OpenAI-compat |  |
| **vllm-omni `/v1/realtime` (audio_delta WSS)** | Vercel 표준 영역 **밖** → D43 자체 audio provider layer 유지 (Phase 5+) | 본 progress §6 |
| **RunPod** | `@runpod/ai-sdk-provider` (공식) — vLLM/SGLang baseURL 지원. naia 계정 gateway 통합은 **별도 (D45 후보)** | `37-runpod.mdx` |

---

## 4. 통합 아키텍처 (D44 후)

```
[로컬 LLM 텍스트]  Vercel AI SDK (`ai` core, peer dep)
  ├─ @ai-sdk/anthropic           — Anthropic API key
  ├─ @ai-sdk/openai              — OpenAI key
  ├─ @ai-sdk/google              — Google key
  ├─ @ai-sdk/google-vertex       — GCP project
  ├─ @ai-sdk/openai-compatible   — vLLM / vllm-omni 텍스트 / LM Studio / Ollama / 자가호스팅
  ├─ zhipu-ai-provider           — Z.ai coding plan + bigmodel.cn
  ├─ ai-sdk-provider-claude-code — Pro/Max 구독
  ├─ ai-sdk-provider-gemini-cli  — Gemini Code Assist 구독
  ├─ ai-sdk-provider-codex-cli   — ChatGPT Plus/Pro 구독
  ├─ ai-sdk-provider-opencode-sdk — opencode wrap (sub-agent path와 별개로 LLM path)
  └─ @runpod/ai-sdk-provider     — 사용자 자체 RunPod 키 (Path B)

  ↓ VercelClient adapter (단일 LLMClient 구현)
  ↓
naia-agent core/runtime  ← LLMClient interface로만 인지

[원격 naia 계정]    lab-proxy.ts (HTTPS) / lab-proxy-live.ts (WSS)  ← 보존
                     ↓ naia-anyllm gateway → vertexai/xai/anthropic
                     ↓ (D45 후보: + RunPod backend)

[자체 omni audio]   vllm-omni `/v1/realtime` audio_delta adapter  ← D43 자체 layer (Phase 5+)
```

**의존 방향**: naia-agent core는 `LLMClient` interface로만 인지. host(naia-os)가 어느 클라이언트(Vercel-backed / lab-proxy / D43 audio) 주입할지 선택.

---

## 5. Slice 시퀀스 (Phase 5.x — 본 progress 산출물)

각 slice는 `agents-rules.json` `required_actions_for_slice_pr` (S01~S04 + G15) 만족 강제.

### 5.x.0 — 매트릭스 + progress lock (본 commit, docs only)

- ✅ 매트릭스 D23 strikethrough + supersede 명시
- ✅ 매트릭스 B21 demoted + sub-concern 회피 명시
- ✅ 매트릭스 D44 신규 추가
- ✅ 매트릭스 K 신규 변경 이력 (R5 정정)
- ✅ 본 progress 파일 신설 + session_id 바인딩
- (S01~S04 면제: matrix_id_citation 룰의 "매트릭스 외 영역(docs, infra)" 면제 항목)

### 5.x.1 — `VercelClient` adapter MVP ✅ 완료 (commit 다음)

**핵심 작업**: `LanguageModelV2` → `LLMClient` 변환 어댑터 구현. Vercel SDK 1개 model로 우선 검증.

| 항목 | 결과 |
|---|---|
| 신규 파일 | ✅ `packages/providers/src/vercel-client.ts` (~430 LOC, `VercelClient` + 순수 헬퍼) |
| 신규 파일 | ✅ `packages/providers/src/__tests__/vercel-client.test.ts` (25 unit) |
| 신규 smoke | ✅ `scripts/smoke-vercel-anthropic.ts` (dry-run + live opt-in) |
| package.json 변경 | ✅ `peerDependencies` optional: `ai@^6` / `@ai-sdk/anthropic@^2` / `@ai-sdk/provider@^3` |
| package.json | ✅ `devDependencies` 동일 추가 + 루트 devDep 추가 (smoke script root 실행) |
| package.json `exports` | ✅ `./vercel`: `./dist/vercel-client.js` |
| index.ts | ✅ `export { VercelClient }` + `VercelClientOptions` |
| **S01 신규 명령** | ✅ `pnpm smoke:vercel-anthropic` |
| **S02 unit** | ✅ 25 신규 (LLMRequest ↔ V2 prompt / V2 content ↔ LLMContentBlock / finishReason / usage / stream id→index / 모든 stream-part 종류 / response-metadata / error / finish 누락 fallback) |
| **S03 통합** | ✅ Mock LanguageModelV2 가 실 V2 stream-part shape emit. 25 테스트가 round-trip 검증. 실 Anthropic은 ANTHROPIC_API_KEY opt-in (G15 fixture-only-default) |
| **S04** | ✅ CHANGELOG Slice 5.x.1 entry |
| 회귀 | ✅ **460 PASS** (이전 435 + 25 신규, 0 회귀) |
| 매트릭스 ID 인용 | ✅ `feat(providers): VercelClient adapter MVP — fixes D44 §1` |

**design 결정 (실 구현 lock)**:

- `VercelClient(model: LanguageModelV2, options?: { defaultMaxTokens?, logger? })` — model 1개 + 옵션. host가 `createAnthropic({apiKey})('claude-opus-4-7')` 같은 model factory 결과 주입.
- `specificationVersion !== "v2"` 면 throw — V3/V4 호환성은 미래 slice (현 `@ai-sdk/anthropic@2.0.77`이 V2 반환).
- `generate()` — `doGenerate()` 호출 후 content array → `LLMContentBlock[]` 변환. response.id / response.modelId가 있으면 사용, 없으면 random id + constructor modelId fallback.
- `stream()` — `doStream()` 의 `ReadableStream<LanguageModelV2StreamPart>` reader.read() 루프. start chunk는 lazy emit (response-metadata 받으면 그 id/modelId 사용, 받기 전에 content 시작되면 random fallback). finish 누락 시도 end chunk 항상 발행.
- V2 string `id` → 우리 numeric `index` 매핑 (Map, auto-increment). 같은 id의 start/delta/end는 같은 index 보존.
- V2 `tool-call` (aggregate) drop — `tool-input-start/delta/end` 가 동일 페이로드를 progressive로 covers + Anthropic SSE shape 보존. 둘 다 emit하면 다운스트림 중복.
- error part → `throw new Error(...)`. caller가 catch.

**미해결 → 후속 slice**:

- `thoughtSignature` (Gemini 3) round-trip — V2는 `providerMetadata` 통해 가능. Slice 5.x.3a (Gemini deprecate) 시점에 정식 wire.
- `cacheBreakpoint` 메시지 hint → V2 `providerOptions` 매핑 (Anthropic은 `cache_control`). Slice 5.x.2에서 anthropic deprecate 시 cache 정책 (D16) 적용 시점에.

### 5.x.2 — `AnthropicClient` deprecate ✅ 완료

**조사 결과 scope 축소**: bin/naia-agent.ts는 LLM provider를 직접 import하지 않음 (R4 Hybrid path로 전환되어 opencode/shell adapter만 사용). examples/는 모두 MockLLMClient. 외부 사용처는 `scripts/smoke-anthropic.ts` 1건. 따라서 Slice 5.x.2는 **bin "wiring 변경" 없음** — 순수 deprecation 표기 + README 갱신.

| 항목 | 결과 |
|---|---|
| deprecate | ✅ `packages/providers/src/anthropic.ts` — file-level + class + interface JSDoc `@deprecated`, 마이그레이션 예시 + 5.x.5 제거 명시 |
| smoke deprecate | ✅ `scripts/smoke-anthropic.ts` — `@deprecated` + `pnpm smoke:vercel-anthropic` 권고 |
| README 갱신 | ✅ `packages/providers/README.md` — VercelClient 메인 승격, 50+ provider 표, 자체 5개 "Deprecated" 섹션, lab-proxy Vercel-independent 명시 |
| **fixture (F11)** | ⊘ 미트리거 — 본 slice는 SDK bump 아니라 내부 deprecate. 기존 fixture는 generic `LLMStreamChunk[]` JSON이라 어떤 LLMClient 구현과도 무관 (StreamPlayer 가 사용) |
| 회귀 | ✅ **460 PASS** (변동 없음) |
| **S01~S04** | ⊘ 부분 면제 — 본 slice는 deprecation 표기만. 신규 명령/단위 테스트/통합 검증 없음 (5.x.1에서 도입). S04 (CHANGELOG entry) 만 충족. matrix_id_citation rule "docs/infra 변경" 면제 적용 |
| 매트릭스 ID 인용 | ✅ `chore(providers): @deprecated AnthropicClient — fixes D44 §2` |

**미해결 → 후속 slice**:

- `anthropic-vertex.ts` 는 내부적으로 `AnthropicClient` 재사용 (deprecate inherit). 5.x.3c 시점에 정식 deprecate.
- 신규 host 코드 path 없음 (R4 hybrid path가 sub-agent로 전환했음). 5.x.5에서 5 provider 일괄 제거 가능.

### 5.x.3 — Gemini / OpenAI-compat / Vertex deprecate ✅ 완료 (사용자 directive "통합")

**사용자 directive로 분할 (5.x.3a/b/c) → 통합 (단일 commit) 으로 변경.** 모두 동일 pattern (JSDoc deprecate, 시그니처 변경 없음).

| 항목 | 결과 |
|---|---|
| `gemini.ts` deprecate | ✅ file + class + interface JSDoc. API key path (`@ai-sdk/google`) + Subscription path (`ai-sdk-provider-gemini-cli`) 둘 다 명시. thoughtSignature round-trip은 Vercel `LanguageModelV2 providerMetadata`로 5.x.5 cleanup 시 검증 |
| `openai-compat.ts` deprecate | ✅ file + class + interface JSDoc. vLLM/vllm-omni/LM Studio/Ollama/OpenRouter/Together/Groq/Cerebras/DeepSeek/Fireworks/Perplexity → `@ai-sdk/openai-compatible`. Z.ai coding plan/Zhipu GLM → `zhipu-ai-provider` (`createZhipu({ baseURL: 'https://api.z.ai/api/paas/v4' })`) 명시. B21 historical rationale demote |
| `anthropic-vertex.ts` deprecate | ✅ file + interface + factory function JSDoc. `@ai-sdk/anthropic` Vertex 모드 또는 `@ai-sdk/google-vertex`. AnthropicClient transitively 의존 (5.x.2 deprecate) → 5.x.5에서 함께 제거 |
| 회귀 | ✅ **460 PASS** (변동 없음) |
| 매트릭스 ID 인용 | ✅ `chore(providers): @deprecated Gemini/OpenAICompat/AnthropicVertex — fixes D44 §3` |

### 5.x.4 — 자체 5개 provider 제거 + V2/V3 dual support + 자동설치 + 크로스플랫폼 ✅ 완료 (사용자 directive 통합 cleanup)

**사용자 directive로 5.x.4 (claude-cli deprecate) + 5.x.5 (5개 일괄 제거 + cleanup) 통합 진행.** 추가 발견: Vercel ecosystem V2/V3 spec 혼재 → adapter dual-version 호환 보강 + 자동설치 가이드 + cross-platform 가이드.

| 항목 | 결과 |
|---|---|
| 5 source 제거 | ✅ `anthropic.ts` / `anthropic-vertex.ts` / `gemini.ts` / `openai-compat.ts` / `claude-cli.ts` |
| 2 test 제거 | ✅ `claude-cli-env.test.ts` (10) + `claude-cli-env.integration.test.ts` (8) |
| smoke 제거 | ✅ `scripts/smoke-anthropic.ts` + root `smoke:anthropic` script |
| index.ts 정리 | ✅ 5 export 제거, 헤더 코멘트 갱신 |
| package.json 0.1→0.2 | ✅ exports 5개 path 제거, peer dep 정리, optionalDependencies 신규 |
| **V2/V3 dual support** | ✅ `LanguageModelV2OrV3` union — `fromV2FinishReason` (V2 string + V3 `{unified}` 둘 다), `fromV2Usage` (V2 flat + V3 nested 둘 다), `specificationVersion` `"v2" | "v3"` 허용 |
| **자동설치** | ✅ 루트 `dependencies` 6개 (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`, `zhipu-ai-provider`, `ai-sdk-provider-claude-code`) + providers package `optionalDependencies` 미러 |
| **cross-platform 가이드** | ✅ README — Linux/macOS/Windows + Flatpak/sandbox 우회 path 3종 |
| Cross-provider integration test | ✅ `vercel-providers-compat.integration.test.ts` 6 tests — 5 실 Vercel SDK 패키지 모델 구성 검증 + V1/V4+ explicit error 검증 + 누락 dep graceful skip |
| 회귀 | ✅ **448 PASS** (이전 460 - 18 removed + 6 신규) |
| 매트릭스 ID 인용 | ✅ `feat(providers)!: remove 5 self-built providers + V2/V3 dual support + auto-install + cross-platform — fixes D44 §4-5` |

**Vercel ecosystem 발견 (5.x.4 mid-progress)**:

V2 spec: `@ai-sdk/anthropic@2.x` (현 latest)
V3 spec: `@ai-sdk/google@3.x` / `@ai-sdk/openai-compatible@2.x` / `zhipu-ai-provider@0.3.x` / `ai-sdk-provider-claude-code@3.x` / `ai@6.x` (core)

V2/V3 차이는 적음 (finishReason / usage shape만 실질 변동, content / stream-part / prompt format은 호환). VercelClient adapter가 양쪽 normalize.

### 5.x.5 — (5.x.4와 통합 완료)

5.x.4가 5.x.5 작업 (5개 제거 + cleanup) 모두 흡수. 별도 slice 없음.

### 5.x.6 — Cross-review 3-perspective (다음)

- **architect**: SOLID / interface 결합도 / peer-dep + optionalDependencies 패턴 검증 / V2/V3 dual support 설계 / B21 격하 정합성
- **reference-driven**: opencode / Mastra / Vercel 본가 패턴 일치도 / `LanguageModelV2OrV3` union 타입 vs Vercel 권장 패턴
- **paranoid**: 키 노출 / SDK breaking (V4 진입 시 explicit error로 surfacing 검증) / fixture drift / F09 cleanroom / F11 SDK bump / cross-platform CLI binary 누락 시 graceful failure / Flatpak sandbox 회피 path 정확성

P0 fix 반영 → 본 progress lock.

---

## 6. vllm-omni 처리 (D43 그대로)

| 경로 | 처리 |
|---|---|
| vllm-omni `/v1/chat/completions` (텍스트 mode) | `@ai-sdk/openai-compatible` baseURL override, Slice 5.x.3b 흡수 |
| vllm-omni `/v1/realtime` (audio_delta WSS) | **Vercel 영역 밖** — D43 자체 audio provider layer (Phase 5+ 별도 slice) |
| lab-proxy-live (vllm-omni 원격 호출) | 보존 — naiaKey + WSS, Vercel SDK 영역 밖 |

→ **D44는 vllm-omni audio_delta path와 직교**. Vercel 채택해도 vllm-omni 작업 영향 없음.

---

## 7. 보존 (변경 없음)

- `lab-proxy.ts` (HTTPS, naiaKey, vertexai/xai/anthropic 라우팅)
- `lab-proxy-live.ts` (WSS, naiaKey, vllm-omni `/v1/realtime`)
- D43 audio provider layer (자체 STT/TTS abstraction, Vercel 패턴만 차용)
- 4-repo 책임 분리 LOCK (naia-os device IO + UI / naia-agent engine / naia-adk skill spec / naia-memory engine)
- A01~A31 §A 채택 항목 (interface contract / D1~D8 / Voice 3-layer 등)
- F01~F11 forbidden_actions

---

## 8. RunPod (D45 후보, 별도 논의)

사용자 directive: "우리 any-llm의 runpod지원은 이후에 추가 논의하자"

→ 본 progress 범위 밖. 결정 시 매트릭스에 D45 추가 + 별도 progress 파일.

**고려할 두 path** (사전 정리만):

| Path | 작업 위치 | 비용 모델 | 토큰 절약 |
|---|---|---|---|
| **A. naia-anyllm gateway 측 통합** | `project-any-llm` (= `nextain/naia-anyllm`) repo | naia 계정 (사용자 무관, naiaKey만) | ★★★ 모든 naia 사용자 |
| **B. 클라이언트 직접** | `@runpod/ai-sdk-provider` peer dep | 사용자 RUNPOD_API_KEY | ★★ 자체 키 보유자 |

Slice 5.x.1~6 완료 후 사용자와 별도 논의.

---

## 9. 진행 트래킹

- **Master issue**: nextain/naia-agent#2 (R5 댓글 추가 예정 — Slice 5.x.0 commit 후)
- **본 progress**: `.agents/progress/vercel-ai-sdk-adoption-2026-04-29.md`
- **매트릭스**: D44 (활성), D23 (superseded), B21 (demoted), K 변경 이력
- **5.x.0 commit (본 turn)**: docs only — matrix + progress + CHANGELOG entry (Unreleased)
- **5.x.1 진입 조건**: 본 commit landing + 사용자 사전 승인 (peer dep 추가 + adapter 신규 파일)

---

## 10. 사용자 승인 대기 항목 (Slice 5.x.1 진입 전)

본 5.x.0 commit (docs lock)은 즉시 진행. **그러나 5.x.1 (코드 작업 시작)은 다음 사항 확인 후 진행**:

1. `ai`, `@ai-sdk/anthropic` peer dep 추가 OK?
2. `VercelClient` 첫 검증 모델은 Anthropic이 적합? (사용자 가장 많이 쓰는 path)
3. F11 (SDK minor bump fixture-replay 재녹화) 5.x.1에서 적용 OK?
4. cross-review (5.x.6) 시점 — 매 slice마다? 통합 시점에만? 사용자 선호 확인.

---

## 11. 본 R5가 의도적으로 다루지 않는 것

- RunPod 통합 (D45 후보, 별도 논의)
- vllm-omni RunPod 호스팅 (자체 컨테이너 빌드, Phase 5+ 별도)
- vllm-omni audio_delta D43 audio layer 구현 (Phase 5+ 별도 slice)
- naia-anyllm gateway backend 추가/수정 (project-any-llm submodule, 별도 repo 작업)
- 4-repo plan v7.2 Part A 수정 (F07 보존)
- naia-os device IO / UI 책임 (4-repo 책임 분리 LOCK 보존)
