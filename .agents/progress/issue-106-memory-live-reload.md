# Issue #106 — Runtime memory configuration reload

GitHub: <https://github.com/nextain/naia-agent/issues/106>

## Goal and scope

`ReloadSettings`와 `SetWorkspace`가 main provider만 바꾸고 시작 시 생성한 memory 인스턴스를 계속 쓰던
드리프트를 제거한다. 매 reload에서 structured `llmRoles`와 adapter/embedding 설정을 다시 읽어
MemoryPort, fact extractor, summarizer를 실제 교체한다.

## User and failure scenarios (P01)

- 정상: 실행 중 memory 설정 변경 → RPC reload → 다음 메모리 호출부터 새 구성 사용.
- 진행 중 호출: 기존 recall/save/compact/handoff가 끝난 뒤 flush하고 교체한다.
- 잘못된 역할 또는 backend init 실패: 새 인스턴스를 채택하지 않고 기존 인스턴스를 유지한다.
- workspace 변경 실패: 이전 workspace path/default config/memory를 함께 유지해 교차-workspace 누설을 막는다.
- 종료: 현재 delegate의 진행 중 호출을 기다리고 한 번만 close한다.

## Design (P03)

- `reloadable-memory.ts`가 handler에 주입되는 안정적인 포트이며 delegate만 교체한다.
- 교체 순서는 new calls gate → old in-flight drain → old flush → build/ready next → atomic swap → old close다.
- `compose-agent-deps.mjs`가 reload마다 `loadMemoryConfig`와 `loadLlmRoles`를 호출하고 새 memory를 만든다.
- 신규 구성 실패는 `{ok:false,reloaded:false,retained,...}`로 격리한다.
- gRPC settings 결과에 `memory_reloaded`, `memory_retained`, `memory_status`, `memory_error`를 추가했다.

## Verification (P02/P04)

- `corepack pnpm run build` — pass.
- memory 관련 9개 test file — 74/74 pass (실 gRPC process lifecycle 포함).
- reload/roles/gRPC 묶음 — 57/57 pass.
- 최종 reload/entry regression — 19/19 및 14/14 pass.
- `git diff --check` — pass.

## Status (P05)

Implemented and verified on 2026-08-03. Commit/push는 상위 작업자가 수행하도록 의도적으로 남겨 두었다.

## Follow-up verification (2026-08-03)

- Identical workspace + resolved memory config + `llmRoles` reloads are fingerprinted; 12 repeated startup reloads are no-ops while the active memory is healthy.
- A failed replacement still retains the active instance and its data; a different workspace still triggers a real replacement.
- The diagnostic `echo-system` provider persists the real user episode but not its recursive `SYSTEM_ECHO` assistant payload.
- Local episodic recall combines embedding and length-normalized lexical relevance, keeping an exact compact episode in top-5 against 12 broad high-strength noise episodes.
- Verification: naia-memory full suite 400/400; naia-agent memory/gRPC/Discord suite 85/85; both builds pass; `git diff --check` and conflict-marker scan pass.
