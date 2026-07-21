# Codex app-server dynamic tool live smoke — 2026-07-21

## Snapshot

- Source commit: `7018227148e903849dc81008d8e583d731b2a4fb`
- Model: `gpt-5.4`
- Transport: local `codex app-server` using the signed-in Codex CLI
- Tool: deterministic `get_time` executor result `2026-07-21T11:30:00+09:00`

## Invocation contract

`runCodexAppServerTurn` advertised one tier-`none` dynamic tool, requested one
tool call, returned the executor result to the same turn, and concatenated all
streamed text chunks before asserting the final response. Authentication files
and tokens were neither read nor printed.

## Normalized result

```text
toolUse count=1 name=get_time timezone=Asia/Seoul
toolResult count=1 name=get_time success=true output=2026-07-21T11:30:00+09:00
text contains="NAIA_DYNAMIC_TOOL_OK 2026-07-21T11:30:00+09:00"
completed=true
process exit=0
```

The raw per-run call identifier is intentionally omitted because it is not part
of the stable acceptance contract. The smoke verifies the real app-server/model
path; deterministic contract tests separately cover replay deduplication,
malformed input, unavailable tools, and error responses.
