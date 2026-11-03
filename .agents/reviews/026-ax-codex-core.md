# 0.2.6 AX Codex 초기 구현 — 독립 적대 리뷰

- 날짜: 2026-11-03 UTC
- 요청 근거: 사용자 0.2.6 AX 지시 및 agents-rules definition_of_done의 독립 리뷰 요구
- 범위: UC1/UC5/UC13 확장, UC-AX-026 / FR-AX-026, ARCHITECTURE.md §7
- 독립 리뷰어: 병렬 에이전트 `/root/review_research` (구현 파일 수정 없이 조사·재현·재검토)
- 최종 판정: **Linux 초기 구현 범위 잔여 blocker 없음**. 실제 Shell/캘린더/B2B 보안 인수 완료를 뜻하지 않는다.

## 반증과 수정

1. 승인 callback이 영원히 반환하지 않으면 abort 후 execute가 계속 보류됨을 never-resolve callback으로 재현했다.
   신호와 callback 결과를 race하는 awaitApproval을 추가했다. 취소 후 늦은 accept는 실행하지 않는 회귀시험을 추가했다.
2. Windows 기본 codex.cmd를 상대경로로 npm shim 해석하면 PATH를 찾지 못하는 결함을 지적했다.
   기존 resolveFallbackCommand('codex')를 재사용해 PATH의 실제 shim 경로를 먼저 해석한다.
3. 부모가 종료되어도 자손이 stdout을 상속하면 timeout이 마감되지 않음을 2초 자손에서 2132ms로 재현했다.
   POSIX 별도 process group 종료 및 강제 reader/pipe 마감, Windows 최초 중단부터 taskkill /T /F를 적용했다.
   무한 자손이 pipe를 잡는 프로세스 회귀시험으로 Linux에서 다시 검증했다.
4. 승인 중 인자 변경을 막는 복제·중첩 동결을 확인했다. Date 같은 비 JSON 가변 객체를 거절했다.
   텍스트 초기판은 tools/inlineImages/attachments를 묵살하지 않고 실행 전 거절한다.

## 직접 검증한 증거

독립 리뷰어는 신규 두 계약 파일을 직접 실행해 **34개 시험 통과**를 확인했다.
마지막 Windows 변경은 읽기 재검토했으며 Windows 실제 실행은 하지 않았다.
부모는 기존 Codex app-server·provider provenance·tool-loop 회귀를 포함해 **5개 파일 73개 시험 통과**를 재확인했다.
타입 검사 `pnpm build`와 `check-compile-integrity`, 표준 로깅 검사, 구조 CI 4개 시험도 재실행했다.

재현 명령(의존성 설치 후):

```bash
pnpm build
pnpm exec vitest run src/test/codex-exec-provider.contract.test.ts src/test/ax-approval-policy.contract.test.ts src/test/codex-app-server-provider.contract.test.ts src/test/uc-provider-provenance.contract.test.ts src/test/uc5-tool-loop.contract.test.ts
node scripts/check-compile-integrity.mjs
node scripts/check-logging.mjs
node --test src/test/ci-verify-*.test.mjs
```

해당 실행에서는 TMPDIR을 `/home/nextain/work/codex-runs/026-ax/tmp`로 지정했다.
숫자는 성능 지표가 아니라 이번 시험 실행 개수다. 프로세스 fixture는 가짜 CLI이며 유료/실모델 호출 0회다.
원시 로그는 실행 폴더 tmp/{final-target-test,build,compile-integrity,current-ci,logging}.log에 있다.
전체 pnpm test: 기준 a4aef16은 7개 파일/28 실패/2238 통과/12 skip/2 errors, 작업본은 7개/28 실패/2271 통과/12 skip/2 errors. 출력의 FAIL 헤더 전체가 동일했다(29줄, 매개변수 시험의 동명 헤더 포함). 이 전체 실행은 마지막 보완 전 snapshot(신규 33건 포함)이며 마지막 보완·추가 회귀 후 관련 73건과 타입 검사를 다시 통과했다. 전체 green으로 보고하지 않는다. 실행 폴더 tmp/comparison.json 및 result.md에 비교를 기록했다.

## 구조·계약 대조와 한계

신규 3개 production 파일은 작성 전 module-manifest에 UC1/UC5/UC13과 실재하는 정규 계약 문서를 등록했다.
파일 앵커 검출기의 임시 uncontracted.ts probe가 기대대로 RED를 반환했다. 기존 CI·PreToolUse/PostToolUse에
파일단위 검출이 배선돼 있어 검출 갭을 새로 열지 않았다. 기존 앵커 36건·canon scope 62건은 기준본과 동일하며
이 작업의 신규 파일은 포함되지 않는다. 거짓 앵커로 기존 파일을 덮거나 삭제하지 않았다.

문서는 exec 초기판의 텍스트 제한·미배선, Codex 추론의 외부 전송, 모든 native 도구의 사전 중재 미완성,
Windows 미검증, 승인 callback 외부의 실제 사람 증명·TTL·single-use 저장소 미구현을 명시한다.
실제 보안 문서·캘린더·음성 승인 E2E, 네트워크 우회 차단, B2B 보안 인수는 후속이며 P05는 In review다.
헌장 파일은 수정하지 않았다. process-status.json의 필수 갱신과 단독 수정 금지 지시가 충돌하므로 기존 상태를
임의로 덮지 않고 이번 P01~P05 상태를 requirements/user-scenarios/이 리뷰 및 실행 보고서에 기록했다.
