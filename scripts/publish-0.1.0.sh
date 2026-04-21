#!/usr/bin/env bash
# Publish @nextain/agent-* packages v0.1.0 to npm.
#
# Prerequisites:
#   1. `npm login` (interactive) with an account that has publish access
#      to the @nextain scope on npm.
#   2. Clean `pnpm build` — produces dist/ in all packages.
#   3. `pnpm smoke:anthropic` dry-run green.
#
# Publish order matches dependency topology:
#   types → protocol → (skill-spec in naia-adk) → core / observability / providers
#
# Abort on first failure. Re-run is safe — npm rejects republish of
# existing versions.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== Building all packages ==="
pnpm build

echo "=== Dry-run sanity check ==="
for pkg in types protocol core providers observability; do
  echo "--- $pkg ---"
  pnpm --filter "@nextain/agent-$pkg" exec npm publish --dry-run --tag latest 2>&1 | tail -3
done

echo ""
echo "=== Ready to publish. Type 'yes' to continue: ==="
read -r answer
if [[ "$answer" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

echo "=== Publishing @nextain/agent-types ==="
pnpm --filter @nextain/agent-types exec npm publish --access public

echo "=== Publishing @nextain/agent-protocol ==="
pnpm --filter @nextain/agent-protocol exec npm publish --access public

echo "=== Publishing @nextain/agent-core ==="
pnpm --filter @nextain/agent-core exec npm publish --access public

echo "=== Publishing @nextain/agent-observability ==="
pnpm --filter @nextain/agent-observability exec npm publish --access public

echo "=== Publishing @nextain/agent-providers ==="
pnpm --filter @nextain/agent-providers exec npm publish --access public

echo ""
echo "✓ All 5 packages published. Now run naia-adk publish separately:"
echo "  cd ../naia-adk && pnpm --filter @naia-adk/skill-spec exec npm publish --access public"
