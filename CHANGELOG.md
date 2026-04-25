# Changelog

All notable changes to `@nextain/agent-*` packages.

Each package follows independent SemVer. Monorepo-wide entries below.

Slice entries (R1+) follow the format: `## [Slice N] — YYYY-MM-DD — short title`.

## [Unreleased]

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
