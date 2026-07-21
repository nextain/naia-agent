# Codex app-server dynamic tool live smoke — 2026-07-21

## Snapshot

- Source commit: `541614f2396bcf156c3344ed7a82b6a5babdeb60`
- Model: `gpt-5.4`
- Transport: local `codex app-server` using the signed-in Codex CLI
- Tool: deterministic `get_time` executor result `2026-07-21T11:30:00+09:00`

## Exact invocation

```bash
pnpm build
node scripts/builds/codex-dynamic-tool-smoke.mjs
```

Both commands exited `0`. The runner is tracked at the source commit above, so
the live probe can be repeated without reconstructing an inline script.

## Invocation contract

`runCodexAppServerTurn` advertised one tier-`none` dynamic tool, requested one
tool call, returned the executor result to the same turn, and concatenated all
streamed text chunks before asserting the final response. Authentication files
and tokens were neither read nor printed.

## Captured stdout

```json
{
  "model": "gpt-5.4",
  "executions": 1,
  "toolUse": [
    { "name": "get_time", "args": { "timezone": "Asia/Seoul" } }
  ],
  "toolResult": [
    {
      "name": "get_time",
      "output": "2026-07-21T11:30:00+09:00",
      "success": true
    }
  ],
  "text": "NAIA_DYNAMIC_TOOL_OK 2026-07-21T11:30:00+09:00",
  "completed": true
}
```

The raw per-run call identifier is intentionally omitted because it is not part
of the stable acceptance contract. The smoke verifies the real app-server/model
path; deterministic contract tests separately cover replay deduplication,
malformed input, unavailable tools, and error responses.
