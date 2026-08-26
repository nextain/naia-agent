# issue-112 — 셸을 통해 터미널 환경을 관측하는 계약 (agent 측)

Date: 2026-08-26
Issue: nextain/naia-agent#112 · 짝: nextain/naia-shell#497, #502

## 왜 계약을 따로 맺는가

이 작업은 두 저장소에 걸친다. naia-shell 쪽 계약은 그 저장소의
`docs/progress/issue-497-universal-agent.md` 에 있다. 그러나 그것은 셸의 계약이고,
여기서 지켜야 할 것은 **뇌 쪽 경계**다. 같은 wire 를 두고 두 저장소가 각자 지킬 것이 다르므로
계약도 각자 맺는다. 한쪽 계약만 있으면 다른 쪽이 그것을 근거로 자기 규칙을 우회하게 된다.

## 루크 결정 (2026-08-26)

1. naia-agent 가 뇌이며 사실상 naia 의 백엔드다. naia-shell 은 클라이언트이자 환경 호스트다.
2. **정보의 취합과 결정은 naia-agent 에서 한다.**
3. 오케스트레이션 레이어는 naia-agent 다.
4. Herdr 는 UI 이므로 사이드카 이상이 될 수 없다.
5. naia-agent 는 셸을 통해 Herdr 를 외부 환경으로 부른다.

## 이 저장소가 지킬 것

### C1. 클라 주입 금지는 그대로다

`src/main/domain/chat.ts` 의 권한 모델은 바뀌지 않는다 — persona·profile·workspaceContext 는
클라가 주입하지 못하고, 클라가 줄 수 있는 것은 `environmentSegments` 뿐이며 그것도 kind 별
구조화 값이다. 이번 작업은 그 화이트리스트에 kind 하나를 **더하는** 것이지 예외를 만드는 것이 아니다.

### C2. 문구는 코어가 소유한다

`avatarEmotion` 과 `responseStyle` 이 그렇듯, 새 kind 도 클라는 구조화 값만 보내고
프롬프트에 들어갈 문장은 코어가 발행한다. 클라가 보낸 문자열이 지시문 자리에 놓이지 않는다.

### C3. 셸의 새니타이즈를 신뢰하지 않는다

셸이 이미 제어문자를 제거하고 길이를 자른다. 그래도 코어가 다시 한다. 셸은 여러 개일 수 있고
(데스크톱·CLI·향후 다른 기질), 그중 하나가 게을러도 뇌가 오염되면 안 된다.
기존 `panel` kind 가 이미 같은 태도를 취한다.

### C4. 상한은 기존 것과 같은 자리에 둔다

세그먼트 개수·엔트리 개수·렌더 총길이 상한이 이미 `environment-segments.ts` 에 상수로 있다.
새 kind 도 그 체계를 따르고 새 상한 체계를 만들지 않는다.

### C5. 이 kind 는 환경을 *보고*할 뿐 의도를 내려보내지 않는다

내려가는 길(관측·포커스·중단·실행)은 `environmentSegments` 가 아니라 도구 호출 경로다.
셸에 이미 `app-registry.ts` 의 `onToolCall` seam 이 있고 agent 의 `toolUse` 가 그리로 간다.
이 이슈의 범위는 **올라오는 길**까지다. 내려가는 길은 별도 REQ 로 연다.

## 짝 저장소가 이미 보장하는 것 (naia-shell 브랜치 `issue/497-universal-agent`)

- 표면 손잡이는 불투명하다. `pane_id` 같은 환경 식별자가 뇌에 오지 않는다.
- 레이블은 제어문자 제거 후 80자로 잘린다.
- 활동 상태는 `idle|working|waiting|unknown` 네 가지로 정규화되고, 모르면 `unknown` 이다.
- 표면은 20개까지 싣고 초과분은 개수만 보고한다.
- 사용자가 보고 있는 표면이 먼저 온다.

이것들은 셸의 계약이다. 이 저장소는 그것을 **가정하지 않고** 자기 쪽에서 다시 강제한다(C3).

## 범위 밖

- 오케스트레이션은 이미 이 저장소에 있다(`issue-orchestration.ts`, `issue-team.ts`,
  `multi-issue-session.ts`, `durable-supervisor.ts`). 새로 만들지 않는다.
- L1 작업자를 Herdr pane 에서 돌릴지 지금처럼 subprocess·worktree 로 돌릴지는 별개 결정이다.
- 내려가는 의도 도구(C5).

## 게이트 메모

`.agents/context/process-status.json` 은 이 저장소에서 **헌장 파일**이라 사람 승인 없이 고칠 수
없다. 따라서 P05 의 상태 갱신은 루크 승인 뒤에 한다. P01~P04 는 이 문서와 V모델 registry,
`docs/user-scenarios.md`, `docs/requirements.md`, 그리고 테스트로 닫는다.

## 2026-08-26 추가 — wire 게이트 갭과 표본

두 저장소는 2026-06-08 에 갈라졌다. 그 전에는 뇌가 `old-naia-os/agent/` 하위 디렉터리였고,
헥사고날 재작성 때 자기 저장소로 나왔다. 분리의 근거는 이 저장소의
`docs/progress/99.dev-comm/agent-vertical-anchor-2026-06-10.md` 에 있다 — os 와 agent 는 같은 UC 의
두 반쪽이고, 둘을 잇는 H-agent 경계를 **양방향 probe 로 게이트**해서 각자 자유롭게 재설계해도
경계는 불변이게 한다는 것이다.

그런데 그 probe(`naia-shell/scripts/builds/uc1-outbound-probe.mjs`, `uc1-variant-probe.mjs`)는
**옛 baseline(old-naia-os) 대조용**이라 오늘 실행하면 SKIP 된다(2026-08-26 확인). 분리를 정당화한
게이트가 이식 시점에 멈춰 있었고, 지금의 셸↔뇌 형태를 막아 주는 것이 없다.

### C6. 표본으로 자기 쪽을 검증한다

두 저장소가 같은 표본 `src/test/fixtures/environment-surfaces-wire.json` 을 든다.
셸은 그 표본을 실제로 산출하는지 검증하고, 이 저장소는 그 표본을 **유실 없이 받아 렌더하는지**
검증한다. 그리고 상대 저장소가 옆에 있으면 표본이 같은지 대조하며, 찾지 못하면 건너뛰지 않고
실패한다 — 건너뛴 게이트는 게이트가 아니다.

이것은 uc1 probe 를 대체하지 않는다. 여기서 닫은 것은 이번 슬라이스가 쓰는 한 kind 의 형태뿐이고,
전체 union 동기는 여전히 멈춰 있다. 후속 과제다.
