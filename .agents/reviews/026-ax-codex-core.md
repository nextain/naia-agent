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

## 2회차 독립 적대 리뷰 (2026-11-03 UTC)

- 리뷰어: `/root/ax_review_r2`; 구현 파일은 수정하지 않고 diff·정책·합성·프로토콜을 대조했다.
- 직접 재실행: `TMPDIR=/home/nextain/work/codex-runs/026-ax/tmp PATH=/home/nextain/work/codex-runs/026-ax/tmp/bin:$PATH pnpm exec vitest run src/test/codex-app-server-provider.contract.test.ts src/test/ax-approval-policy.contract.test.ts src/test/uc-provider-provenance.contract.test.ts src/test/uc5-tool-loop.contract.test.ts` — 4개 파일 63개 통과. 원시 출력: 실행 폴더 `tmp/r2-independent-review-tests.log`.
- 의미 있는 반증: 미등록 shell/MCP/HTTP 호출 거절, 등록 후 실행 함수·spec 변조 방지, 최강 효과 선택, broker 합성 후 원시 shell/자동 메모 도구 제거, 버전 불일치·미로그인·broker 부재 시 fail closed를 확인했다. 이 테스트들은 실제 외부 서비스 호출 없이 실행 경계의 부수효과 미발생을 관찰한다.
- 수정 요청 1: AX 환경에서 resolver 재생성 시 `workspace` callback이 사라져 기존 codex 경로가 workspace bind를 잃는다. AX 활성 상태의 기존 공급자 보존 요구와 충돌하므로 callback 보존 필요.
- 수정 요청 2: peer 종료만으로 이미 기다리는 비협조적 `executeTool` Promise를 취소하지 못한다. signal 취소와 timeout이 실행 대기에도 적용되어야 하며, underlying effect 자체가 취소를 무시하면 되돌릴 수 없다는 포트 한계도 명시해야 한다.
- 검증 주의: read-only sandbox와 native 실행 이벤트 거절은 도구 노출 제거 자체의 증거가 아니다. 실행 폴더에 수집된 `r2-spec-plan.rs`의 ApplyPatchHandler 등록 조건은 ShellTool feature와 독립적이다. pin과 동일한 소스 또는 실제 도구 목록으로 patch/권한 도구의 비노출을 확인해야 한다. `apply_patch_freeform=false`만으로는 제거가 입증되지 않는다.
- 판정: 위 항목을 부모에게 전달했다. native 도구 비노출과 취소 보완이 확인되기 전 전체 보안 인수 완료 판정은 유보한다. 실제 민감 문서·캘린더·운영 연결 시험은 수행하지 않았다.

### 2회차 보완 재검토

이전 수정 요청 3건을 구현과 대조했다. resolver는 workspace callback을 보존하고,
AX 내부 AbortController의 deadline·사용자 취소가 broker와 비협조적 callback 대기에 전달된다.
취소 후 외부 구현이 신호를 무시한 부수효과를 되돌리는 기능은 아니다.
`axModelCatalog`는 pin CLI의 번들 목록에서 **선택한 모델만** 남기고 direct mode,
disabled shell, null apply_patch, 빈 experimental tools로 제한한다. 모르는 모델은 대체하지 않고 거절한다.
별도 권한·sleep·deferred executor 기능도 껐다. 유효 config의 각 feature를 검사한 후
병합된 MCP 서버 이름별 enabled=false를 thread/start에 주입하며, 반환 모델과 read-only sandbox도 검사한다.
이는 이전의 이벤트 사후 거절만 있던 patch 노출 갭을 닫는다.
부모가 수행한 실제 ChatGPT 비민감 smoke의 원시 출력 `tmp/r2-live-broker.log`에서
read=1, approval=1, send=0 및 tool result/finish를 읽어 확인했다. 독립 리뷰어가 실모델 호출을 중복 수행하지는 않았다.

재실행 `tmp/r2-independent-review-final.log`: 65개 중 64개 통과, 1개는 작성 중인 composition
시험 provider가 finish만 보내 reasoning-without-answer 재시도(2회)를 유발한 fixture 실패다.
부모에 전달했으며 해당 시험은 수정 후 다시 확인해야 한다. 새 catalog 제한·비협조적 callback 취소 시험은 통과했다.

최종 fixture 보완 후 같은 4개 파일을 독립 재실행하여 **65개 모두 통과**했다.
원시 출력은 실행 폴더 `tmp/r2-independent-review-final-green.log`다.
이 범위에서 이전 3개 구현 지적에 대한 잔여 blocker는 없으며, 실제 외부 승인 호스트 연결·민감 문서
인수·Windows 동작까지 검증했다는 의미는 아니다.

### 최종 실행 경로 확인

마지막 production 합성 변경도 독립 검토했다. 진단 sink 초기화는 broker 생성보다 앞서며,
AX에서는 NAIA_MCP_CMD 프로세스를 시작하지 않고 raw memory executor도 덧붙이지 않는다.
실제 production compose를 불러 MCP marker 미생성과 등록 5개 도구·동일 broker 반환을 확인하는
새 시험을 포함해 관련 4개 파일 **66개 시험을 독립 재실행하여 모두 통과**했다.
출력: `tmp/r2-independent-review-boot-final.log`.
MCP disable override는 기존 transport를 보존하고 JSON null만 제거하므로 TOML 변환 오류를 피하면서
서버별 enabled=false를 유지한다. 실제 native smoke의 `tmp/r2-live-native.log`에서도
HTTP 요청 0, shell marker=false, MCP marker=false, completed=true를 확인했다.
실제 CLI 출력 `tmp/r2-cli-live.log`의 명시적 codex-ax 선택과 `NAIA_AX_CLI_OK`,
`tmp/r2-cli-catalog.log`의 공급자 목록도 읽어 대조했다.

**최종 판정: 이번 2회차 Linux 실행·신뢰 효과 중개기 범위 승인, 잔여 blocker 없음.**
승인 호스트의 음성 인증·코드 TTL/single-use, 실제 문서/일정 커넥터, Windows 보장 및 기업 보안 인수는
이 판정에 포함되지 않는다. 독립 리뷰어는 운영 연결·추가 실모델 호출·커밋을 수행하지 않았다.

### 부모 최종 회귀 대조 (2회차)

- 재현: `pnpm build`; `pnpm exec vitest run src/test/ax-approval-policy.contract.test.ts src/test/codex-app-server-provider.contract.test.ts src/test/codex-exec-provider.contract.test.ts src/test/uc-provider-provenance.contract.test.ts src/test/uc5-tool-loop.contract.test.ts src/test/discord-entry-wiring.contract.test.ts src/test/cli-manage.contract.test.ts src/test/cli-manage-process.integration.test.ts` → 132 pass / 1 skip.
- 8d92e26 detached worktree·작업 snapshot 전체 `pnpm test`: 기존 7개 파일 28 실패·12 skip·2 errors, 통과 2272→2281. 실패 제목과 중복 건수 29줄 완전 일치. snapshot 뒤 조립기 기동 보완은 위 집중 시험 및 독립 66건으로 검증.
- 증거: 실행 폴더 `tmp/r2-pristine-baseline-test.log`, `r2-final-stable-test.log`, `r2-comparison.json`, `r2-target-final.log`. 초기 진행 중 snapshot 및 중단한 중복 실행 로그는 최종 비교 근거로 사용하지 않음.
- 구조 CI 4건·루트 구조·build·compile-integrity·logging 통과. 파일 앵커 36/canon 62 기존 드리프트 유지. 새 미계약 파일 probe 차단 확인.
- P05 제품 전체는 In review. 헌장 process-status.json은 단독 변경하지 않음.


## 3회차 독립 적대 리뷰 (2026-11-03 UTC)

- 리뷰어: `/root/approval_review`; production 코드와 헌장은 수정하지 않고 diff와 승인 경계를 검토했다.
- 발견·재현: A/B 제안 중 B를 취소하면 A만 남아 과거의 모호한 “응”이 통과했다. 최초 빌드 산출물의 저장소를 직접 호출하여 `acceptedAfterOverlap: true`, 결과 `[true, false]`를 재현했다. 보완 후 두 번째 제안 등록 자체가 기존 제안을 폐기하고 새 제안도 거절하므로 이 경로가 닫혔다.
- 승인 응답 직후 실제 실행 Promise가 재개되기 전에 scope·TTL·취소가 바뀌는 경계도 지적했다. 보완된 broker는 실행 직전 `validateApproval`을 동기 호출하며, 저장소는 WeakMap의 request 객체 결속 grant를 한 번 소비하고 scope/revision/TTL/dispose/AbortSignal을 재검사한다. 호스트는 두 approval callback과 이 validator를 함께 주입해야 한다.
- 검토 계획 digest가 카드에 없던 계약 갭을 전달했고 보완 카드의 `reviewedPlanDigest`를 확인했다. digest의 실제 계획 검토·본문 대응 증명은 trusted host 책임이다.
- 최초 독립 시험 55건 중 4건은 설치된 Vitest가 지원하지 않는 matcher 때문에 실패했다. matcher 보완 뒤 `TMPDIR=/home/nextain/work/codex-runs/026-ax/tmp node_modules/.bin/vitest run src/test/ax-approval-policy.contract.test.ts`를 다시 실행하여 **59건 모두 통과**했다. 승인과 실행 사이 scope/invalidate/dispose/expire 변경 회귀도 포함한다.
- 판정: 검토한 저장소·broker 경계에 위 수정 요청의 잔여 blocker 없음. Shell의 실제 사람 입력 인증, trusted 카드 렌더링, 변경 시 invalidate, validator 합성 및 실제 캘린더/발송 E2E는 이번 독립 시험의 검증 범위 밖이다. 운영 접근·외부 발송·실모델 호출은 수행하지 않았다.


### 3회차 최종 합성 재검토

`makeAxHumanEffectBroker`가 저장소의 conversation/code callback과 실행 직전 validator를 같은 broker에 함께 주입하는 것을 확인했다. 최종 문서는 실제 wire 미구현·화자 인증과 과거 STT 버퍼 금지·trusted host 책임을 명시한다. 코드/대화 양쪽 취소·만료·재시작·변경 회귀 및 세 가지 효과의 factory 합성 시험을 포함하여 AX 계약 시험 **70건 모두 독립 재실행 통과**했다. 원시 로그: 실행 폴더 `tmp/r3-independent-final.log`. 이 최종 저장소/factory diff에서 잔여 blocker 없음. 실제 셸/외부 connector 인수는 기존 범위 제한을 유지한다.
