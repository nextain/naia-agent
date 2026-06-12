#!/usr/bin/env bash
# setup-git-hooks — 커밋 무결성 게이트 활성화(clone 당 1회). Luke "항상 깨끗한 상태 유지". new-naia-agent.
# core.hooksPath 는 로컬설정(비커밋) → 새 clone/PC 는 1회 실행 필요. 세션시작 점검이 미설정을 RED 로 잡음.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
git config core.hooksPath scripts/git-hooks
echo "✅ core.hooksPath = $(git config core.hooksPath) (pre-commit 무결성 게이트 활성)"
