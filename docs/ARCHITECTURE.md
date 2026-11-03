# naia-agent 아키텍처 — brain 반쪽 (온보딩)

> agent 는 os→agent→adk 의 **뇌/처리**다. 전체 사상(직교 2축·인지 계층·UC 추가 레시피)의 SoT 는
> [naia-os](https://github.com/nextain/naia-os) 측 `docs/ARCHITECTURE.md`. 이 문서는 agent(brain) 측 구체만 다룬다.

## 1. 위치

```
naia-os(UI) ──gRPC──> [ naia-agent ] ──저장/불러오기──> naia-adk(settings SoT)
```
- 셸이 spawn → agent 가 stdout 에 `GRPC_LISTENING <addr>` 출력 → 셸 tonic 클라가 connect.
- agent 는 `SetWorkspace(adkPath)` 로 naia-adk settings 로딩 → provider/model 구성. 키는 OS 키체인(평문 금지).
- 대화 = `Chat(server-stream)`. 셸은 메시지만, agent 가 recall→provider→save→스트림.

## 2. 인지 계층

- **입력층** `ports/uc1.ts AgentIngressPort` — transport-neutral 수신(gRPC 서버가 여기로).
- **처리** `app/chat-turn-handler.ts` — recall(memory.recall)→systemPrompt 주입→provider 라운드(도구 루프)→save(memory.save)→finish.
- **출력층** `AgentEgressPort` — AgentEvent(text/thinking/toolUse/usage/finish/…) emit.
- transport 어댑터: `adapters/grpc/`(production) + `adapters/stdio.ts`(테스트 in-process). 둘 다 같은 Ingress/Egress 포트 구현 = 직교.

### 떠오름(#692, #693)
작은 LLM(memory 역할) 또는 유사도 임계치 기반으로 연관성이 높은 기억을 다음 턴의 프롬프트로 선별·준비하고, 능동적 기억 회상 도구(`skill_memory_recall`)를 제공한다.
- 3가지 동작 모드: `on-llm`(작은 LLM 비동기 선별 + 미판단 임계치 게이트), `on-threshold`(작은 LLM 없이 코사인 유사도 임계치 0.86 게이트 + 단순발화 필터), `off`(자동 기억 주입 완전 생략).
- `domain/surfacing.ts`: 순수 도메인 로직(후보군 추출·프롬프트 조립·응답 파싱·블록 렌더링·판정 후보 필터링·자격 판정 `decideSurfacing`, 임계치 계산 및 trivial 검사 `isTrivialMemoryText`, 임계치 필터 `thresholdJudge`/`selectRecallByThreshold`).
- `ports/surfacing.ts`: `SurfacingPort`(consume/schedule/mode/policy/active/close) 및 스냅샷·임계치 정책 계약 정의.
- `app/memory-surfacer.ts`: 비동기 스케줄러, 타임아웃(8s)·TTL(15m) 관리, 모델 부재 시 백오프(10m), 후보 취합 및 작은 LLM 호출 오케스트레이션 (`on-llm` 모드에서만 동작, `touch: false` 회상).
- `adapters/memory-skill.ts`: 능동적 장기기억 회상 도구 `skill_memory_recall` 구현 (읽기 전용, `touch: false`, 비밀 마스킹, JSON 출력 규격).
- 합성 배선(`scripts/builds/compose-agent-deps.mjs`, `composition/index.ts` `wireAgentUC1`): memory 및 knowledge backend와 연동하여 surfacer 인스턴스를 주입하고 `skill_memory_recall` 실행기를 배선한다. `chat-turn-handler.ts`는 턴 시작 시 모드별 기억을 주입(임계치 적용 시 수치 통계 기록)하고, Discord/processing 요청 시 메모리 도구 및 정책을 안전하게 제외하며 unadvertised 도구 호출을 가드한다.

## 3. 헥사고날 레이어

| 레이어 | 예 |
|---|---|
| `domain/` | chat.ts(계약 union, os 와 1:1), memory.ts, cost.ts, provider-route.ts, surfacing.ts |
| `app/` | chat-turn-handler.ts, memory-surfacer.ts |
| `ports/` | uc1.ts, memory.ts, surfacing.ts |
| `adapters/` | grpc/, naia-memory.ts, naia-settings-store.ts, keychain-secret-store.ts, *-provider.ts, *-skills.ts, workspace-project.ts |
| `composition/` | index.ts |

## 4. wire 계약 (H-agent)

- 수신 union = os `AgentOutbound`(chat_request|cancel_stream|approval_response|creds_update)와 1:1.
- 송신 union = os chat-turn `AgentMessage`. proto SoT = `src/main/adapters/grpc/naia_agent.proto`.
- ⚠️ os/agent `domain/chat.ts` 가 손-중복(1:1 주석 단언). 동기 강제 = wire probe(os 측, CI). proto cross-repo 해시 일치는 follow-up(공유 패키지 결정 후).

## 5. 흔들림 방지 (CI 게이트)
`check-compile-integrity`(tsc) · `check-logging`(DiagnosticLog 강제) · `check-file-anchors`(`module-manifest.json` — `src/main` 의 모든 `.ts` 가 {layer,uc,contract} 앵커와 1:1 등록) · vitest(`src/test/uc*.contract/integration.test.ts`) — 전부 `.github/workflows/self-trust-gates.yml` `code-gates` job 에서 자동실행. PreToolUse 훅(file-anchor-guard)은 인터랙티브 세션 1차 방어.

## 6. 새 UC = os/docs/ARCHITECTURE.md §6 레시피 따름
agent 반쪽: 포트(`ports/`) → 도메인(`domain/`) → 어댑터(`adapters/`) → 와이어(`composition/`) → file-anchor 등록(`module-manifest.json`) → 계약 테스트(`src/test/`). wire 변경 시 proto + union 동시.

## 7. 0.2.6 AX — Codex 핵심 반복과 하네스 승인 설계 (2026-11-03)

상태: 2회차에서 명시적 `codex-ax` app-server 반복과 trusted broker 배선을 추가했다(§7.8).
§7.1~7.7의 초기판 설명은 1회차 이력이며 현재 결정/검증은 §7.8을 우선한다. P01/P02 = `user-scenarios.md` UC-AX-026,
P03 = `requirements.md` FR-AX-026. 실제 셸·캘린더·보안 인수 전이며 기본 공급자 교체는 하지 않았다.
대표님 11/3 지시: 1인 문서·일정 승인, 일상 승인은 대화 “응/보내”, 어려운 운영 변경만 계획·코드 승인.
출시 목표 11/13, 기능 고정 11/9. 웹·로컬 동기화는 0.2.7로 미룬다.
이 문서는 이미 등록된 정규 설계 문서에 추가했다. 헌장 변경이나 새 정규 문서 등록은 하지 않았다.

### 7.1 현황과 승인 표시 지점

`ChatTurnHandler`가 recall → assemble → provider → 최대 도구 라운드 → save를 소유한다.
`ProviderPort.chat()`는 텍스트·thinking·toolUse·usage·finish를 내고 `ToolExecutorPort`가 실제 효과를 실행한다.
`composition/index.ts` 및 `scripts/builds/compose-agent-deps.mjs`가 공급자·도구·메모리·승인을 배선한다.
main은 이미 `codex` → `codex-app-server-provider.ts`, 별도 `subagent-codex.ts` → `codex exec --json`을 가진다.
`GatedToolExecutor`와 `ToolApprovalClass` 이름의 현행 구현은 없으며 #36의 예전 packages 구조 제안이다.

| 사용자에게 승인 또는 차단이 나타나는 지점 | 현재 조건 / 실제 코드 |
|---|---|
| 로컬 디렉터리 목록·파일 읽기 | `adapters/fs-tools.ts`: `fs-read`; read 자체도 `chat-turn-handler.ts`의 tier 게이트 대기 |
| 로컬 파일 쓰기 | 같은 파일 `fs-write`; opt-in 쓰기 도구에 추가 승인 |
| 터미널 실행 | `adapters/shell-tool.ts`: `shell`; opt-in + tier 승인 |
| 메모 저장 | `adapters/builtin-skills.ts`: `memo_save`의 `ask` |
| 알림 외부 발송 | `adapters/notify-skills.ts`: `ask` |
| 브라우저 조작·BGM | `agent-browser-skills.ts`, `youtube-bgm-skills.ts`: `ask`; 일반 어댑터는 진입점 dormant 여부 구별 |
| MCP 도구 | `mcp-skills.ts`: 기본 `ask`, trusted defaultTier로 변경 가능 |
| ADK 스킬 | `adk-skill-loader.ts`: frontmatter tier, 미지정 `ask` |
| 셸 앱 도구 | `grpc-server.ts` RegisterTools: 양수 tier를 `ask`로 변환; 앱 등록 값에 따라 승인 |
| 메모리 외부 모델 처리 | `chat-turn-handler.ts` authorizeOperation: memoryTransmission이고 요청에 processing 계약이 없으면 `memory_model_<digest>` 승인 |
| 명시적 processing 계약 | 같은 처리기 + `processing-guard`: 전송 계획 authorize/공개·consent 검증; 누락/목적지 위반은 차단 또는 에러. 매번 UI 질문과 동일하지 않음 |
| 게이트웨이 이중 승인 | `gatewayApprovalRequest` wire variant와 셸 처리 경로 존재. 일반 로컬 tier와 별도; 실제 응답/기능 사용 시에만 발생 |
| Codex native 도구 | app-server는 `approvalPolicy=never`, 승인 필요한 동적 도구는 광고에서 제외. gated 도구가 자동승인되는 구조가 아니라 Codex에서 사용 불가능한 상태 |

정확한 tier 게이트는 `app/chat-turn-handler.ts`의 tierOf → prepareDecision → approvalRequest emit →
승인/거절 대기 → execute이다. 승인 키는 requestId+toolCallId이며 `adapters/approval.ts`가 등록 선행,
취소·dispose·중복 settlement를 관리한다. tier가 없거나 none인 등록 도구는 자동 실행이다.

셸 호출: `/home/nextain/work/026-shell/packages/shell/src-tauri/src/lib.rs`의 spawn_agent_core가 Node 자식을
실행하며 frontend chat-service → invoke(send_to_agent_command) → Rust stdio/gRPC bridge로 요청한다.
agent stdout의 GRPC_LISTENING 후 gRPC Chat·SetWorkspace를 사용한다. 승인은
approval_request/gateway_approval_request → approval_response(requestId,toolCallId,approve|reject).
셸 `src/main/app/control/approval.ts`의 별도 F1 gate는 T0/영구 grant 자동, T1/T2 질문, T3 차단,
scope/context drift 검사 및 특정 preview bypass를 가진다. 이 추상 gate를 모든 실채팅의 단일 정책이라고
간주하지 않는다. 음성 directToolCall의 implicit consent 경로도 있어 새 승인 경계를 우회하는지 반드시 인수한다.

관련 이슈 (11/3 GitHub 읽기 확인, 모두 OPEN):

| 이슈 | 설계 반영 |
|---|---|
| [#36](https://github.com/nextain/naia-agent/issues/36) ToolApprovalClass 분류 | scoped read/search·exec_capable·control_plane·mutating 제안. 현 tier에서 trusted effect 계약으로 점진 이행; 클래스만 보고 모든 exec를 허용하지 않음 |
| [#62](https://github.com/nextain/naia-agent/issues/62) thin external auth/runtime | Codex 로그인은 CLI 소유, auth.json 복사 금지, endpoint/env 검증·비밀 마스킹, 공급자 경계 유지 |
| [#21](https://github.com/nextain/naia-agent/issues/21) 직접 Agent와 supervisor | supervisor 강제 기본화 전례를 피하고 명시적 공급자 선택. 기존 직접 모델과 CLI 공존 |
| [#78](https://github.com/nextain/naia-agent/issues/78) working context | 무차별 프롬프트 컨테이너를 피하고 수명·역할·진입 비용별 선택. 장기기억과 작업 컨텍스트를 분리 |

### 7.2 목표 구조와 단계적 교체

```text
Shell Chat / CLI
  → 기존 recall·선택 context·처리 위치/전송 공개
  → ProviderResolver
      codex        → 기존 app-server (현재 도구 가능)
      codex-exec   → 새 exec 텍스트 초기판 (명시적 선택)
      기타 모델     → 기존 ProviderPort/Naia 도구 루프
  → [후속] Codex가 계획·다중 도구 반복을 소유하는 native runner
      → Naia 도구 bridge → trusted effect 정책 → 사람 승인 입력 → 실제 효과
  → 기존 스트림·장기기억·정직 보고
```

Codex가 내부 반복을 소유하는 최종 경로에서는 Naia가 같은 도구 호출을 재실행하지 않는다.
app-server의 handled toolUse/toolResult와 동일한 규약을 유지하고, Naia는 기억·전송 경계·권한·감사·취소를 소유한다.
SDK/exec만으로 native 도구 호출 **이전**의 모든 승인을 가로챌 수 있다고 가정하지 않는다.
제어 가능한 app-server 동적 도구 또는 분리된 실행 broker를 우선하며 OS sandbox·네트워크 프록시로
원시 shell/curl/직접 MCP 우회를 막아야 새 정책을 실제로 강제할 수 있다. 이름 기반 정규식만으로
임의 shell을 안전하다고 분류하지 않는다. 민감 변경 경로를 포괄하지 못하면 확장 권한을 켜지 않는다.

초기 구현:

- `adapters/codex-exec-provider.ts`: exec --json stdout을 ProviderChunk로 변환. stdin 프롬프트,
  빈 임시 cwd, ephemeral, read-only, 사용자 설정/rules 미로딩, shell/apply-patch/web/MCP 비활성 설정,
  제한된 env와 명시적 CODEX_API_KEY, timeout·SIGTERM→SIGKILL·출력 상한·임시폴더 정리.
  도구·이미지·첨부 입력은 명시적 미지원 에러. 네이티브 도구 이벤트 발견도 에러다. 발생 후 검출이 사전 차단을
  증명하지 않으므로 CLI 버전별 도구 비활성 및 네트워크 경계 검증 전에는 보안 업무용 자동실행으로 소개하지 않는다.
- `domain/ax-approval-policy.ts`: 순수 trusted effects → allow/conversation/code/deny.
- `adapters/ax-policy-tool-executor.ts`: opt-in 실행 직전 래퍼. 등록 도구인지 확인, call 복제·동결,
  각 승인 방식의 별도 host callback을 기다린 다음 실행. 내부 정책이 승인 소유자라 광고 tier는 none으로
  정규화한다. **이 래퍼 밖으로 원시 executor를 노출하면 보안 경계가 깨진다.** 기본 composition에는 미배선.
- `provider-resolver.ts`/`provider-route.ts`: codex-exec 명시적 경로, 외부 클라우드 처리 위치(opaque-cli)로 분류.
  셸의 UI 모델 카탈로그·진단 preflight·기본값 변경은 후속이다.

실행 예(개발자, 텍스트만): `makeProviderResolver().resolve({provider:'codex-exec',model:'<사용 가능 모델>'})`
뒤 `.chat(config,[{role:'user',content:'초안 요청'}],{})`. 이 초기판은 transcript의 role을 JSON 데이터로
보존하지만 exec의 실제 system/user 채널 분리는 아니다. 도구를 자동 주입하는 일반 ChatTurnHandler 경로는
아직 이 텍스트 초기판을 인수하지 않았다. 셸 설정만 바꾸면 전체 AX가 완성되는 상태가 아니다.

선택지 비교:

| 방식 | 적합성·제약 | 결정 |
|---|---|---|
| codex exec --json | 프로세스 경계가 작고 CLI 계약 재사용; 임의 native tool 승인 중계에 한계 | 이번 텍스트 어댑터, 실패/취소 검증 |
| @openai/codex-sdk | start/resume 및 스트리밍 API로 타입·세션 코드 단순화 가능; 권한 경계는 별도 필요 | 11/4 CLI 버전 pin 및 exec 대비 스모크 후 선택; 이번 의존성 추가 없음 |
| 기존 app-server | 인증·history·approval·stream 클라이언트용, 이미 Naia 동적 도구 bridge 보유 | 전체 Codex 반복 전환의 우선 확장 후보 |

인증은 ChatGPT 계정 `codex login` 또는 API 키. 토큰을 셸/레포로 복사하지 않으며 키는 기존 credential port →
자식 프로세스 전용 env로만 전달한다. 로그인 여부는 `codex login status`로 확인한다. 계정별 모델·한도·
회사 데이터 계약을 확인하며 ChatGPT 구독이라고 무제한/무료/기업 보안 계약이 성립한다고 표시하지 않는다.
exec/SDK가 실패해도 다른 클라우드 모델로 문서를 자동 재전송하지 않는다. 공급자 변경 시 전송 승인을 다시 판단한다.

공식 자료(2026-11-03 조회): [Codex non-interactive](https://developers.openai.com/codex/noninteractive),
[Codex SDK](https://developers.openai.com/codex/sdk), [인증](https://developers.openai.com/codex/auth),
[보안](https://developers.openai.com/codex/security). 로컬 `codex exec --help`도 사용 옵션을 확인했다.

### 7.3 승인 정책과 말로 승인하는 신뢰 경계

참고한 읽기 전용 하네스: alpha-adk/.claude/hooks의 email-send-guard(보내 발화), destructive-git-guard,
git-push-guard, deploy-guard. 기본 통과 + 특정 위험만 block하는 구조를 계승한다.
운영 변경은 readiness·검수된 계획·사람 입력 코드를 결속하며 AI가 쓴 승인 파일 자체는 사람 증명이 아니다.

| 효과 | 처리 | 사용자 경험 |
|---|---|---|
| scoped local_read / local_draft / reversible_edit | allow | 요청 범위 안에서 읽기·정리·초안·복구 가능한 편집 계속 |
| external_processing | conversation / 사전 기업 정책 grant | 선택 발췌·공급자·목적지 공개 후 승인. 유효한 범위 grant 동안 반복 질문 없음 |
| calendar_write / external_send | conversation | 정확한 일정/수신자/공유 범위/본문/첨부를 제시하고 “응/등록해/보내” |
| permanent_delete / payment / production_change | code | 계획·차이·대상·백업/롤백·검증 결과 + 별도 사람 입력 일회용 코드 |
| 미등록 도구·미상/빈 효과 | deny | 실행하지 않고 지원/분류가 필요하다고 설명 |

효과는 executor 등록 및 trusted argument 분석이 정한다. LLM의 “이건 안전”·문서 속 지시·사용자 데이터의
approved=true는 권한이 아니다. 복구 가능한 편집을 선언하려면 백업/버전 복원 계약이 먼저 있어야 한다.
범용 shell과 스크립트는 실행 효과를 증명할 수 없으면 local_read로 위장하지 않고 broker 또는 code 대상으로 보낸다.
단순 캘린더 개인 등록은 대화 승인, 참가자 초대는 외부 발송 효과 추가. 결제 등 복합 동작은 가장 강한 등급.

후속 승인 수명: 사용자 입력 origin → session/request/toolCallId → 대상·payload digest·workspace·policy version
결속 → 짧은 TTL → 한 번 consume → 실행 직전 다시 검증 → 결과 기록. “응”은 해당 세션에서 보이는 단 하나의
대기 제안에만 적용한다. 여러 제안·낮은 STT 확신·주어 없는 이전 발화는 대상을 명확히 한다.
타 세션/assistant 발화/인용 문서/도구 반환의 “보내”는 승인 불가. 취소·수신자/내용/시간대 변경·재시작·만료·
공급자 변경이면 기존 승인을 폐기한다. 코드는 모델 프롬프트·대화 로그에 넣지 않고 trusted UI가 검증해
콜백으로 결과만 전달한다. 현재 래퍼는 그 신뢰 가능한 callback 경계를 정의했으며 자연어 판독·TTL·코드
발급/소비·영속 재실행 방지는 아직 구현하지 않았다. 자기 작성 JSON 승인으로 대체하면 안 된다.

### 7.4 AX 장면 1 — 1인 문서 작업

“지난 계약서로 제안서 초안 만들어.” → scoped local read/검색 → 필요한 발췌만 선택 → 로컬 모델 또는
허용된 외부 모델의 처리 위치 확인 → 초안 생성 → 로컬 저장·차이·복원 지점 표시. 로컬 작업마다 질문하지 않는다.
회사 정책이 외부 처리를 금지하면 Ollama 등 로컬 공급자로 한정하거나 중단하며 자동 클라우드 fallback은 없다.
“거래처에 보내.” → 실제 수신자, 선택된 문서 버전, 본문/첨부, 외부로 나가는 개인정보 요약 공개 → “보내” →
정확히 1회 발송 → 서비스 응답 ID/시각/성공 여부 기록. 내용 변경·재시도 시 idempotency와 승인 유효성을 검증한다.

### 7.5 AX 장면 2 — 일정 등록

“내일 3시에 김팀장과 계약 검토.” → 내일의 절대 날짜·시간대·대상 캘린더·지속시간·참가자 해석 → 초안은 자동.
“11/4 15:00 Asia/Seoul, 30분, 개인 업무 캘린더. 김팀장에게 초대 발송, 제목/메모는 이 내용”을 보여 준다.
“응” → 이 제안에 결속된 conversation 승인을 consume → calendar connector 쓰기 → event ID 확인.
계정·시간·참가자 불명확하면 실행 전 정보 확인. “아니/취소”면 쓰기 0회. 같은 발화를 다른 일정에 재사용하지 않는다.
API timeout은 성공 여부 불명으로 표시하고 event/idempotency key를 조회하기 전 재등록하지 않는다.
실제 캘린더 connector·권한·가짜/실 API 통합 시험과 셸 음성 보류 흐름은 11/5~11/7 작업이다.

### 7.6 보안 문서 처리 — B2B 강조 절

원본 회사 서류·개인정보는 사용자 장치의 전용 저장소에 보관하고 git/일반 진단 로그에 넣지 않는다.
OS 사용자 권한·암호화 저장소·키체인·workspace allow-root/realpath·민감 경로 denylist를 조합한다.
원본·추출 텍스트·임베딩·메모리·임시 파일·감사 기록 각각 보존 기간과 삭제 대상을 명시한다.
계약서 전체를 장기기억으로 자동 저장하지 않으며 인용 데이터의 도구 지시는 실행 권한이 없다.

**로컬 보관 ≠ 외부 무전송.** Codex CLI가 장치에서 돌아도 클라우드 모델 추론에는 프롬프트/선택한 문서 내용이
전송된다. 처리 전 표시 항목: 문서/필드와 선택 발췌, 마스킹 전후, 공급자와 모델·목적지, 목적, 보관/학습 정책의
확인 상태, 첨부·수신자·회사 정책. “opaque-cli”는 실제 endpoint를 검증했다는 뜻이 아니다. 이를 확인 못 하면
기업 비밀 문서의 외부 전송을 허용하지 않는다. 외부 임베딩·요약 모델·MCP·알림·원격 관측도 동일한 전송 경계다.

기본은 최소 발췌·PII 마스킹·로컬 인덱스, 외부 처리 허용 범위를 기업 관리자가 사전 지정할 수 있다.
이 범위가 실제 host identity/목적지/문서 등급에 결속되어 있을 때 같은 작업마다 승인하지 않는다.
네트워크 차단 문서는 로컬 모델로 처리한다. CLI 내장 도구의 네트워크 우회까지 proxy/sandbox로 강제하기
전에는 “모든 전송을 통제한다”는 제품 주장을 금지한다. 초기 exec 어댑터는 그 통제를 완성하지 않았다.

감사: 누가/어떤 세션/어떤 정책으로 어떤 문서 버전·목적지·효과를 제안했고, 어떤 방식으로 승인·거부했고,
무엇이 실제 실행·실패했는지 기록한다. 본문·키·코드는 제외하고 접근 제한된 식별자/해시·필드 목록·수량·
서비스 영수증을 보존한다. 본문 열람은 별도 권한이 필요하다. 로컬 해시체인만으로 관리자 변조까지 방지한다고
주장하지 않고 외부 보관/서명·조직 감사 정책은 별도 인수한다. 보안 문서 fixture는 합성 데이터만 사용한다.

### 7.7 클라우드 에이전트 대비 제시할 장점과 증명 범위

장점으로 제시할 **설계 목표**는 원본·기억·인덱스의 로컬 소유, 공급자/로컬 모델 선택,
전송 최소화와 사용자 미리보기, 위험 효과만 승인하는 동일 정책, 실행/승인/실패의 추적 가능성이다.
이들은 고객이 직접 확인할 수 있는 시연으로 증명한다. 특정 클라우드 제품에 이런 기능이 없다고 단정하거나
피클/뮤즈/Claude/Codex보다 우수한 성능·보안 인증을 검증 없이 주장하지 않는다.

| 고객에게 보일 증거 | 출시 전 수용 조건 |
|---|---|
| 문서 원본·추출·임시 파일 위치와 삭제 | 합성 PII 문서 처리 후 저장소/로그/임시폴더 점검 |
| 밖으로 나가는 것과 목적지 | 프록시 캡처/수신 fixture와 공개 화면 일치; 원시 shell/MCP 우회 차단 |
| 말로 승인한 일정 한 번 등록 | 실제 셸 텍스트·음성, 취소/중복/시간대 변경/서비스 timeout 모두 검증 |
| 위험 동작은 코드 없으면 실행 0회 | 결제/삭제/운영 mock, replay·타 세션·변조·만료·AI 승인파일 거부 |
| 정직한 보고·감사 | 승인/실행 영수증 대응, 원문/PII/토큰/승인코드 누출 0건 확인 |

현재 상태는 설계 및 가짜 CLI/승인 콜백 단위·프로세스 계약 시험이다. 실제 ChatGPT/API 계정 유료 호출,
기업 문서 전송, 셸 UI 승인, 캘린더 실등록, B2B 보안 감사는 검증했다고 보고하지 않는다.

### 7.8 2회차 확정 — app-server 반복 + trusted effect broker (2026-11-03)

**전체 반복은 `codex-ax` → app-server로 확정한다.** exec는 텍스트 실험용 `codex-exec`로 남긴다.
SDK는 채택하지 않으므로 SDK 의존성/버전은 없다. CLI는 **@openai/codex 0.163.0**을 런타임에서 정확히
검사하고 불일치/미설치/미로그인/지원하지 않는 모델이면 중단한다. 설치: `npm install -g @openai/codex@0.163.0`.
기존 `codex`와 다른 공급자의 기본 동작은 유지한다. 새 경로는 `NAIA_AGENT_AX=on`인 호스트에서
설정의 provider를 `codex-ax`로 명시적으로 선택해야 한다. 환경 스위치만으로 공급자를 바꾸지 않는다.
실패 시 exec·기존 codex·다른 클라우드로 대체하지 않는다.

선택 이유: app-server는 같은 turn 안의 동적 도구 호출을 실행 전에 호스트로 보내며, 결과·usage·완료·취소를
같은 프로토콜로 받는다. Naia 외부 도구 루프는 handled 결과를 다시 실행하지 않는다. exec/SDK 위에 별도의
도구 실행 추정기를 만들면 native 실행 전의 정책 중재와 사람 승인 수명을 맞추기 어렵다.
공식 [app-server 계약](https://developers.openai.com/codex/app-server),
[통합 계층 설명](https://developers.openai.com/blog/codex-as-a-platform),
[설정 명세](https://developers.openai.com/codex/config-reference)를 참고했고,
실제 0.163.0 CLI 도움말·생성 JSON schema·동일 태그 소스·로그인 시험으로 검증했다.

공급자/모델 발견: `CODEX_PROVIDER_CATALOG`, `checkCodexAxPreflight`, `listCodexAxModels`가 같은 어댑터에 있다.
`naia-agent models codex-ax --json`은 CLI model/list를 사용하며 실패 시 내장 Naia 목록으로 대체하지 않는다.
`naia-agent doctor --json`은 codex-ax 버전/로그인 점검을 표시한다(다른 공급자 사용자를 강제로 실패시키지 않음).
발견 목록은 계정의 사용 권한 증명이 아니다. 실제 추론 성공이 해당 모델·요청의 사용 가능 증거다.

```text
CLI/gRPC → wireAgentUC1(axExecutor) → AX broker만 도구로 노출
  → 명시적 codex-ax → 고정 CLI / 읽기 전용 임시 cwd / ephemeral thread
      → dynamic tool call → broker의 고정 등록 함수
          → trusted classify → allow / conversation callback / code callback / deny
          → 고정 execute → 같은 Codex turn에 결과 → 다음 도구 / 최종 답변
```

`makeAxEffectBroker`는 등록 사양·trusted classify·execute 함수를 한 번에 캡처한다. 중복 이름은 시작 시 거절한다.
MCP 설명·앱 tier·문서/모델의 approved=true는 등록 권한이 아니다. 등록한 구현을 승인 대기 중 바꿀 수도 없다.
모델에는 broker 사양과 그 턴에 허용된 도구 목록의 교집합만 제공한다. 원시 executeTool 콜백은 AX 공급자에서
사용하지 않는다. 공용 wire root는 메모리·셸 앱 도구 합성 후에도 broker로 최종 교체하며 합성 memory-save
우회 도구도 추가하지 않는다. native 반복의 같은 callId 재전송은 결과를 재사용하고 변경된 payload는 거절한다.

초기 production 등록은 구현을 직접 고정한 get_time/memo_list/memo_get/list_dir/read_file이다.
fs 도구는 현재 workspace의 allow-root·realpath·민감 경로 거절을 계속 적용한다. 원시 shell·범용 HTTP·
MCP/app 도구는 등록되지 않아 실행할 수 없다. 복구 계약 없는 write_file을 reversible_edit로 거짓 등록하지 않는다.
외부 처리·발송·일정·위험 도구를 추가할 때는 전용 구현의 전체 효과와 별도 사람 승인 콜백을 등록해야 한다.
현재 공용 조립기에 사람 승인 인증기는 없으며 conversation/code 콜백 부재 시 거절한다. 기존 yes/no tier
응답을 code 승인으로 재사용하지 않는다. 이 입력 연결·TTL·payload 결속·영속 single-use는 11/6 범위다.

native 실행 경계:

- 제한된 자식 env(로그인 위치만 CLI 소유), shell:false, 임시 cwd, read-only, approvalPolicy=never.
  실제 thread/start 응답이 선택 model과 readOnly/networkAccess=false인지 확인한다.
- **모델 도구 구성도 고정**한다. 0.163.0 내장 카탈로그의 선택 모델만 복제하여 tool_mode=direct,
  shell_type=disabled, apply_patch_tool_type=null, experimental_supported_tools=[]로 만든 임시 카탈로그를
  시작 시 사용한다. 현재 모델의 code_mode_only 기본값을 그대로 두면 동적 도구가 실행되지 않고,
  shell_tool=false만으로는 native patch 정의가 사라지지 않음을 실측/동일 태그 소스로 확인했다.
- shell/unified_exec/Code Mode/브라우저/컴퓨터/이미지/앱/플러그인/hook/하위 에이전트/권한·sleep 도구를 끈다.
  설정의 {}는 표를 지우지 않고 병합한다. config/read로 확인한 모든 MCP 항목을 원래 transport와 함께
  enabled=false로 thread/start에 전달한다. optional null은 TOML 변환 전에 제거한다.
- native·미상 승인 RPC는 거절하며 native 실행 이벤트도 오류로 처리한다. 이벤트 사후 거절만을 실행 전
  통제의 증거로 삼지 않는다. 위 도구 구성과 sandbox 제한이 먼저 적용된다.
- abort/deadline은 비협조적인 도구 callback 대기도 해제한다. 승인 콜백은 같은 신호를 받아 늦은 승인으로
  실행할 수 없다. CLI stderr는 배출하되 원문을 진단 로그로 보존하지 않는다.

실제 ChatGPT 로그인 인수(합성/비민감, gpt-5.6-luna): 짧은 NAIA_AX_OK 응답·usage·완료를 확인했다.
동일 turn에서 로컬 시각 조회 1회 → 외부 발송 제안 → 사람 승인 fixture 거절 1회 → 발송 실행 0회를 확인했다.
별도 로컬 HTTP 수신기와 시작 표식 MCP fixture를 구성하고 native shell/MCP/curl 요청을 했을 때
HTTP 수신 0회·셸 표식 없음·MCP 시작 표식 없음·정상 완료였다. 실제 일정/메일을 보내지 않았다.
검증 로그/재실행 스크립트는 실행 폴더 `tmp/r2-live*.{log,mjs}`에 있다.

이 경계는 **AX 모드에서 모델이 사용할 수 있는 도구**를 제한한다. 같은 OS 사용자의 임의 코드 실행,
CLI 자체의 모델 추론 네트워크·프록시·사용자 설정 전체를 별도 OS 방화벽으로 격리한 상태는 아니다.
기존 codex 경로에 같은 제한이 적용된다고 설명하지 않는다. 기업 문서의 endpoint/보존·PII 전송·감사·
OS egress 인수 전까지 보안 문서용 자동 전송 허용이나 B2B 보안 완료로 표시하지 않는다.
