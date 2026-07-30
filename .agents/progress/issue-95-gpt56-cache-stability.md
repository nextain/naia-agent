# Issue #95 — GPT-5.6 cache-stable Naia requests

## Scope

- REQ-AGENT-095
- Naia-account direct chat/Shell path only for Sol/Luna
- Stable non-secret client shard; authenticated gateway isolation
- No standalone Pi model-set expansion
- UC, provider contract, CLI/Shell regression and live gateway evidence

## Status

Implemented and verified. Paired AnyLLM issue #52 owns usage persistence,
pricing, credit settlement and the server-derived fallback cache key.

Planning review added explicit negative coverage that Pi remains limited to
Grok/DeepSeek and receives no GPT-5.6-specific request field. The direct Naia
chat adapter may add a model/system-prefix shard only for Sol/Luna; the gateway
HMAC remains the tenant-isolation authority.

## Verification

- Agent: 1,378 passed, 9 opt-in/live tests skipped; TypeScript build passed.
- Controlled real Pi integration and isolated stored-login CLI process passed.
- Pi model catalog remains exactly Grok 4.3 and DeepSeek V4 Pro.
- Shell: 105 model/settings UC+FE tests and 1,391 full tests passed; core and
  production builds passed.
- AnyLLM: 85 cache/pricing/provider/migration tests, lint and strict typecheck
  passed; live Sol/Luna write-then-read cache transition passed.
- Adversarial development/test/integration review converged CLEAN twice.
