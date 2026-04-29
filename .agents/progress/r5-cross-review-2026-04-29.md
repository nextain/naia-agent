---
name: R5 Slice 5.x.6 — Cross-review + Tier A fixes + Tier B backlog
description: 3-perspective cross-review (architect / reference-driven / paranoid) 결과 + 즉시 적용 가능한 surgical fix (Tier A) + types 변경 필요한 follow-up (Tier B) backlog
type: project
session_id: 4c96aad1-d830-44c7-bfcc-2d77c2dff50c
phase: R5 Slice 5.x.6
status: tier_a_applied
created: 2026-04-29
---

# R5 Slice 5.x.6 — Cross-review

## 0. 요약

**verdict 통합**: APPROVED_WITH_CONDITIONS (architect) + APPROVED_WITH_RECOMMENDATIONS (reference) + NEEDS_REVISION (paranoid). P0 5건은 모두 **Tier A** (surgical fix, 단일 commit) 으로 해결 가능. P1 일부 + P2는 **Tier B** (LLMRequest types 확장 등) 로 별도 작업 backlog.

**본 slice 산출물**:
- Tier A 8건 적용 commit (5.x.6 cross-review fixes)
- Tier B 8건 매트릭스 backlog (D45~D52 후보, 본 progress §3에 inventory)

---

## 1. 3-perspective cross-review 결과

### 1.1 Architect (Plan agent) — APPROVED_WITH_CONDITIONS

**P0 3건**:
- **A-P0-1**: V2/V3 runtime detection이 structural sniff (`fromV2Usage`) → silent token miscount 위험. specificationVersion discriminant 도입 필요
- **A-P0-2**: `dist/` 잔존 5 provider artifacts → npm publish 시 deleted code 배포 위험. clean script 필요
- **A-P0-3**: peerDependencies + optionalDependencies 이중 등록이 B21 demote 주장 ("zero-runtime-dep")과 모순 → 일관성 정리 필요

**P1 4건**:
- A-P1-1: `fromV2*` naming은 V3 미반영 → rename
- A-P1-2: `LLMResponse.provider` 부재 (50+ provider 식별 불가) — types lock으로 미적용, future D
- A-P1-3: `safeParseJson` raw string fallback → narrowing 손실
- A-P1-4: `toolName: ""` fragile 가정 (Bedrock 강제 검증 가능)

**P2 3건**: randomId crypto.randomUUID 가능 / lazy-start 흐름 단순화 / README provider matrix vs optionalDeps mismatch

### 1.2 Reference-driven (vercel:ai-architect) — APPROVED_WITH_RECOMMENDATIONS

**P0 2건**:
- **R-P0-1**: V2 Anthropic의 `cacheReadTokens`는 `inputTokenDetails.cacheReadTokens` 에 위치 (V2 spec의 `cachedInputTokens` 아님) → cache hit 시 silent 0
- **R-P0-2**: `tool-call` aggregate part drop이 stream-friendly provider 가정 → Bedrock 등 input deltas 안 emit하는 provider 도구 호출 silent 손실

**P1 6건**:
- R-P1-1: `providerOptions` round-trip 부재 (Vercel 핵심 패턴, cache_control / thinking budgets / reasoning-effort)
- R-P1-2: Top-level system collapse loses cache breakpoints
- R-P1-3: `toolName: ""` real correctness risk
- R-P1-4: `toolChoice` not forwarded
- R-P1-5: `safeParseJson` should use `@ai-sdk/provider-utils parseJSON`
- R-P1-6: `useChat`-shape pivot closed off (document non-goal)

**P2 4건**: `includeRawChunks` 진단용 / `tool-approval-request` drop / Provider matrix gaps (AI Gateway 추천) / `onStepFinish` 의도적 비대칭

### 1.3 Paranoid (general-purpose auditor) — NEEDS_REVISION

**P0 1건**:
- **P-P0-1**: `dist/` 잔존 (architect P0-2와 동일)

**P1 5건**:
- P-P1-1: V4+ silent degradation hole (stream-part / content / finish-reason `default` drops). strict opt-in 모드 필요
- P-P1-2: Stream `error` throw 시 `end` chunk skip — LLMClient 계약 미문서화
- P-P1-3: `reader.cancel()` 누락 → consumer early-exit 시 upstream HTTP/SSE 연결 leak
- P-P1-4: `optionalDependencies` 자동설치 attack surface (정확 버전 pin + onlyBuiltDependencies 가드)
- P-P1-5: F11 fixture-replay rule misfires (현 fixture는 generic LLMStreamChunk 라 F11 trigger 무관, 단 adapter-level Vercel SDK shape fixture는 부재)

**P2 6건**: apiKey error path / CLI binary failure / Math.random / Map<string,number> bounded / F09 cleanroom 회피 OK / safeParseJson observability

---

## 2. Tier A 적용 결과 (본 commit)

| # | 항목 | 출처 | 위치 |
|---|---|---|---|
| 1 | dist/ 잔존 정리 + `clean`/`rebuild` script 추가 | A-P0-2, P-P0-1 | `packages/providers/{dist/,package.json}` |
| 2 | specificationVersion discriminant — `#spec` 필드 + helpers에 spec param | A-P0-1 | `vercel-client.ts` constructor + `fromVercelFinishReason` + `fromVercelUsage` |
| 3 | V2 cacheReadTokens fallback (inputTokenDetails 경로) | R-P0-1 | `vercel-client.ts fromVercelUsage` V2 branch |
| 4 | `tool-call` aggregate fallback (id unknown 시 synthesize content_block_* trio) | R-P0-2 | `vercel-client.ts stream()` |
| 5 | `reader.cancel()` finally 추가 | P-P1-3 | `vercel-client.ts stream()` |
| 6 | `fromV2*` → `fromVercel*` rename (legacy alias 보존) | A-P1-1 | `vercel-client.ts` (5.x.7+에서 legacy 제거) |
| 7 | `toolName: ""` JSDoc 정직 다운그레이드 (Anthropic-only verified) | A-P1-4, R-P1-3 | `vercel-client.ts toV2Message` |
| 8 | README + 매트릭스 B21 정정 (5-provider default bundle 명시, "zero-runtime-dep" 주장 제거) | A-P0-3 | `README.md` + `ref-adoption-matrix.md B21` |

**테스트 보강**: 기존 25 unit + 11 신규 = 36 unit
- `fromVercelUsage` V2 / V3 / cacheReadTokens fallback / `inputTokenDetails` 경로 (P0-4 회귀 방지)
- `fromVercelFinishReason` V2 string / V3 object / undefined fallback
- `tool-call` aggregate fallback (P0-5 회귀 방지)
- `tool-call` 중복 emit 방지 (tool-input-* 이미 처리한 경우)
- `reader.cancel()` 호출 검증 (P1-C 회귀 방지)

**회귀**: 459 PASS (이전 448 + 11 신규, 0 회귀)

**의도적 미적용**:
- `safeParseJson` → `@ai-sdk/provider-utils parseJSON` 교체 (R-P1-5): provider-utils가 transitive로 hoisted 되어 있지만 직접 의존을 명시하면 지금 peer dep 정책과 충돌. Tier B로 이연.

---

## 3. Tier B 매트릭스 backlog (D45~D52 후보)

LLMRequest/Response 타입 확장 또는 인프라 신규 작업 — R5 범위 밖 follow-up.

| 후보 ID | 항목 | 근거 (출처) | 우선순위 |
|---|---|---|---|
| **D45** | `LLMRequest.providerOptions: Record<string, Record<string, unknown>>` round-trip — Vercel canonical 패턴, cache_control / thinking budgets / reasoning-effort 통일 | R-P1-1 | **P1** (Vercel core pattern) |
| **D46** | `LLMRequest.toolChoice` (auto/none/required/tool) | R-P1-4 | P1 |
| **D47** | `LLMResponse.provider` 50+ provider 식별 가능 | A-P1-2 | P1 |
| **D48** | error part throw 시 `end` chunk yield 계약 (또는 `StopReason: "error"` 추가) | P-P1-2 | P1 |
| **D49** | adapter-level Vercel SDK shape fixture (V2/V3 raw stream-part) — F11 v3 | P-P1-5 | P1 |
| **D50** | V4+ strict mode opt-in (`new VercelClient(model, { strict: true })`) — unknown stream-part / content variant 시 throw | P-P1-1 | P2 |
| **D51** | `optionalDependencies` exact pin + `pnpm.onlyBuiltDependencies: []` supply chain guard | P-P1-4 | P2 |
| **D52** | top-level system 다중 메시지 분리 (Anthropic cache_control 메시지별 적용) | R-P1-2 | P2 |

기존 reserved D45 (RunPod naia-anyllm gateway 통합 — 사용자 directive 별도 논의)는 **D45 → D53로 이동** (RunPod은 별도 외부 시스템 통합이라 본 인터페이스 작업과 분리).

---

## 4. 본 R5 lock 시점

본 cross-review commit (Tier A 8건 적용) 으로 **R5 lock**.

남은 R5 산출물:
- ✅ Slice 5.x.0 docs lock (commit `98a81df`)
- ✅ Slice 5.x.1 VercelClient adapter MVP (commit `c153a6d`)
- ✅ Slice 5.x.2 AnthropicClient deprecate (commit `c18678a`)
- ✅ Slice 5.x.3 Gemini/OpenAICompat/Vertex deprecate (commit `8f09905`)
- ✅ Slice 5.x.4 자체 5개 제거 + V2/V3 + 자동설치 + cross-platform (commit `e566e6e`)
- ✅ Slice 5.x.6 cross-review fixes (본 commit)

---

## 5. R6 후보 (R5 종료 후)

본 review에서 식별된 Tier B 8건 + 사용자 deferred RunPod 통합 = R6 candidate items.

**우선순위 권고**:
1. **D45 providerOptions** — Vercel 핵심 패턴, cache_control 즉시 효과
2. **D49 adapter-level fixture** — F11 v3, breaking SDK detection 자동화
3. **D47 LLMResponse.provider** — 50+ provider observability 시급
4. **D53 RunPod naia-anyllm gateway** — 사용자 토큰 부족 해결
5. 나머지 (D46 toolChoice / D48 error 계약 / D50 strict mode / D51 supply chain / D52 multi-system) — 우선순위 낮음

R6 plan은 본 R5 lock 후 사용자 directive로 시작.
