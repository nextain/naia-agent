# SB-1 loader — codex/gemini different-profile cross-review (#32)

Gate (agents-rules + hand-off): slice 머지 전 codex+gemini 2 consecutive
clean, different-profile. Tooling: `codex exec` (Reviewer A — security /
contract-boundary / design-conformance) + `gemini --approval-mode plan -p`
(Reviewer B — implementation correctness / test validity / robustness),
read-only, UNCOMMITTED working tree.

## Round ledger

| R | codex (A) | gemini (B) | action |
|---|-----------|------------|--------|
| 1 | ISSUES — MAJOR baseURL prefix-match bypass (`/^10\./` matched `10.0.0.5.evil.com` → key-exfil reopened); MINOR test gap | ISSUES — MAJOR `memory.close()` 미호출(alpha-memory SQLite/WAL 누수); MAJOR cross-repo rel-import; MINOR `executeAgent` 예외안전 | fix all |
| 2 | ISSUES — MINOR (hostile-host regression tests 미흡) | CLEAN | add tests |
| 3 | ISSUES — NEW MINOR (`user:pass@` userinfo가 stderr `baseURL=`로 평문 노출) | CLEAN | reject userinfo at gate |
| 4 | ISSUES — NEW MEDIUM (`runService` 파일읽기 실패가 손수 만든 ErrorEvent, canonical `timestamp` 누락 → shape drift) | (race/cleanup 재실행) | shared `manifestInvalid()` export |
| 5 | **CLEAN** | **CLEAN** | consecutive-clean #1 |
| 6 | **CLEAN** (무변경 확인) | **CLEAN** (무변경 확인) | consecutive-clean #2 → **gate PASS** |

## Resolutions (all RESOLVED, both reviewers agree)

- **baseURL prefix bypass (codex r1 MAJOR)** → `manifestBaseURLTrust()`
  재작성: `node:net` `isIP()` + 숫자 IPv4 사설/loopback 레인지 + IPv6
  `::1`/ULA/link-local; 비-IP는 정확히 `localhost`만; allowlist 정확 일치;
  http/https only.
- **userinfo 노출 (codex r3 MINOR)** → baseURL `username`/`password` 있으면
  게이트에서 거부 (schema §4: manifest 무비밀; 로그 누출 차단).
- **ErrorEvent drift (codex r4 MEDIUM)** → `manifestInvalid()` export,
  parser·host 단일 canonical Part-A.11 shape (shared-shape test).
- **memory.close (gemini r1 MAJOR)** → `runService`/`runDirect`
  `try/finally`로 `MemoryProvider.close()` 보장.
- **executeAgent 예외안전 (gemini r1 MINOR)** → 단일 `try/finally` →
  모든 경로 `agent.close()`.
- **cross-repo rel-import (gemini r1 MAJOR)** → 의도적 결정으로 문서화:
  런타임 해석 실증(실제 bin alpha-memory binding 동작),
  `examples/hardened-sqlite-host.ts` 동일 패턴, 패키지 specifier는 Phase-2
  standalone-publish 시 (README Status). 양쪽 RESOLVED 동의.
- 회귀: `service-manifest.test.ts` 18→68 tests (적대적 hostname / canon /
  exact-allowlist / userinfo / canonical ErrorEvent shared-shape).

## Final

Round-5 & Round-6 (byte-identical code): codex CLEAN + gemini CLEAN →
**2 consecutive clean, different-profile = cross-review gate SATISFIED.**
runtime 262 pass · tsc 0 (slice) · S01 보안 스모크 통과.
