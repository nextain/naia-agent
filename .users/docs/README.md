# `.users/docs/` — User-facing docs (multi-language mirror)

This directory hosts **user-facing** translations of the documents in
`docs/`. The English originals in `docs/` are the canonical engineering
SoT (read by tooling, AI maintainers, contributors). The translations
here exist for end users and Korean-first contributors.

## Structure

```
.users/docs/
├── README.md       # this file
├── ko/             # Korean
│   ├── user-guide.md
│   └── …
└── (future) ja/    # Japanese
    └── (future) zh/    # Chinese
```

## Rules

1. **`docs/<file>.md` (English)** is the canonical source. Edit there first.
2. **`.users/docs/<lang>/<file>.md`** is a translation mirror. When the
   English source moves, the mirrors move with it.
3. Each translated file MUST start with a language chooser:
   ```markdown
   > **Languages**: [English](../../../docs/<file>.md) · 한국어 (this file)
   ```
4. Stale mirrors are flagged in the file's frontmatter or top note. If
   a translation falls behind the English source, mark it explicitly.

## Why this split?

`docs/` lives under the engineering surface (AI tooling reads it, CI
gates fire on it, OSS readers expect English-first). `.users/` is the
user-facing surface — Korean, future Japanese / Chinese / etc. — and
must not gate engineering work. The two have different audiences and
different change cadences; mixing them in one directory creates the
hybrid-language confusion we just cleaned up.

## Current mirrors

All 8 docs have full Korean mirrors as of 2026-05-20 (Slice 3-XR-Docs).

| Language | File | Status |
|---|---|---|
| Korean | [`ko/user-guide.md`](ko/user-guide.md) | up-to-date |
| Korean | [`ko/adapter-contract.md`](ko/adapter-contract.md) | up-to-date |
| Korean | [`ko/architecture-hybrid.md`](ko/architecture-hybrid.md) | up-to-date |
| Korean | [`ko/llm-config-standard.md`](ko/llm-config-standard.md) | up-to-date |
| Korean | [`ko/log-policy.md`](ko/log-policy.md) | up-to-date |
| Korean | [`ko/naia-memory-wire.md`](ko/naia-memory-wire.md) | up-to-date |
| Korean | [`ko/stream-protocol.md`](ko/stream-protocol.md) | up-to-date |
| Korean | [`ko/vision-statement.md`](ko/vision-statement.md) | up-to-date |

Docs NOT mirrored yet (English-only is sufficient for now — limited
Korean reader value):

- `ARCHITECTURE.md` — R0~R3 canonical (superseded by `architecture-hybrid.md` R4)
- `agent-loop-design.md` — internal D1~D8 design decisions
- `auth-not-logged-in.md` — short Anthropic-OAuth note
- `hosting-guide.md` — host embedding guide
- `memory-provider-audit.md` — internal façade audit
- `voice-pipeline-audit.md` — voice-pipeline status (overlaps with Slice 3-XR-Voice plan)

These can land in `.users/docs/ko/` on demand if a Korean reader
asks. They were skipped this round because they're already English-
canonical or are internal design records with thin user value.

Future languages (`ja/`, `zh/`, …) land under `.users/docs/<lang>/`
with the same lang-chooser pattern.
