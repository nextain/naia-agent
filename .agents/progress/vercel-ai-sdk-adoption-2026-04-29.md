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

### 5.x.1 — `VercelClient` adapter MVP

**핵심 작업**: `LanguageModelV2` → `LLMClient` 변환 어댑터 구현. Vercel SDK 1개 model로 우선 검증.

| 항목 | 상세 |
|---|---|
| 신규 파일 | `packages/providers/src/vercel-client.ts` (`VercelClient` 구현) |
| 신규 파일 | `packages/providers/src/__tests__/vercel-client.test.ts` (unit) |
| 신규 fixture | `packages/providers/src/__fixtures__/vercel-anthropic-1turn.json` |
| package.json 변경 | `peerDependencies` `optional`: `ai@^6.0.0`, `@ai-sdk/anthropic@^2.0.0` |
| package.json | `devDependencies`: 동일 추가 (테스트용) |
| package.json `exports` | `./vercel`: `./dist/vercel-client.js` |
| index.ts | `export { VercelClient }` |
| **S01 신규 명령** | `pnpm naia-agent --provider=vercel-anthropic "hi"` (bin에 추가) |
| **S02 unit** | `LLMRequest` → `LanguageModelV2.doGenerate()/doStream()` 변환 + 역변환 (text / tool_use / thinking / image / usage / stopReason) |
| **S03 통합** | real Anthropic via Vercel SDK (ANTHROPIC_API_KEY 있을 때) + fixture-replay (KEY 없을 때 G15 강제) |
| **S04** | `CHANGELOG.md` Slice 5.x.1 entry |
| 매트릭스 ID 인용 | `feat(providers): VercelClient adapter MVP — fixes D44 §1` |

**design 결정 (Slice 5.x.1 사전 lock)**:

- `VercelClient` 생성자: `{ model: LanguageModelV2 }` 1개 인자만. host가 `createAnthropic({apiKey})('claude-opus-4-7')` 같은 Vercel model factory 결과를 주입.
- `generate()` 구현: `model.doGenerate({prompt, abortSignal})` → `LLMResponse` 변환. content block 매핑은 Anthropic shape이 LLMContentBlock과 1:1 가까움.
- `stream()` 구현: `model.doStream({prompt, abortSignal})` AsyncIterable → `LLMStreamChunk` 변환. Vercel은 `LanguageModelV2StreamPart` (text-start/delta/end, tool-input-start/delta/end, finish, usage 등)를 emit, 우리 SSE shape (start → content_block_start → content_block_delta → content_block_stop → usage → end)로 매핑.
- 알 수 없는 part는 **drop** (LLMClient 정책: "unknown blocks should be dropped at adapter boundary, not passed through with a fallback union arm").
- `thoughtSignature` (Gemini 3) — Phase 5 Day 7.1 필드 보존. Vercel `providerMetadata` 통해 round-trip.

### 5.x.2 — 자체 `anthropic.ts` deprecate → Vercel-backed

| 항목 | 상세 |
|---|---|
| 변경 | `bin/naia-agent.ts` `detectRealLLM` — ANTHROPIC_API_KEY 발견 시 `VercelClient + createAnthropic()` 우선 |
| deprecate | `packages/providers/src/anthropic.ts` — `@deprecated` JSDoc + 다음 minor에서 제거 명시 |
| F11 준수 | `__fixtures__/anthropic-1turn.json` Vercel-backed로 재녹화 + StreamPlayer 재생 검증 |
| 회귀 | 250 PASS 유지 |
| **S01** | `pnpm naia-agent "hi"` (기본 path가 Vercel-backed로 전환) |
| **S02** | 기존 anthropic-client.test.ts → VercelClient × Anthropic 통합 테스트로 보강 |
| **S03** | 실 Anthropic 호출 trace (ANTHROPIC_API_KEY 있을 때) |
| **S04** | CHANGELOG entry |

### 5.x.3 — Gemini / OpenAI-compat / Vertex deprecate

3 sub-slices:

- **5.x.3a**: `gemini.ts` deprecate → `@ai-sdk/google` (또는 `ai-sdk-provider-gemini-cli` 구독 path)
- **5.x.3b**: `openai-compat.ts` deprecate → `@ai-sdk/openai-compatible`. Z.ai coding plan = `zhipu-ai-provider`.
- **5.x.3c**: `anthropic-vertex.ts` deprecate → `@ai-sdk/google-vertex` 또는 `@ai-sdk/anthropic` Vertex 모드. **사용자 자체 GCP 환경 검증 필요** (gcloud ADC).

각 sub-slice S01~S04 + G15 만족.

### 5.x.4 — `claude-cli.ts` deprecate → community provider

| 항목 | 상세 |
|---|---|
| 대체 | `ai-sdk-provider-claude-code` (Pro/Max 구독 path 보존) |
| 폐기 | `packages/providers/src/claude-cli.ts` 모든 subprocess wrap 로직 + `_allowInsecureForTest` 등 |
| 제거 | Flatpak/Windows parity 코드 (community provider가 흡수) |
| **S01** | `pnpm naia-agent --provider=claude-code "hi"` (community provider 기반) |
| **S02** | community provider unit (mock) + 회귀 |
| **S03** | 실 Claude Code CLI binary 통합 검증 (사용자 환경) |
| **S04** | CHANGELOG entry |

### 5.x.5 — bin / examples / fixture-replay 일괄 갱신 + 자체 5개 제거

- 자체 5개 provider 파일 + `__tests__/` 제거
- `package.json` `exports` 정리 (Vercel-only 경로 + lab-proxy 2개 + 향후 D43 audio)
- `bin/naia-agent.ts` provider resolution 로직 단순화 (Vercel SDK가 흡수)
- `examples/` 갱신
- README + naia-agent.env.example 갱신
- 회귀 250+ PASS

### 5.x.6 — Cross-review 3-perspective

- **architect**: SOLID / interface 결합도 / peer-dep 패턴 검증
- **reference-driven**: opencode / Mastra / Vercel 본가 패턴 일치도
- **paranoid**: 키 노출 / SDK breaking / fixture drift / F09 cleanroom 단독 의존 회피 / F11 SDK bump 검증

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
