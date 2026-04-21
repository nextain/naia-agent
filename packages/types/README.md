# @naia-agent/types

Zero-runtime-dep public contracts for the Naia ecosystem.

**ESM-only, Node ≥ 22.** Requires TypeScript 5.0+.

This package contains only types — no runtime code. It is safe to depend on from any consumer without pulling LLM SDKs, filesystem libraries, or other runtime dependencies.

## Contents

- `LLMClient`, `LLMRequest`, `LLMResponse`, `LLMStreamChunk`, …
- `MemoryProvider` + 7 optional Capability interfaces, `isCapable()` guard
- `Event`, `ErrorEvent`, `Severity`

## Usage

```typescript
import type { LLMClient, MemoryProvider, Event } from "@naia-agent/types";

function makeAgent(llm: LLMClient, memory: MemoryProvider) {
  // ... implementation code lives elsewhere; this package defines shapes only.
}
```

## Part of the Naia 4-repo ecosystem

- [naia-agent](https://github.com/nextain/naia-agent) — runtime engine (this repo)
- [naia-os](https://github.com/nextain/naia-os) — Tauri desktop shell
- [naia-adk](https://github.com/nextain/naia-adk) — workspace format + skill library
- [alpha-memory](https://github.com/nextain/alpha-memory) — reference `MemoryProvider` implementation

## License

Apache 2.0.
