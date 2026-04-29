# Changelog

All notable changes to `@nextain/agent-*` packages.

Each package follows independent SemVer. Monorepo-wide entries below.

Slice entries (R1+) follow the format: `## [Slice N] — YYYY-MM-DD — short title`.

## [Unreleased]

## [Slice 5.x.4] — 2026-04-29 — 자체 5개 provider 제거 + 자동설치 + V2/V3 호환 + 크로스플랫폼 (D44 §4-5)

**사용자 directive 통합 cleanup.** 5.x.4 (claude-cli deprecate) + 5.x.5 (5개 일괄 제거 + cleanup) 통합 진행. 추가로 Vercel SDK 생태계 V2/V3 spec 혼재 발견 → adapter dual-version 호환 보강. 자동설치 의존성 + cross-platform 가이드 정리.

### Removed (5 self-built providers)
- `packages/providers/src/anthropic.ts` → `VercelClient + @ai-sdk/anthropic`
- `packages/providers/src/anthropic-vertex.ts` → `VercelClient + @ai-sdk/anthropic` Vertex 모드
- `packages/providers/src/gemini.ts` → `VercelClient + @ai-sdk/google` (또는 community `ai-sdk-provider-gemini-cli`)
- `packages/providers/src/openai-compat.ts` → `VercelClient + @ai-sdk/openai-compatible` (vLLM/vllm-omni 텍스트/LM Studio/Ollama/OpenRouter), Z.ai coding plan은 `zhipu-ai-provider`
- `packages/providers/src/claude-cli.ts` → community `ai-sdk-provider-claude-code` (Pro/Max 구독 path 동일 보존)
- `packages/providers/src/__tests__/claude-cli-env.test.ts` (10 unit)
- `packages/providers/src/__tests__/claude-cli-env.integration.test.ts` (8 integration)
- `scripts/smoke-anthropic.ts` (deprecated since 5.x.2; `pnpm smoke:vercel-anthropic` 대체)
- root `package.json` `smoke:anthropic` script

### Adapter — V2/V3 dual support (D44 §4 보강)
Vercel ecosystem mid-migration: `@ai-sdk/anthropic@2.x`는 V2 spec, `@ai-sdk/google@3.x` / `@ai-sdk/openai-compatible@2.x` / `ai-sdk-provider-claude-code@3.x` / `zhipu-ai-provider@0.3.x`는 V3 spec. VercelClient를 양쪽 지원하도록 보강:
- `specificationVersion` 검사 `"v2" | "v3"` 허용 (V4+는 explicit error로 surfacing)
- `LanguageModelV2OrV3` 타입 union 도입 (`Content`/`Usage`/`FinishReason`/`StreamPart`)
- `fromV2FinishReason` — V2 plain string + V3 `{unified, raw}` object 둘 다 처리
- `fromV2Usage` — V2 flat `{inputTokens, outputTokens, cachedInputTokens}` + V3 nested `{inputTokens: {total, cacheRead, cacheWrite}, outputTokens: {total, ...}}` 둘 다 처리
- `doGenerate`/`doStream` cast — V2/V3 overload union이 TS에서 narrow 안 되므로 `unknown` 경유 structural assertion

### Auto-install 의존성 (자동설치)
`pnpm install`만으로 가장 흔히 쓰이는 5+ Vercel provider 즉시 사용 가능:

| 위치 | 패키지 | 효과 |
|---|---|---|
| 루트 `dependencies` | `ai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`, `zhipu-ai-provider`, `ai-sdk-provider-claude-code` | 모든 워크스페이스 패키지에서 즉시 import 가능 |
| `packages/providers` `optionalDependencies` | 같은 5개 | 외부 npm 소비자가 `pnpm add @nextain/agent-providers` 시 자동 설치 (실패 tolerant) |
| `packages/providers` `peerDependencies` | `ai@^6`, `@ai-sdk/provider@^3`, `ws@^8` (모두 optional) | 고급 사용자가 버전 pin 가능 |

제거된 dep: `@anthropic-ai/sdk`, `@anthropic-ai/vertex-sdk`, `@google/genai` (자체 5개 제거에 따라 root + providers package 양쪽에서)

### Package version bump
- `@nextain/agent-providers` 0.1.0 → **0.2.0** (breaking — 5개 export 제거)

### Cross-platform 가이드 (README)
- 모든 Vercel SDK 패키지는 pure JavaScript → Linux / macOS / Windows 지원
- CLI subscription providers는 host CLI binary 필요 (`claude` / `codex` / `gemini`):
  - Linux/macOS: 일반 설치
  - Windows: `.cmd`/`.exe` shim
  - Flatpak/sandbox: 3가지 우회 path 명시 (직접 API key / `flatpak-spawn --host` / LabProxy)
- Windows path quirks는 SDK 측 platform-aware handling 위임

### Added
- `packages/providers/src/__tests__/vercel-providers-compat.integration.test.ts` (6 tests):
  - `@ai-sdk/anthropic` (V2 spec) — 모델 구성 검증
  - `@ai-sdk/google` (V3 spec) — 모델 구성 검증
  - `@ai-sdk/openai-compatible` (V3 spec, vLLM-style baseURL) — 모델 구성 검증
  - `zhipu-ai-provider` (V3 spec, Z.ai coding plan endpoint) — 모델 구성 검증
  - `ai-sdk-provider-claude-code` (V3 spec, Pro/Max 구독) — 모델 구성 검증
  - V1/V4+ 잘못된 spec → 명시적 throw 검증
  - 누락 dep는 `console.warn` 후 skip (cross-platform graceful degradation)
- `packages/providers/README.md` — 전면 재작성:
  - VercelClient 메인 문서 (use cases / install / 50+ provider matrix)
  - Cross-platform 섹션 (Linux/macOS/Windows + Flatpak/sandbox 가이드)
  - "Removed" 섹션 (5개 → Vercel 매핑 표)

### Changed
- `packages/runtime/src/host/create-host.ts` — 코멘트만 갱신 (AnthropicClient → "any LLMClient" 일반화)
- `packages/providers/src/index.ts` — 5개 export 제거, 헤더 코멘트 갱신
- `packages/providers/package.json`:
  - `version` 0.1.0 → 0.2.0
  - `exports`: `./anthropic` / `./anthropic-vertex` / `./gemini` / `./openai-compat` / `./claude-cli` 제거
  - `peerDependencies`: 자체 5개 SDK 제거, Vercel SDK 3개 (`ai`, `@ai-sdk/provider`, `ws`) optional 유지
  - `optionalDependencies` 신규 — 5개 자동설치 (anthropic / google / openai-compatible / zhipu / claude-code)
  - `devDependencies` 정리 (자체 SDK 제거)
- 루트 `package.json`:
  - `dependencies` 신규 6개 (Vercel SDK 자동설치)
  - `devDependencies`에서 `@anthropic-ai/sdk` / `@anthropic-ai/vertex-sdk` / `@ai-sdk/anthropic` / `ai` 제거 (deps로 이동)
  - `smoke:anthropic` script 제거

### 회귀
- **448 PASS** (이전 460 - 18 claude-cli-env removed + 6 cross-provider integration = 448)
  - protocol 73 / observability 17 / providers **42 (25 unit + 11 lab-proxy + 6 cross-provider)** / verification 20 / runtime 160 / workspace 16 / adapter-opencode-cli 15 / adapter-shell 13 / adapter-opencode-acp 8 / cli-app 84
- 0 회귀 (active code path 모두 통과)
- TypeScript build 통과

### Slice 5.x.4 success criterion
- ✅ S01 새 명령 — `pnpm smoke:vercel-anthropic` 유지 + 6 cross-provider integration test
- ✅ S02 단위 테스트 — 25 vercel-client unit (이전) 유지 + 6 cross-provider integration 신규
- ✅ S03 통합 검증 — 5개 실 Vercel provider 패키지로 모델 구성 검증 (cross-platform on Linux 검증, Windows/macOS는 community provider 측에서 보장)
- ✅ S04 본 entry

### F09 (cleanroom 단독 의존 금지) 준수
- 본 cleanup은 자체 코드 제거 → 외부 Vercel SDK 의존. cleanroom 영역 무관

### F11 (Anthropic SDK minor bump fixture re-record) 미트리거
- `__fixtures__/anthropic-1turn.json`은 generic `LLMStreamChunk[]` 그대로 유지 (StreamPlayer 사용, 어떤 LLMClient 구현과도 무관)

### 매트릭스 ID 인용
- `feat(providers)!: remove 5 self-built providers + V2/V3 dual support + auto-install + cross-platform — fixes D44 §4-5`

### 다음 단계 (Slice 5.x.6)
- Cross-review 3-perspective (architect / reference / paranoid)
- 별도 논의 항목 (사용자 directive): RunPod 통합 (D45 후보, naia-anyllm gateway)

## [Slice 5.x.3] — 2026-04-29 — `GeminiClient` / `OpenAICompatClient` / `createAnthropicVertexClient` deprecate (D44 §3)

**3 provider 통합 deprecate.** 사용자 directive "통합" — 분할 (5.x.3a/b/c) 대신 단일 commit. 모두 동일 pattern (file-level + class/interface/factory `@deprecated` JSDoc, scope 변경 없음).

### Changed
- `packages/providers/src/gemini.ts` — `@deprecated` JSDoc + 두 마이그레이션 path 명시:
  - API key path: `@ai-sdk/google` (Vercel SDK)
  - Subscription path: `ai-sdk-provider-gemini-cli` (community, Gemini Code Assist)
  - Gemini 3 `thoughtSignature` round-trip은 Vercel `LanguageModelV2 providerMetadata` 통해 가능 (5.x.5 cleanup 시점에 검증)
- `packages/providers/src/openai-compat.ts` — `@deprecated` JSDoc + 마이그레이션 예시:
  - vLLM / vllm-omni / LM Studio / Ollama / OpenRouter / Together / Groq / Cerebras / DeepSeek / Fireworks / Perplexity → `@ai-sdk/openai-compatible` (단일 official 패키지)
  - Z.ai coding plan / Zhipu GLM → `zhipu-ai-provider` (community, `createZhipu({ baseURL: 'https://api.z.ai/api/paas/v4' })`)
  - B21 historical rationale ("avoids 50-provider direct deps") demote 명시 — `@ai-sdk/openai-compatible`은 단일 optional peer dep으로 모든 OpenAI-compat backend 커버
- `packages/providers/src/anthropic-vertex.ts` — `@deprecated` JSDoc:
  - `@ai-sdk/anthropic` Vertex 모드 또는 `@ai-sdk/google-vertex`
  - `AnthropicClient`를 transitively 의존 (5.x.2에서 deprecate된 client) → 5.x.5에서 함께 제거

### 기존 코드 영향
- **0 회귀** — JSDoc만 추가, 시그니처/런타임 변경 없음
- IDE strikethrough cue + TypeScript informational marker

### 회귀
- **460 PASS** (변동 없음)

### Slice 5.x.3 success criterion
- ⊘ S01~S04 부분 면제 (5.x.2와 동일 — deprecation 표기, matrix_id_citation rule "docs/infra 변경" 면제)
- ✅ S04 본 entry

### 매트릭스 ID 인용
- `chore(providers): @deprecated Gemini/OpenAICompat/AnthropicVertex — fixes D44 §3`

### 다음 단계 (Slice 5.x.4)
- `claude-cli.ts` deprecate → `ai-sdk-provider-claude-code` (community, Claude Pro/Max 구독 path 보존). Subprocess wrap (Flatpak/Windows/partial-JSON parity) 로직은 community provider가 흡수
- 이후 5.x.5: 자체 5개 일괄 제거 + bin/examples/fixture 정리 + 회귀 460 PASS 유지

## [Slice 5.x.2] — 2026-04-29 — `AnthropicClient` deprecate (D44 §2)

**자체 anthropic.ts → Vercel-backed 마이그레이션 path 공식 권고.** AnthropicClient는 5.x.5에서 제거 예정. 신규 코드는 `VercelClient + @ai-sdk/anthropic` 사용. 기존 코드는 그대로 동작 (소프트 deprecate).

### Changed
- `packages/providers/src/anthropic.ts` — `@deprecated` JSDoc (file-level + class + interface). 마이그레이션 예시 코드 포함, Slice 5.x.5 제거 시점 명시
- `scripts/smoke-anthropic.ts` — `@deprecated` JSDoc, `pnpm smoke:vercel-anthropic` 권고
- `packages/providers/README.md` — VercelClient 섹션을 메인으로 승격, 자체 5개 provider는 "Deprecated" 섹션으로 이동, 다른 provider 옵션 표 (50+) 추가, lab-proxy 계열은 Vercel-independent로 명시 보존

### 기존 코드 영향
- **0 회귀** — `AnthropicClient` 클래스/메서드 시그니처 변경 없음. JSDoc deprecate marker만 추가
- TypeScript는 `@deprecated`를 informational로 처리 (build/test 영향 없음). 사용자 IDE에서 strikethrough로 표시
- `anthropic-vertex.ts` 는 내부적으로 `AnthropicClient` 재사용 (deprecate 워닝 inherit) — 본 slice scope 밖, 5.x.3c 시점에 정식 deprecate

### 회귀
- **460 PASS** (변동 없음 — 5.x.1 신규 25 포함)

### F11 (Anthropic SDK minor bump fixture re-record) — 미트리거
- 본 slice는 SDK 버전 bump 아니고 내부 client deprecate. fixture (`packages/runtime/src/__fixtures__/anthropic-1turn.json`) 는 generic `LLMStreamChunk[]` JSON으로 어떤 LLMClient 구현과도 무관. 5.x.5에서 anthropic.ts 제거 시점에 fixture는 그대로 유지 (StreamPlayer 가 사용)

### 매트릭스 ID 인용
- `chore(providers): @deprecated AnthropicClient — fixes D44 §2`

### 다음 단계
- Slice 5.x.3a/b/c: `gemini.ts` / `openai-compat.ts` / `anthropic-vertex.ts` 동일 패턴 deprecate
- Slice 5.x.4: `claude-cli.ts` deprecate → `ai-sdk-provider-claude-code` (community)
- Slice 5.x.5: 자체 5개 제거 + bin/examples/fixture 일괄 정리 + 회귀 460 PASS 유지 검증
- Slice 5.x.6: cross-review 3-perspective (architect / reference / paranoid)

## [Slice 5.x.1] — 2026-04-29 — VercelClient adapter MVP (D44 §1)

**Vercel AI SDK 첫 코드 진입.** `LanguageModelV2` → `LLMClient` 어댑터 1개로 50+ provider 즉시 호환 가능 상태로 전환. 기존 5개 자체 provider (anthropic / anthropic-vertex / gemini / openai-compat / claude-cli)는 후속 슬라이스에서 deprecate.

### Added
- `packages/providers/src/vercel-client.ts` — `VercelClient` 어댑터 + 순수 변환 헬퍼 (`toV2Prompt` / `fromV2Content` / `fromV2FinishReason` / `fromV2Usage`) export
- `packages/providers/src/__tests__/vercel-client.test.ts` — 25 unit (bidirectional 변환 모두 커버: system / user / assistant / tool 메시지 / tool_use / thinking / image base64 / 각 V2 finishReason / cachedInputTokens / stream id→index / reasoning / response-metadata 우선 / error 부분 / finish 누락 fallback)
- `scripts/smoke-vercel-anthropic.ts` — dry-run + live 양 path
- `package.json` `smoke:vercel-anthropic` script
- `packages/providers/package.json` exports `./vercel` 추가
- `packages/providers/package.json` peer dep + devDep: `ai@^6` / `@ai-sdk/anthropic@^2` / `@ai-sdk/provider@^3` (모두 optional peer dep — host가 필요한 것만 install, B21 격하 근거)
- 루트 `package.json` devDep: `ai@^6` / `@ai-sdk/anthropic@^2` (smoke script가 root에서 실행 가능하도록)

### 어댑터 design (LLMClient SSE shape 정합)
- V2 string `id` → 우리 numeric `index` 매핑 (Map, auto-increment) — Anthropic-style content_block_* 보존
- V2 stream-part 흡수: text-start/delta/end, reasoning-start/delta/end, tool-input-start/delta/end, finish, error, response-metadata, stream-start
- 알 수 없는 part (file/source/raw/tool-call aggregate) drop — LLMContentBlock "unknown 변종은 어댑터 경계에서 drop" 정책
- 합성 start chunk 지연 emit — response-metadata id/modelId 받은 후 emit (없으면 random id + constructor modelId 사용)
- finish 누락 시도 end chunk 항상 발행 (우리 SSE 계약 보장)
- error part → throw (caller에서 catch)

### Slice 5.x.1 success criterion
- ✅ S01 새 명령 — `pnpm smoke:vercel-anthropic` (dry-run 즉시, live는 ANTHROPIC_API_KEY 있을 때 opt-in)
- ✅ S02 단위 테스트 — 25 신규 (vercel-client.test.ts)
- ✅ S03 통합 검증 — mock `LanguageModelV2` 가 실제 V2 stream-part shape를 emit하는 형태로 25 테스트가 통합 변환 round-trip 검증. 실 Anthropic 호출 검증은 ANTHROPIC_API_KEY opt-in (G15 fixture-only-default 강제 + key는 사용자 환경)
- ✅ S04 본 entry

### 회귀
- **460 PASS** (이전 435 + 25 신규)
  - protocol 73 / observability 17 / providers **54 (29 + 25 신규)** / verification 20 / runtime 160 / workspace 16 / adapter-opencode-cli 15 / adapter-shell 13 / adapter-opencode-acp 8 / cli-app 84
- 0 회귀

### 매트릭스 ID 인용
- `feat(providers): VercelClient adapter MVP — fixes D44 §1`

### F09 (cleanroom 단독 의존 금지) 준수
- Vercel AI SDK는 Apache 2.0 + 23.5K stars + 활발한 maintenance. cleanroom 출처 0건. OWASP/RFC 출처 cross-reference 면제 (cleanroom 영역 무관)

### F11 (Anthropic SDK minor bump fixture re-record) — 5.x.2로 이연
- 본 5.x.1은 **신규 어댑터 추가**만 — 기존 `anthropic.ts` + `__fixtures__/anthropic-1turn.json` 변경 없음
- F11 강제는 **5.x.2 (자체 anthropic.ts deprecate → Vercel-backed)** 시점에 적용. fixture re-record + StreamPlayer 재생 검증 동시 수행

### 보존 (변경 없음)
- 기존 7 provider 모두 그대로 유지 (deprecate는 후속 slice)
- bin / examples / runtime / 250 PASS R3 baseline 무관

### 다음 단계 (Slice 5.x.2 예정)
- 자체 `anthropic.ts` deprecate → 호스트 측에서 `VercelClient + createAnthropic(...)` 우선
- `__fixtures__/anthropic-1turn.json` Vercel-backed로 재녹화 (F11)
- `scripts/smoke-anthropic.ts`는 deprecate 직전 마지막 commit에서 제거

## [Slice 5.x.0] — 2026-04-29 — D44 lock: Vercel AI SDK 채택 정정 (D23 supersede)

**Decision-only commit (docs).** R4에서 lock된 D23 ("Vercel AI SDK 보류")이 사용자 원래 의사 ("로컬은 Vercel로 50+ provider 즉시 확보")와 정반대로 silent drift된 것을 정정. D44 (Vercel AI SDK 로컬 LLM 단일 abstraction 채택, peer-dep 패턴) 신규 lock.

### Matrix 변경
- **§D 신규 1건** D44 — Vercel AI SDK 채택 (peer-dep 패턴, 50+ provider, lab-proxy 보존, vllm-omni audio_delta는 D43 그대로)
- **§D supersede** D23 → D44 (strikethrough + supersede 명시)
- **§B 격하** B21 → demoted (sub-concern 회피 가능: optional peer dep + headless)
- **§K 신규** R5 변경 이력 (2026-04-29 Vercel AI SDK 채택 정정)

### Progress 파일 신설
- `.agents/progress/vercel-ai-sdk-adoption-2026-04-29.md` — D44 근거, slice 시퀀스 (5.x.0~5.x.6), vllm-omni 처리, RunPod 별도 논의

### Slice 시퀀스 outline (Phase 5.x)
- **5.x.0** (본 commit): docs lock
- **5.x.1**: `VercelClient` adapter MVP (Anthropic 우선 검증)
- **5.x.2**: 자체 `anthropic.ts` deprecate → Vercel-backed
- **5.x.3** (3 sub): `gemini` / `openai-compat` / `anthropic-vertex` deprecate
- **5.x.4**: `claude-cli.ts` deprecate → `ai-sdk-provider-claude-code` (community)
- **5.x.5**: bin / examples / fixture-replay 갱신 + 자체 5개 제거
- **5.x.6**: Cross-review 3-perspective + P0 fix

### 보존 (변경 없음)
- `lab-proxy.ts` / `lab-proxy-live.ts` (naiaKey 보호 + WebSocket Live API, Vercel 영역 밖)
- D43 audio provider layer (vllm-omni audio_delta WSS 자체 구현 path)
- 4-repo 책임 분리 LOCK / A01~A31 / F01~F11

### Out of scope (본 R5 외)
- RunPod 통합 (D45 후보, 사용자 directive로 별도 논의)
- vllm-omni RunPod 호스팅 (자체 컨테이너, Phase 5+ 별도)
- vllm-omni audio_delta D43 layer 구현

### 매트릭스 ID 인용
- `docs(matrix): D44 lock + D23 supersede + B21 demote + K changelog`

### Slice 5.x.0 success criterion (docs-only 면제)
- ✅ S01~S04 면제 (matrix_id_citation 룰의 "매트릭스 외 영역 — docs/infra" 면제)
- ✅ 매트릭스 D44 / D23 strikethrough / B21 demote / K changelog 4건 모두 반영
- ✅ progress 파일 + session_id 바인딩

## [Slice 2.7] — 2026-04-26 — Log Policy 정규화 + Logger.fn() 표준 + dev mode 자동 file logging

**개발 추적 가능한 구조.** 모든 핵심 함수에 enter/branch/exit + caller(file:line) + elapsedMs + args/result trace.

### Added
- `docs/log-policy.md` — 로그 정책 정규 표준 (5 levels / 출력 위치 / 회전 / 포맷 / 민감 정보 마스킹 / 이벤트별 정규 fields / CLI 플래그)
- `packages/types/src/observability.ts` — `Logger.fn()` + `FnLogger` interface (additive, optional)
- `packages/observability/src/logger.ts` — ConsoleLogger.fn() 구현 (caller 자동 추출 + elapsedMs)
- `packages/observability/src/dev-logger.ts` — `createProjectLogger()` factory (auto-detect dev: tsx/NODE_ENV/DEV_MODE) + 파일 자동 저장
- `packages/observability/src/redact.ts` — 5 pattern (Anthropic / OpenAI / GW / Google / Bearer) 자동 마스킹

### Logger.fn() 적용 (8 영역)
- `bin/naia-agent.ts` — main, detectRealLLM
- `host/create-host.ts` — createHost
- `skills/bash.ts` — handler (DANGEROUS branch + exec/timeout/exit)
- `skills/file-ops.ts` — read/write/edit/list 4 handlers
- `providers/openai-compat.ts` — generate
- `providers/anthropic.ts` — generate
- `utils/env-loader.ts` — loadEnvAndConfig
- `core/agent.ts` — sendStream, send

### 자동 dev mode 동작
- 감지: `NODE_ENV !== "production"` OR `DEV_MODE=1` OR argv[1]가 `.ts/.tsx`
- Dev: level=`debug` + 파일 자동 저장 `~/.naia-agent/logs/naia-agent-YYYYMMDD.jsonl`
- Production: level=`warn` + stderr만 (LOG_FILE 명시 시 파일도)

### Slice 2.7 success criterion
- ✅ S01 새 명령 동작 (기존 + dev mode 자동)
- ✅ S02 회귀 250 PASS
- ✅ S03 통합 검증 — 실 GLM 호출 후 trace 모두 파일에 기록 + caller/elapsedMs 정확
- ✅ S04 본 entry

### 검증된 trace (실 호출)
```jsonl
{"ts":"...","level":"debug","msg":"enter:main","caller":"bin/naia-agent.ts:258","argv":["--enable-all","..."]}
{"ts":"...","level":"debug","msg":"enter:detectRealLLM","caller":"bin/naia-agent.ts:35"}
{"ts":"...","level":"debug","msg":"branch:detectRealLLM:openai-compat","hasGlm":true}
{"ts":"...","level":"debug","msg":"enter:createHost","enableBash":true,"enableFiles":true}
{"ts":"...","level":"debug","msg":"branch:createHost:tools-built","count":5}
{"ts":"...","level":"debug","msg":"exit:createHost","elapsedMs":0,"result":{"toolCount":"set"}}
{"ts":"...","level":"info","msg":"session.active","sessionId":"sess-..."}
{"ts":"...","level":"debug","msg":"enter:Agent.sendStream","userTextLen":54,"sessionState":"active"}
{"ts":"...","level":"debug","msg":"enter:list_files.handler","path":".agents/progress/refs/"}
{"ts":"...","level":"debug","msg":"exit:list_files.handler","elapsedMs":1,"result":{"entries":13}}
{"ts":"...","level":"info","msg":"session.closed","sessionId":"sess-..."}
```

### 매트릭스 §A 승격 1건
- **A31** Log Policy + Logger.fn() + dev mode auto + redact

### 보안 (redact 패턴)
- `sk-ant-...` → `sk-ant-***`
- `sk-...` → `sk-***`
- `gw-...` → `gw-***`
- `AIzaSy...` → `AIzaSy***`
- `Bearer ...` → `Bearer ***`
- 자동 적용 (모든 log entry string values 재귀)

### 사용자 검증
```bash
# Dev mode (tsx 자동 감지) — debug + file 자동
pnpm naia-agent --enable-all "..."
tail -f ~/.naia-agent/logs/naia-agent-YYYYMMDD.jsonl

# Production (build 후)
LOG_LEVEL=warn node dist-bin/naia-agent.js "..."

# 명시 file 저장
LOG_FILE=~/my.log pnpm naia-agent "..."
```

## [Slice 2.6] — 2026-04-25 — File ops skills (read/write/edit/list_files)

**naia-agent가 본격 coding agent로.** LLM이 read_file/write_file/edit_file/list_files 자율 호출 → workspace 내 파일 작업.

### Added
- `packages/runtime/src/skills/file-ops.ts` — 4 skill factories:
  - `createReadFileSkill` (T0, concurrencySafe) — UTF-8 read with maxBytes truncation
  - `createWriteFileSkill` (T1, destructive) — write + auto-mkdir + maxBytes guard
  - `createEditFileSkill` (T1, destructive) — exact-match find/replace (single or all)
  - `createListFilesSkill` (T0, concurrencySafe) — non-recursive ls with type prefix
  - `createFileOpsSkills(opts)` — bundle of all 4
- 모두 D09 `normalizeWorkspacePath` (workspace sentinel) 재사용 → path traversal 차단
- `packages/runtime/src/__tests__/file-ops.test.ts` — 23 tests (read/write/edit/list × 안전 + 차단 + 경계 케이스 + e2e bundle)
- `bin/naia-agent.ts` — `--enable-files` + `--enable-all` 플래그
- `createHost({ enableFiles, fileOpsOptions })` 옵션 확장
- bin tierForTool 매핑: bash/write_file/edit_file → T1, read_file/list_files → T0

### Slice 2.6 success criterion (S01~S04)
- ✅ S01 새 명령: `pnpm naia-agent --enable-files "..."` 또는 `--enable-all`
- ✅ S02 단위 테스트: 23 신규 file-ops + 기존 회귀. **Total 250 PASS** (protocol 73 + observability 17 + runtime 160)
- ✅ S03 통합 검증: GLM 실 호출 — `list_files`로 .agents/progress/refs/ 11개 파일 정확히 출력
- ✅ S04 본 entry

### 매트릭스 §A 승격 1건
- **A30** File ops skills bundle (D09 sentinel 재사용)

### 사용자 검증 (실 GLM 호출)

```bash
$ pnpm naia-agent --enable-all ".agents/progress/refs/ 의 파일 목록 보여줘"
[naia-agent] skills ENABLED: bash(T1), read_file(T0), write_file(T1), edit_file(T1), list_files(T0)
[naia-agent] provider: openai-compat (model=glm-4.5-flash, ...)

- cline-review.md
- jikime-adk-review.md
- jikime-mem-review.md
- langgraphjs-review.md
- mastra-review.md
- moltbot-review.md
- openclaw-review.md
- opencode-review.md
- project-airi-review.md
- vercel-ai-sdk-review.md
```

GLM이 `list_files` 도구를 자율 호출 → 결과를 markdown 리스트로 정리.

### 보안 모델 (file-ops 일관)
- T0 (read/list) — opt-in 후 자유 호출
- T1 (write/edit) — opt-in 후 호출 가능, GatedToolExecutor (Slice 6+)에서 approval 추가
- D09 workspace sentinel — `../../etc/passwd` 같은 경로 100% 차단 (BLOCKED 응답)
- maxBytes (256KB default) — 대용량 파일 truncate 또는 reject

### Slice 2.6 follow-up
- glob/grep skills (find . -name 패턴 + ripgrep) — Slice 2.7 후보
- 파일 watcher / hot reload — Phase 2

## [Slice 2.5] — 2026-04-25 — OpenAI-compat tool calling integration

**LLM이 진짜로 도구를 호출.** Slice 2의 bash skill이 GLM-4.5-Flash로 자율 호출돼서 실 답변 생성.

### Added
- `packages/providers/src/openai-compat.ts` 보강 — tool calling 양방향 translation:
  - `LLMRequest.tools` → OpenAI `tools[]` (function-calling format)
  - response `message.tool_calls` → `LLMContentBlock[]` `tool_use`
  - assistant message `tool_use` → OpenAI `assistant.tool_calls`
  - `tool_result` block → OpenAI `role: "tool"` message (tool_call_id 보존)
  - finish_reason `"tool_calls"` → `StopReason "tool_use"`

### 사용자 검증 (실 GLM 호출, 이전 commit 직후)

```bash
$ pnpm naia-agent --enable-bash "bin/ 디렉터리에 무엇이 있나? bash로 확인하고 답해줘."
[naia-agent] provider: openai-compat (model=glm-4.5-flash, ...)
[naia-agent] bash skill ENABLED (T1, DANGEROUS_COMMANDS pre-filtered)

bin/ 디렉터리에는 `naia-agent.ts` 파일 하나가 있습니다. 이 파일은 실행 권한이 있고 10,742바이트 크기입니다.
```

GLM이 자율적으로 `bash` 도구를 호출 → ls 실행 → 결과를 자연어로 정리.

### Slice 2.5 success criterion (S01~S04)
- ✅ S01 새 명령: `pnpm naia-agent --enable-bash "..."` (real LLM이 도구 자율 호출)
- ✅ S02 단위 테스트: 기존 회귀 (227 PASS) + tsc clean
- ✅ S03 통합 검증: GLM-4.5-Flash 실 호출 — bash 도구 자율 사용
- ✅ S04 본 entry

### 매트릭스 §A 승격 1건
- **A29** OpenAI-compat tool calling translation (양방향)

### 보안 모델 일관
- LLM이 도구 호출 → DANGEROUS_COMMANDS regex로 사전 차단 (Slice 2 A24)
- T1 도구는 --enable-bash opt-in 필수 (사용자 동의 역할 유지)

## [Slice 2] — 2026-04-25 — Bash skill + DANGEROUS_COMMANDS + observability

**naia-agent의 첫 진짜 도구 실행.** LLM이 bash 호출 → DANGEROUS_COMMANDS regex 사전 차단 → 실 shell 실행. Logger.tag/time + observability 단위 테스트.

### Added
- `packages/runtime/src/utils/dangerous-commands.ts` — D01 catalog (12+ 패턴, OWASP A03 + CWE-78 출처). `checkDangerous`/`assertSafe`/`DangerousCommandError` API. F09 cleanroom 라인 인용 0건 (자체 작성).
- `packages/runtime/src/skills/bash.ts` — `createBashSkill()` factory (T1, execFile + args[] + 30s timeout + 32KB output cap + DANGEROUS pre-filter)
- `packages/runtime/src/__tests__/dangerous-commands.test.ts` (38 tests — block 17 + allow 16 + assertSafe 2 + 메타 2)
- `packages/runtime/src/__tests__/bash-skill.test.ts` (12 tests — 실 shell 실행 + BLOCKED + timeout + cwd + stderr)
- `packages/types/src/observability.ts` — D06 Logger.tag/time optional methods (additive, A.8 MAJOR 위반 0)
- `packages/observability/src/logger.ts` — ConsoleLogger.tag/time 구현
- `packages/observability/{vitest.config.ts, src/__tests__/{console-logger,meter,tracer}.test.ts}` — 17 신규 단위 테스트 (G05 0개 → 17개 해소)
- `bin/naia-agent.ts` — `--enable-bash` 플래그 (opt-in, default off)
- `examples/bash-skill-host.ts` + `package.json scripts.smoke:bash-skill` — mock LLM + bash 실 실행 + DANGEROUS 차단 시연
- `createHost({ enableBash, extraTools })` — host factory 옵션 확장

### Slice 2 success criterion (S01~S04)
- ✅ S01 새 명령: `pnpm naia-agent --enable-bash "..."` + `pnpm smoke:bash-skill`
- ✅ S02 단위 테스트: dangerous 38 + bash-skill 12 + observability 17 = **67 신규**. Total 227 (protocol 73 + observability 17 + runtime 137)
- ✅ S03 통합 검증: bash-skill-host.ts smoke — 실 ls 실행 + rm -rf / BLOCKED 검증
- ✅ S04 본 entry

### 매트릭스 §A 승격 (5건)
- **A24** DANGEROUS_COMMANDS regex catalog (D01 §D → §A)
- **A25** Bash skill (T1)
- **A26** Logger.tag/time (D06 §D → §A)
- **A27** Observability 단위 테스트 (G05 해소)
- **A28** host factory enableBash + extraTools 옵션

### F09 준수 (paranoid review 포함)
- DANGEROUS_COMMANDS regex 출처: OWASP Top 10 2021 A03 + CWE-78 (Improper Neutralization of Special Elements)
- cleanroom-cc 코드 라인 직접 인용 0건 — 자체 작성, OWASP/CWE cross-reference

### 보안 모델
- bash skill T1: --enable-bash opt-in 필수 (사용자 동의 역할)
- DANGEROUS regex 사전 차단 (12+ 패턴): rm -rf root/home, fork bomb, dd to disk, mkfs, sudo destructive, chmod 777 root, curl|bash, nc reverse shell, eval/exec injection 등
- execFile + args 배열 (shell-string 직접 평가 안 함)
- T2/T3 도구는 Slice 6+에서 GatedToolExecutor + ApprovalBroker 통합

### Slice 2 follow-up
- LLM tool calling integration: OpenAI-compat client가 LLMRequest.tools를 OpenAI tools format으로 변환 필요 (현재 GLM이 도구 모름 — 별도 commit)
- D12 onStepFinish callback (Slice 2.5 또는 후속)
- D11 ToolExecutionContext orphan 해소 (ToolExecutor.execute() 시그니처 확장)

### 사용자 검증

```bash
$ pnpm smoke:bash-skill
━━━ safe-bash (ls) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[tool ▶] bash({"command":"ls bin/*.ts 2>/dev/null | head -3"})
[tool ◀] bin/naia-agent.ts
[exit 0]
[final] I found the bin entry — bin/naia-agent.ts.

━━━ dangerous-bash (rm -rf /) — should be BLOCKED ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[tool ▶] bash({"command":"rm -rf /"})
[tool ◀] BLOCKED: dangerous command blocked: rm -rf / — rm -rf targeting filesystem root or home (CWE-78)
[final] The dangerous command was blocked, as expected.

✓ bash-skill-host smoke passed
```

### Sub-issues closed
- closes #16 (sub-A bash skill + DANGEROUS regex)
- closes #17 (sub-B observability + Logger.tag/time)
- closes #18 (sub-C bin + example + CHANGELOG + 매트릭스)
- closes #15 (Slice 2 메인)
- closes #5 (G03+G04 P0 — DANGEROUS + path normalize 모두 §A)

## [Slice 1c++] — 2026-04-25 — LLM Config Standard 정규화 + 프로젝트 example

**사용자 directive**: "지금 프로젝트에 설정 + LLM 설정 표준 미리 만들어두는게 좋지 않을까?"

### Added
- `docs/llm-config-standard.md` — LLM provider 설정 정규 표준 (환경변수 / JSON shape / 우선순위 / 보안 / multi-tool harness 호환)
- `naia-agent.env.example` (프로젝트 root) — 4 provider option 포함, 사용자가 채워서 `naia-agent.env`로 rename
- `.naia-agent.example.json` — JSON config example, camelCase 자동 변환 시연
- `AGENTS.md` "LLM Config Standard" 섹션 (mirror 자동 sync)

### 매트릭스 §A 신규 4건
- **A20** env + JSON config auto-loader (camelCase → SCREAMING_SNAKE_CASE)
- **A21** OpenAI-compat client (zai GLM / vLLM / OpenRouter / Together / Groq / Ollama)
- **A22** Anthropic on Vertex AI provider
- **A23** LLM Config Standard docs + multi-tool harness 표준화

### 표준 핵심 (요약)
- Provider priority: ANTHROPIC > OpenAI-compat > GLM > Vertex > mock
- 파일 검색: `--env/--config` flag > env var > project file > `~/.naia-agent/`
- 보안: mode 600 권장, .gitignore, 키 값 stdout 노출 금지, F09 (cleanroom 단독 의존 금지)
- 도구 무관: Claude Code / opencode / Codex / Gemini / naia 자체 모두 동일 표준 사용

### Slice 1 (전체) 완전 종료
- Slice 1a (mock skeleton) ✓
- Slice 1b (real Anthropic + fixture-replay + D09/D10/D11) ✓
- Slice 1c (.env/JSON auto-load + Vertex provider) ✓
- Slice 1c+ (OpenAI-compat + 사용자 키 자동 설정) ✓
- Slice 1c++ (본 entry — LLM Config Standard 정규화) ✓
- **사용자 직접 검증**: `pnpm naia-agent "안녕"` → "안녕하세요! 😊 How can I help you today?" (GLM-4.5-Flash) ✓

### 다음 단계
Slice 2 (Bash skill + observability + 보안 D01/D02/D09 ingrain) — sub-issue #5

## [Slice 1c+] — 2026-04-25 — OpenAI-compat provider (GLM/zai/vLLM/OpenRouter…) + 사용자 키 자동 설정

**사용자 directive: "키 넣어줘"** — `~/dev/my-envs/naia.nextain.io.env`에서 valid GLM 키 발견 → `~/.naia-agent/.env`에 자동 설정 → 즉시 실 호출 동작 확인.

### Added
- `packages/providers/src/openai-compat.ts` — OpenAI-compat fetch wrapper (no SDK 의존). zai GLM, vLLM, OpenRouter, Together, Groq, Ollama 등 모든 OpenAI-compat endpoint 호환
- bin provider 분기 우선순위 update: ANTHROPIC > OpenAI-compat (GLM 자동 + OPENAI 환경) > Vertex > mock
- `~/.naia-agent/.env` (mode 600) — GLM_API_KEY + GLM_MODEL 설정. 사용자 키 위치 자동 검출

### 실 호출 검증 (실제로 동작)
```bash
$ pnpm naia-agent "안녕! 한국어 5단어 이내로 답해줘"
[naia-agent] loaded .env=/home/luke/.naia-agent/.env (2 keys)
[naia-agent] provider: openai-compat (model=glm-4.5-flash, baseUrl=https://open.bigmodel.cn/api/paas/v4)
안녕하세요!
```

### Provider matrix (4 옵션)
| 환경변수 | provider |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic 직접 |
| `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` | Anthropic-compat gateway |
| `OPENAI_API_KEY` + `OPENAI_BASE_URL` | OpenAI-compat (vLLM/OpenRouter/etc) |
| **`GLM_API_KEY`** (단독) | **zai/Zhipu GLM** (open.bigmodel.cn 자동) |
| `VERTEX_PROJECT_ID` + `VERTEX_REGION` | Anthropic on Vertex AI (gcloud ADC) |
| (none) | mock fallback |

### 보안
- `~/.naia-agent/.env` mode 600 (owner-only read)
- 코드는 키 값 절대 stdout/stderr 노출 안 함 (key 이름만)
- `.gitignore`에 `.naia-agent/` 포함 (commit 방지)
- 매트릭스 §B22 준수: cleanroom 코드 라인 인용 0

### 테스트
- 160 PASS (protocol 73 + runtime 87)
- tsc clean

### 매트릭스 §A 신규 (다음 commit에서 update)
- A20 후보: env+JSON config auto-loader
- A21 후보: OpenAI-compat client (multi-endpoint)

## [Slice 1c] — 2026-04-25 — .env / JSON config auto-load + Vertex AI provider

**사용자 키 보관 친화.** "키 직접 기억하지 않아" directive 반영 — 사용자가 표준 위치(.env, JSON config) 또는 명시 path에 키 두면 자동 로드. Anthropic 직접 + Vertex AI 둘 다 지원.

### Added
- `packages/runtime/src/utils/env-loader.ts` — native .env parser + JSON config flattener (camelCase/kebab → SCREAMING_SNAKE_CASE 자동 변환). dotenv 의존 0
- `packages/runtime/src/__tests__/env-loader.test.ts` (18 tests)
- `packages/providers/src/anthropic-vertex.ts` — `createAnthropicVertexClient` (Anthropic on Vertex AI via `@anthropic-ai/vertex-sdk`)
- `bin/naia-agent.ts` — `--env <path>` / `--config <path>` 플래그 + `NAIA_AGENT_ENV` / `NAIA_AGENT_CONFIG` 환경변수 + 자동 검색
- Provider 결정 로직: ANTHROPIC_API_KEY 우선 → VERTEX_PROJECT_ID + VERTEX_REGION → mock fallback
- 의존: `@anthropic-ai/vertex-sdk@^0.16.0` (peer optional)

### Auto-loaded files (first match wins, never overwrites process.env)
- `.env`: `./.env` → `./naia-agent.env` → `~/.naia-agent/.env`
- JSON: `./.naia-agent.json` → `~/.naia-agent/config.json`

### Slice 1c success criterion (S01~S04)
- ✅ S01 새 명령: `pnpm naia-agent --env .env "..."` / `pnpm naia-agent --config cfg.json "..."` / 자동 검색 모두 동작
- ✅ S02 단위 테스트: env-loader 18 tests + 기존 142 = **160 PASS**
- ✅ S03 통합 검증: .env 자동 로드 + provider 분기 시연 검증
- ✅ S04 본 entry

### .gitignore 추가
`naia-agent.env` / `.naia-agent.json` / `.naia-agent/` (사용자 키 commit 방지)

### Provider matrix
| 환경변수 | 효과 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic 직접 (claude-haiku-4-5-20251001 default) |
| `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` | Anthropic-compat gateway 라우팅 |
| `VERTEX_PROJECT_ID` + `VERTEX_REGION` | Anthropic on Vertex AI (gcloud ADC 자동 사용) |
| (none) | mock fallback |

### 사용자 검증 안내

**옵션 A — Anthropic 직접**:
```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." > .naia-agent/.env  # ~/.naia-agent/.env
pnpm naia-agent "hi"
```

**옵션 B — Vertex AI** (gcloud auth application-default login 이미 됨):
```bash
echo "VERTEX_PROJECT_ID=your-vertex-project" > .naia-agent/.env
echo "VERTEX_REGION=us-east5" >> .naia-agent/.env
pnpm naia-agent "hi"
```

**옵션 C — JSON config** (camelCase 자동 변환):
```bash
cat > ~/.naia-agent/config.json <<EOF
{ "anthropic": { "apiKey": "sk-ant-...", "model": "claude-haiku-4-5-20251001" } }
EOF
pnpm naia-agent "hi"
```

**옵션 D — 명시 path** (사용자 자체 .env 재사용):
```bash
pnpm naia-agent --env ~/dev/my-envs/anthropic.env "hi"
```

## [Slice 1b] — 2026-04-25 — real Anthropic + fixture-replay + D09/D10/D11

**R3 척추 살아남음 증명.** real LLM 통합 + 결정적 회귀 테스트 + Tool 메타/context schema + Workspace sentinel.

### Added
- `bin/naia-agent.ts` `detectRealLLM()` — `ANTHROPIC_API_KEY` (+ `ANTHROPIC_BASE_URL` gateway 라우팅) 검출 → AnthropicClient 주입. F11 graceful fallback (SDK load 실패 시 stderr 경고 + mock fallback)
- `packages/runtime/src/testing/stream-player.ts` — minimal fixture-replay LLMClient (C21 부분 채택, Slice 5에서 정식)
- `packages/runtime/src/__fixtures__/anthropic-1turn.json` — 1-turn naia 정규형 fixture (5 deltas → "Hi from fixture.")
- `packages/runtime/src/__tests__/fixture-replay.test.ts` (4 tests) — G02 해소, G15 (CI fixture-only) 만족
- `packages/types/src/tool.ts` — D10 Tool 메타 4 필드 (`isConcurrencySafe?`/`isDestructive?`/`searchHint?`/`contextSchema?`) + D11 `ToolExecutionContext` (sessionId/workingDir/signal/ask). 모두 optional (additive, A.8 MAJOR 위반 0)
- `packages/runtime/src/utils/path-normalize.ts` — D09 `normalizeWorkspacePath` + `WorkspaceEscapeError` (OWASP A01 출처, F09 cleanroom 라인 인용 0건)
- `packages/runtime/src/__tests__/path-normalize.test.ts` (10 tests) — partial-prefix attack 차단 검증

### Slice 1b success criterion (자가 검증 + paranoid review 통과)
- ✅ S01 새 명령: `ANTHROPIC_API_KEY=... pnpm naia-agent "hi"` (real Anthropic) / `ANTHROPIC_BASE_URL=...` gateway 라우팅 / 키 없으면 mock fallback
- ✅ S02 단위 테스트: fixture-replay 4 + path-normalize 10 = +14 (총 142 PASS — protocol 73 + runtime 69)
- ✅ S03 통합 검증: fixture-replay 결정적 재생 (Anthropic API 호출 없이) — G02 해소, G15 (CI fixture-only mode) 만족
- ✅ S04 본 entry

### 매트릭스 §A 승격 (Slice 1b 머지로)
- **A16** Tool 메타 (`isConcurrencySafe?`/`isDestructive?`/`searchHint?`/`contextSchema?`) — D10 §D → §A. 출처: cc 분석 + Vercel + Mastra
- **A17** Tool context schema (sessionId/workingDir/signal/ask) — D11/D05 §D → §A. 출처: opencode + Vercel `ToolExecutionOptions`
- **A18** Workspace sentinel — D09 §D → §A. 출처: cleanroom-cc deep-audit F3 fix (OWASP A01 재근거)
- **A19** Fixture-replay minimal (StreamPlayer + 정규형 fixture) — C21 부분 §C → §A 부분. 정식 framework는 Slice 5

### Paranoid review fix (2건 즉시 적용)
- F11 graceful: SDK load 실패 시 stderr 경고 + mock fallback (hard crash 방지)
- fixture notes 정정: "naia LLMStreamChunk normalized form (NOT raw SDK shape)"

### Slice 2 follow-up (paranoid review 권고)
- D11 orphan 해소 (`ToolExecutor.execute(invocation, ctx?)` 시그니처 확장)
- D09 추가 케이스 (Windows UNC / null byte / symlink realpath)
- F11 fixture 재녹화 (실 SDK 응답 녹음 — Slice 5에서 자동화)

### 사용자 검증 안내 (직접 테스트)

**환경변수**:
```bash
export ANTHROPIC_API_KEY=...                    # 진짜 키
export ANTHROPIC_BASE_URL=...                   # (선택) Anthropic-compat gateway
export ANTHROPIC_MODEL=claude-haiku-4-5-20251001 # (선택, 기본값)
```

**실행**:
```bash
pnpm naia-agent "hi"                  # args 모드
echo "1+1?" | pnpm naia-agent          # stdin 모드
pnpm naia-agent                        # REPL 모드
```

**키 없을 때**: mock fallback ("Hello! I'm naia-agent in mock mode" 출력).

**참고**: naia-agent는 표준 `ANTHROPIC_API_KEY` 환경변수만 사용. 외부 도구·gateway 의존 0. 사용자가 자체 키 또는 Anthropic-compat gateway URL을 직접 환경변수로 제공.

### Sub-issues closed
- closes #12 (sub-4 real AnthropicClient + smoke:real-agent)
- closes #13 (sub-5 fixture-replay 1건 + StreamPlayer)
- closes #14 (sub-6 D09/D10/D11 ingrain + 매트릭스 §A 승격)
- closes #8 (Slice 1 메인 — 1a + 1b 모두 종료)

## [Slice 1a] — 2026-04-25 — bin/naia-agent skeleton (mock-only)

**R3 진입.** naia-agent를 처음으로 사용자 명령으로 호출 가능한 도구로 만듦.

### Added
- `bin/naia-agent.ts` — REPL/stdin/args 분기 entry (mock LLM)
- `packages/runtime/src/host/create-host.ts` — host factory (DI 단순 주입, Mastra/opencode 매트릭스 §C22 단순화 채택)
- `packages/runtime/src/host/index.ts` + runtime index re-export
- `package.json scripts.naia-agent` (`tsx bin/naia-agent.ts`)
- `packages/runtime/src/__tests__/create-host.test.ts` (5 tests)

### Slice 1a success criterion (자가 검증 + paranoid review 통과)
- ✅ S01 새 명령: `pnpm naia-agent "hi"` / `echo "hi" | pnpm naia-agent` / `pnpm naia-agent` (REPL)
- ✅ S02 단위 테스트: create-host.test.ts 5 cases (총 128 PASS — protocol 73 + runtime 55)
- ✅ S03 통합 검증: `pnpm smoke:agent` 회귀 PASS + `pnpm run check:harness-sync` PASS
- ✅ S04 본 entry

### Paranoid review fix (2건 즉시 적용)
- P3: parseArgs `--` terminator 지원
- P7: createHost default logLevel "info" → "warn" 일관성

### 매트릭스 영향
- 해소: G01 (bin/naia-agent 진입점) — F08 자동 해제 trigger 충족
- §C22 (DI 단순화) — service factory 함수 패턴 채택, §A 승격은 Slice 1b에서 묶음
- F09 준수: cleanroom 코드 인용 0건 (bin/host 모두 자체 작성)
- F11 영향 없음: SDK import 0건 (mock only)

### Sub-issues closed
- closes #9 (sub-1 bin entry)
- closes #10 (sub-2 host factory)
- closes #11 (sub-3 단위 테스트 + 회귀)

### Slice 1b 예고
- real Anthropic / NAIA gateway 통합 (`NAIA_GATEWAY_URL` + `GEMINI_API_KEY`)
- fixture-replay 1건 + StreamPlayer 골격
- D09/D10/D11 P0 ingrain

## [Plan v2] — 2026-04-25 — Cross-review 적용 (Option A light)

**3-perspective cross-review** (architect + reference-driven + paranoid auditor) + 추가 ref 3개 검토(Mastra/LangGraph/Vercel) 결과 반영. **Option A (가벼운 buffer)** 채택.

### 매트릭스 변경
- §D 신규 9건: D09 (workspace sentinel) P0 / D10 (Tool 메타) P0 / D11~D17 (Tool context, onStepFinish, 3중 방어, Eval scorers, Memory tiers, Prompt cache C04 격상, Provider fallback)
- §B 신규 6건: B17~B22 (Mastra monorepo / Mastra Studio / LangChain core / StateGraph reducer / Vercel multi-provider / cleanroom 라인 복붙)
- §C04 → §D16 격상 (Vercel cache_control 영향)
- §F05 신규: cleanroom 폐기 대응 plan (archived 2025-03)
- §G 점수표: Mastra ★★★★★, Vercel ★★★★, LangGraph ★★★ 추가

### 새 forbidden_actions
- F01 보안 예외: CVE 패치 차단 면제 (4-repo plan A.13)
- F09: cleanroom 단독 의존 금지 (OWASP/RFC 출처 cross-reference 강제)
- F11: SDK breaking 사전 감지 (Anthropic SDK minor+ bump 시 fixture 재녹화)

### 새 success criterion
- G15: CI fixture-only mode default (API key 노출 방지)

### Slice spine 변경
- Slice 1 → 1a (mock-only) / 1b (real Anthropic + fixture-replay) 분할 — 위험 격리
- Slice 1b에 D09/D10/D11 P0 ingrain
- Slice 3에 G06 cross-repo P0 gate 명시 (alpha-memory stub 해소 전 진입 차단)
- R3+ Slice 6/7/8/9/10 outline 신설 (Eval framework / Tool meta+context / Hook 28-event / Task framework / naia-os sidecar)

### 신규 산출물 (`.agents/progress/refs/`)
- `cc-cleanroom-security-audit-2026-04-25.md` (F1~F4 미완성 stub 발견, 악성 0건)
- `cc-cleanroom-deep-audit-2026-04-25.md` (F5~F12 LLM 환각/silent fail + 8 파일 블랙리스트)
- `mastra-review.md` (★★★★★ Eval/Memory tiers/Tool context)
- `langgraphjs-review.md` (★★★ Checkpoint/Sub-agent/Interrupt)
- `vercel-ai-sdk-review.md` (★★★★ ToolLoopAgent/onStepFinish)

### 의도적 제외 (백로그 / R3+)
- D14 Eval scorers 정식 framework (R3.1)
- D12/D13 Task/Hook framework (R3.3/3.4)
- D17 needs-approval 단순화 (Vercel deprecated, 우리 Tier T0~T3 우월)
- 24h enforcement 자동화 (1인 환경 권고만)
- Mastra DynamicArgument / StateGraph reducer / Vercel multi-provider 직접 의존

코드 변경 0줄. 매트릭스 + agents-rules + AGENTS.md(+4 mirror auto) + r1-slice-spine + CHANGELOG only.

## [Slice 0] — 2026-04-25 — Structure / Dev env

**R2 — 인프라 정비.** 코드 0줄 변경. 다음 슬라이스 진입을 위한 거버넌스·CI 정비.

### Added
- `.github/CODEOWNERS` — 1인 maintainer 명시 + 핵심 영역(types/protocol, AGENTS.md, sync script, .agents/) 마킹
- `.github/PULL_REQUEST_TEMPLATE.md` — minimal (Summary / Test plan / 4 체크박스)
- `package.json scripts`:
  - `test` — `pnpm -r --if-present test` (전 패키지 vitest 실행)
  - `check:harness-sync` — `sync-harness-mirrors.sh --check` (CI invariant)
  - `sync:harness` — mirror 강제 재생성
- `.github/workflows/ci.yml` 보강 — `check:harness-sync` + `pnpm test` 단계 추가

### Slice 0 success criterion (자가 검증 통과)
- ✅ S01 새 실행 가능 명령: `pnpm run check:harness-sync` (mirror 동기 검증)
- ✅ S02 단위 테스트: 기존 protocol 73 + runtime 50 = 123 tests (CI에서 실행)
- ✅ S03 통합 검증: `check:harness-sync` PASS (CI workflow에 통합)
- ✅ S04 CHANGELOG entry: 본 entry

매트릭스 영향: S05 (CODEOWNERS), S06 (PR template), S09 (smoke:real-agent placeholder는 부정직하다는 cross-review 권고로 미도입), S10 (CHANGELOG 포맷) 해소. Sub-issue #7의 R2 항목 일부 close.

## 0.1.0 — 2026-04-21 — Phase 1 freeze

**Phase 1 exit.** Public contracts now subject to the additive-only rule
(plan v6 A.5). Breaking shape changes require MAJOR bump and 4-week
advance notice (plan A.11 communication policy).

### `@nextain/agent-types`
First stable-shape release. Includes:
- `LLMClient` (generate, stream) + request/response/stream-chunk shapes
- `LLMContentBlock` (text, thinking, redacted_thinking, tool_use, tool_result, image)
- `LLMContentDelta` (text_delta, thinking_delta, input_json_delta)
- `MemoryProvider` (encode, recall, consolidate, close) + 7 optional Capability interfaces + `isCapable()` guard
- `ToolExecutor`, `ToolInvocation`, `TierLevel` (T0-T3), `TierPolicy`
- `ApprovalBroker`, `ApprovalRequest`, `ApprovalDecision` + `APPROVAL_DEFAULT_TIMEOUT_MS`
- `HostContext`, `HostContextCore`, `DeviceIdentity`
- `Event`, `ErrorEvent`, `Severity`, `VoiceEvent` family
- `Logger`, `Tracer`, `Span`, `SpanContext`, `Meter`, `Counter`, `Histogram`
- `Session`, `SessionState`, `SessionEvent`, `SessionTransition`, `ALLOWED_TRANSITIONS`, `isTerminalSessionState`

Zero-runtime-dep (package contains no external runtime imports; a few
typed constants like `APPROVAL_DEFAULT_TIMEOUT_MS` and `ALLOWED_TRANSITIONS`
are compile-time data, not dependencies). ESM-only. Node ≥ 22.

### `@nextain/agent-protocol`
First release. Wire protocol for host ↔ agent stdio communication.
- `StdioFrame<P>` + `FrameType` (request/response/event)
- `encodeFrame`, `parseFrame`
- `ProtocolError`
- `PROTOCOL_VERSION = "1"`

### `@nextain/agent-core`
Scaffold release. Re-exports key contracts from `@nextain/agent-types`.
Runtime loop implementation deferred to Phase 2 X3.

### `@nextain/agent-providers`
First release with `AnthropicClient` implementing `LLMClient` over
`@anthropic-ai/sdk` (peerDependency ^0.39.0).
- Subpath export: `@nextain/agent-providers/anthropic`
- Full block/delta/stop-reason round-trip
- Usage tracking including cache_read/write tokens
- AbortSignal passthrough

### `@nextain/agent-observability`
First release with default contract impls:
- `ConsoleLogger` (JSON lines to stderr, level filter)
- `SilentLogger` (discards all — for tests)
- `NoopTracer`
- `InMemoryMeter` + `InMemoryCounter` + `InMemoryHistogram` (with snapshot)

## Freeze policy (effective 0.1.0)

1. **Additive-only** at MINOR. New optional fields, new types, new interfaces OK.
2. **Removal / type change / semantics change** requires MAJOR bump + advance notice per plan A.11.
3. **Capability interfaces** (MemoryProvider Capabilities) may be added at MINOR. Removal is MAJOR.
4. `@nextain/agent-protocol` has independent semver — wire breaks do not force a types MAJOR.
5. Pre-v0.1 code (0.0.x) was exempt from this rule; history below is informational.

## 0.0.1 (unreleased workspace-only) — 2026-04-21

MVM iterations. See git history. Key milestones:
- MVM #1: alpha-memory audit + MemoryProvider façade (`a4055f2`)
- MVM #2: types initial shape + LLMClient contract (`ef55d21`)
- MVM #3a: AnthropicClient implementation (`2559db5` with 2-round review fixes)
- MVM #3b: smoke test (dry-run + live) (`f627373`)
- MVM #4: Flatpak baseline confirmed via naia-os CI
- MVM #5: PR templates across 4 repos
- Scope rename `@naia-agent/*` → `@nextain/agent-*` (`b4e34c2`)
- Phase 1 T1–T7 contracts (VoiceEvent `047822b`, full T5 `c2949dd`, protocol `d2dd51f`, observability `c05b191`, ARCHITECTURE.md `7d6f22c`)
