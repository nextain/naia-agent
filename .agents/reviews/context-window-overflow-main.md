# Context window overflow — main verification

Base: origin/main a4aef16. Transplanted d7d299b3 and 2e0630a; conflict resolution
retains only UC/FR-CONTEXT-CJK and omits feature-branch-only product requirements.
The previous context-budget-cjk-retry review is historical transplant evidence.
This document records this main-based run separately.

## Reproduce

```sh
pnpm exec vitest run src/test/budgeted-conversation.contract.test.ts src/test/uc1-openai-compat.contract.test.ts src/test/uc-naia-settings-store.contract.test.ts src/test/uc1-agent.contract.test.ts src/test/grpc-codec-uc1-fields.contract.test.ts
pnpm build
bash scripts/enforce-root-structure.sh
node --test src/test/ci-verify-*.test.mjs
node scripts/check-logging.mjs
node scripts/check-file-anchors.mjs
```

RED before settings/error wiring: 2 failed, 83 passed (85). Settings loader
silently lost contextWindow; round rejection lost the length error code.
RED before tightening 400 classification: 2 failed, 47 passed (49); unrelated
input_tokens/max_model_len errors were incorrectly retried and labeled overflow.
GREEN: the five related files pass 159/159. Tests run locally without external LLMs.
Additional existing regression tests pass 47/47 in seven files (role resolution,
role runtime, reload, tool loop/stdio, approvals, provider wiring). The committed
tests, including the synthetic server, reproduce these assertions.

The HTTP server computes input tokens independently as ceil(UTF-8 JSON bytes / 3).
Its 8192-token threshold yields 20 Korean turns / 20 responses / zero HTTP 400s.
An intentional untrimmed-history negative control then gets HTTP 400, proving
that the server enforces its limit. This does not measure a real model tokenizer.
The real error path runs two simulated HTTP-400 attempts through provider and handler,
checks a single length-error log and terminal code, and round-trips proto code 25.

Final pnpm build exits 0. Existing root-structure and logging checks pass, and ci-verify tests pass 4/4.
File-anchor checking reports 36 existing drifts; baseline a4aef16 produces byte-
identical output. No gate/rule/session-contract file is edited.

## Host contract

Settings: naia-settings/config.json.llmRoles.main.contextWindow=8192 (preferred),
config.json.contextWindow=8192 (legacy mirror), or legacy
llm.json.main.contextWindow=8192. Only positive safe integers are accepted.
ProviderConfig.contextWindow reaches the OpenAI-compat wire budget; absent values
retain 6000. The shell should persist this setting and reload the workspace.
ErrorEvent.code (existing field 2) gains CONTEXT_WINDOW_EXCEEDED=25; stdio error
also carries code. The shell should show a length-overflow message for this code.
Radio mode already has ChatRequest.disabledSkills (gRPC disabled_skills field 7)
to remove tool specs before the provider budget is computed. Mode UI/policy and
agent-pairing updates belong to shell. Built-in continuation remains available
unless enableTools=false; this work does not claim a full tool allowlist.

## Limitations

CJK budgeting is a 1.5-token/code-point heuristic, not tokenizer discovery.
ASCII remains a 4-chars/token estimate and the Korean result must not be
generalized to all text. Image token costs and implicit server output reservation
are unknown. A configured window smaller than an explicit provider output reserve
(e.g. deepseek-v4-flash 16384) can leave no history budget. Fixed system,
tools, explicit output reservation and the mandatory latest turn can alone exceed
the window; one bounded retry can then fail with the public length code.

## Independent review

Initial independent muse review read the complete diff against a4aef16 and reran
151 tests plus build. It found a HIGH fixed-6000 preassembly cap, a MEDIUM
structured-role contextWindow omission, and insufficient disabledSkills wire
coverage. The fixed cap and structured-role omission each reproduced RED
(2 failed / 105 passed) before fixes. ConversationPort now accepts a per-turn
maxTokens budget, handler passes providerConfig.contextWindow, and structured
main settings take precedence over top-level values. The full composition test
compares 6000 versus 32768 and checks final wire.tools excludes disabled entries.
The 20-turn test now runs through the actual handler/composition/resolver chain.
Length-error spelling variants and unrelated-400 regressions are covered.
The reviewer also noted tokenizer/image/fixed-output limitations, retained below.
Independent muse follow-up verdict: no blockers; all five reviewed issues
resolved and no new blocking bug. It independently reran all five related files:
159/159 passed (budget 10, proto 9, settings 57, handler 29, compat 54).
The review checked full git diff a4aef16, including staged review evidence.
Its remaining observations are the documented tokenizer/image/mandatory suffix,
error-body cap and missing whole-suite/native dependency limitations. The stale
historical 55-test requirements text was updated after this follow-up.

Reviewer invocation (both rounds, workspace agent-ctxmain):
`muse exec --trust-workspace --disable-sandbox --prompt-file <prompt>`.
Prompts: /tmp/ctxmain-review-prompt.md and /tmp/ctxmain-review-followup.md.
Raw output: /tmp/ctxmain-muse-review.log and /tmp/ctxmain-muse-followup.log.

Full-suite attempts on clean a4aef16 and this worktree encounter missing native
better-sqlite3 bindings, memory-suite load failures and process-test failures/hangs.
Both were deliberately stopped after several minutes; no whole-suite passing
count or exhaustive failure-set equivalence is claimed. One worktree run overlapped
the RED classifier tests and therefore contains those now-fixed failures. The
final focused results above are from a separate stable-source run.
Raw local evidence: /tmp/ctxmain-red.log, /tmp/ctxmain-red-classifier.log,
/tmp/ctxmain-red-review.log, /tmp/ctxmain-green-final.log,
/tmp/ctxmain-build-final.log, /tmp/ctxmain-full.log,
/tmp/ctxmain-baseline-clean.log, /tmp/ctxmain-muse-review.log,
/tmp/ctxmain-muse-followup.log. Dependencies reuse /tmp/agentctx-deps/node_modules
(external node_modules symlink, not committed). This does not restore a fully
self-contained whole-suite environment.
