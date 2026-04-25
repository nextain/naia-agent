# Changelog

All notable changes to `@nextain/agent-*` packages.

Each package follows independent SemVer. Monorepo-wide entries below.

Slice entries (R1+) follow the format: `## [Slice N] — YYYY-MM-DD — short title`.

## [Unreleased]

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
