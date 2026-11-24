# Independent adversarial review — context budget CJK retry

Reviewed 2026-11-09 by independent review agent. Scope: the changes to
`budgeted-conversation.ts`, `openai-compat-provider.ts`, and their contract tests.
No production service or network model was accessed.

Initial finding: message budgeting omitted echoed `reasoningContent`, while
retry sizing included it through JSON serialization. This could preserve large
old reasoning payloads and resend the same overflowing request. Resolved in the
reviewed revision: both assembly and retry now use `conversationMessageCost`,
which includes reasoning. The regression test exercises removal of an old
assistant/tool block with a large reasoning payload.

Checked bounded retry (one additional HTTP request), unrelated HTTP 400 failure,
cancellation before retry, system preservation, latest user/tool block integrity,
CJK trimming, English boundary behavior, explicit context-window injection, and
tool/output reservation. No remaining blocking finding in this scope.

Independently reran:

```sh
pnpm exec vitest run src/test/budgeted-conversation.contract.test.ts src/test/uc1-openai-compat.contract.test.ts
```

Result: 2 test files passed, 55 tests passed, exit 0.

Remaining limitations: this is a character heuristic, not a model tokenizer;
image token costs are not estimated. Preserved system/latest user/tool blocks
or fixed tool/output reservations can themselves exceed the context limit, so
the single retry can legitimately fail without reducing the mandatory suffix.
Known context limits must be supplied by the caller; automatic model discovery
is not implemented. These tests do not establish a live vLLM round trip or
completion of unrelated project gates.

Implementation verification (primary agent): before production changes, the two
contract files reported 5 failed / 48 passed (53 total): CJK trimming, latest user
preservation, overflow-success retry, overflow-twice request count, fixed request
reservation. English and unrelated-400 cases passed already. Final run reported
55 passed after adding reasoning/context-limit and cancellation coverage.
`pnpm build` exited 0 using externally repaired development dependencies.
