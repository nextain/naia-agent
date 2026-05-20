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

| Language | File | Status |
|---|---|---|
| Korean | [`ko/user-guide.md`](ko/user-guide.md) | up-to-date with `docs/user-guide.md` (2026-05-20) |

Future docs (adapter-contract / architecture-hybrid / llm-config-standard
/ log-policy / naia-memory-wire / stream-protocol / vision-statement)
will be English-only in `docs/` first; Korean mirrors land in a follow-
on slice once the English sources are stable.
