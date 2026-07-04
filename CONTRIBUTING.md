# Contributing to naia-agent

Thanks for your interest. This guide covers the practical steps to get the
repo running and the conventions a change is expected to follow. It is aimed
at someone comfortable with TypeScript who is new to this codebase.

## Ground rules

`naia-agent` is a runtime engine, not a product. The most important rule is
the boundary: the core runtime talks to the outside world only through the
interfaces in `@nextain/agent-types`. A change that makes `packages/core` or
`packages/runtime` import a concrete LLM provider, a specific memory backend,
or a host UI is almost always wrong — inject it instead. The bundled CLI in
`bin/naia-agent.ts` is the one place allowed to import concrete
implementations (including `@nextain/naia-memory`) directly.

Keep changes surgical. Touch what the task needs and leave the rest alone.
If a design decision is ambiguous, open an issue and ask before writing code.

## Setup

Requirements: Node 22 or newer, and pnpm. The repo is an ESM-only
(ECMAScript Modules) TypeScript workspace.

```bash
pnpm install
pnpm build      # tsc --build across every package
pnpm test       # vitest across every package
```

A fast sanity check that needs no API key and no network:

```bash
pnpm smoke:agent      # runs examples/minimal-host.ts against in-process mocks
```

## Where things live

- `packages/types` — the contracts. Change these carefully; they are frozen
  additive-only (see below).
- `packages/core` — the `Agent` loop. Start reading at
  `packages/core/src/agent.ts`.
- `packages/runtime` — concrete tool executors, the skill loader, the MCP
  client, and CLI helpers.
- `packages/cli-app` and `bin/naia-agent.ts` — the command-line host.
- `examples/` — runnable hosts that double as smoke tests.
- `docs/` — engineering docs (English canonical). `.users/docs/` mirrors the
  user-facing subset in multiple languages.

## Making a change

Every non-trivial change is expected to arrive with four things together:

1. **A runnable user-facing behaviour** — for a CLI change, one new
   `pnpm naia-agent ...` invocation that does something a user can see.
2. **At least one unit test** — vitest, to catch regressions.
3. **At least one integration check** — a fixture replay, a real-LLM smoke
   guarded by an API key being present, or a real backend call.
4. **A CHANGELOG entry** — a line in `CHANGELOG.md` describing the
   user-facing change.

A change that only adds a unit test on top of a mock, without exercising the
real path, is not enough — wire the integration check at the same time.

## Contract stability

`@nextain/agent-types` and the wire protocol are frozen as **additive-only**.
New optional fields and new capability interfaces are fine. Renaming or
removing an existing field, or changing a type's shape, is a breaking change
that requires a MAJOR version bump and advance notice — raise it in an issue
first rather than in a surprise change.

If you bump the provider SDK (`@ai-sdk/anthropic` or the `ai` package) by a
minor version or more, re-record the provider fixtures and verify stream
replay still passes; SDK stream changes have broken the runtime before.

## Conventions

- **Language**: TypeScript, ESM only, `strict` mode.
- **Commits**: Conventional Commits, e.g. `feat(core): add handoff export`.
- **Secrets**: never print an API key value, and never commit a key into a
  fixture or an example. Key names are fine; values are not.
- **Paths in docs**: use repository-relative or workspace-relative paths, not
  local absolute paths, so the docs stay portable.

## Reporting issues

Bug reports and design questions are welcome in the issue tracker. For a bug,
include the command you ran, what you expected, and what happened — a failing
`examples/` host or a minimal repro is the fastest path to a fix.

## License

By contributing you agree that your contributions are licensed under the
Apache License 2.0, the same license as the project.
