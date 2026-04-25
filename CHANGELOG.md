# Changelog

All notable changes to `@nextain/agent-*` packages.

Each package follows independent SemVer. Monorepo-wide entries below.

Slice entries (R1+) follow the format: `## [Slice N] — YYYY-MM-DD — short title`.

## [Unreleased]

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
