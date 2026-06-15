# UC-memory — 대화 턴 recall 주입 / save (naia-memory 연동 계약)

상태: in_progress · 2026-06-12 · 브랜치 `feat/memory-wiring`

## P01 사용자 시나리오 (UC-MEM-1)

사용자가 한 턴에서 사실을 말하면(예: "내 비밀 코드명은 X야"), 다음 턴에서 그 사실을
물었을 때("내 코드명이 뭐였지?") 에이전트가 **장기기억에서 회상**해 답한다. 회상된
사실은 모델 사전지식이 아니라 **이전 턴에 저장된 기억**에서 온다.

## 위협 모델 경계 (threat model — 이 UC 범위)

이 UC = **단일 신뢰 사용자**의 **신뢰된 워크스페이스**에서 **협조적 클라이언트(naia-os)** 와의 로컬
recall/save 배선(목표 2단계, 도그푸딩). 다음은 **범위 밖(conceded)**:
- **적대적 로컬 환경**: 악의적 symlink(`.naia/workspace-id` no-follow·lstat), 호스트의 다른 적대 사용자,
  store 경로 탈취 등 — 로컬 신뢰 가정. (store 파일 권한 0600·symlink 처리는 naia-memory LocalAdapter 책임.)
- **DoS/flood**: newline 없는 무한 stdin 라인(readline 내부 버퍼 — agent 전역·pre-existing 이슈),
  대량 동시 요청 폭주. boot 큐는 backpressure 로 *정상* 부하만 다룬다.
- **워크스페이스 clone 격리**: cp -r/템플릿/백업복원로 `.naia/workspace-id` 가 복제되면 move 와 구분 불가
  (OS 레지스트리 필요 = 미래). 완화 = 소비 워크스페이스 gitignore.
- **at-rest 암호화/scrub**: 저장 매체 암호화·민감정보 scrub = **UC3**(`memory-scrubber.ts`) 별도 책임.

범위 안 = 정상 동작 정확성·불변식(terminal/usage 1회)·무회귀·project 격리(정상 경로)·lifecycle·bounded
주입·config 오류 fail-closed·동시 *턴* 안전.

## P03 요구사항

- **FR-MEM-1 (recall 주입)**: 턴 처리 시작 시, **이 턴의 새 user 입력**(= messages 배열의 *마지막*
  메시지가 user 인 경우 그 content)으로 `memory.recall(query)` 을 호출한다. recall 은 **구조화
  `RecalledMemory{facts,episodes}`(비신뢰 *bounded excerpt* — 거대 항목은 절단 표식 `…[절단됨]` 보존)** 을 반환하고, app 이 domain `formatRecalledMemory` 로
  블록을 만들어(있으면) systemPrompt 에 주입한 뒤 provider 를 호출한다. 마지막 메시지가 user 가
  아니면(assistant continuation/regenerate) 새 입력이 없으므로 recall/save 생략 — "전체에서 마지막 user
  탐색"은 과거 발화 재사용 버그라 금지. recall 은 **query 가 비-공백일 때만** 호출한다(빈/공백 query =
  app 이 recall 자체를 단락, FR-MEM-1a). recall 은 abort + deadline(5000ms) 과 race — 무응답/취소 시 주입
  생략하고 턴 진행(terminal 항상 방출).
- **FR-MEM-1a (빈 query 정책 — app 소유)**: query 가 빈/공백이면 **app(핸들러)이 recall 자체를 단락**
  한다(어댑터에도 동일 가드, 방어 심층) — 정책이 어댑터 구현에 종속되지 않게. 빈 query 가 전체/임의
  top-K 를 끌어와 무관한 민감정보를 빈 턴에 주입하는 것을 막기 위함.
- **FR-MEM-10 (출처 보존 — 자기증폭 방지)**: recall 은 episode 의 **출처 역할(user/assistant)** 을
  보존(`RecalledEpisode{content, role}`)하고, formatter 가 사용자 진술("사용자가 말함")과 assistant
  생성물("이전 내 답변(미검증)")을 구분 표시한다. **fail-safe**: 오직 role==="user" 만 신뢰 라벨;
  assistant·tool·역할 누락(불명)은 모두 "미검증"으로 떨어뜨린다(provenance 없으면 안전하게 미검증). 실
  adapter save→recall 역할 왕복 통합 테스트로 검증(수동 객체 formatter 테스트만이 아님). **facts 경로도 일관**: semantic 파생 fact 는 직접 사용자
  진술이 아니므로("출처 불명") "파생 기억·미검증"으로 표시 — 둘 다 검증된 사용자 사실처럼 과신·재강화되는
  확증루프를 막는다(naia 기억 철학). cf [[project_naia_dreaming_offline_consolidation]] 확증루프 경계.
- **FR-MEM-8 (비신뢰 회상 — 신뢰 경계 표시 + 위조 방지)**: 회상 내용은 과거 대화에서 온 **비신뢰
  데이터**다(지시문 섞일 수 있음). domain `formatRecalledMemory` 가 회상 블록을 명시 경계 + "지시
  아님/명령 무시" 프레이밍으로 감싸고, content 내 경계표식 위조를 무력화한다. **보장 범위 한정**: 이는
  (1)신뢰 경계 표시와 (2)직접 경계-위조 방지까지의 *완화책*이며, 모델이 systemPrompt 안의 적대적
  자연어를 따르지 *않음을 보장하지는 않는다*(잔여 모델 순응 위험은 모델 행동 속성). 완전 차단이
  요구되면 구조화 분리 입력(별도 provider 채널)이나 행동 기반 공격 corpus 검증이 필요(미래). 테스트는
  프레이밍 존재 + 위조 무력화를 검증(모델 행동은 아님). cf [[threat-model]].
- **FR-MEM-2 (save)**: provider 가 최종 응답을 낸 시점 = **커밋 지점**. 그 턴의 user 발화 + assistant
  응답(턴 전체 누적 텍스트)을 `memory.save()` 로 저장한다. **순서**: save 를 await 한 *뒤* wire `finish`
  를 방출한다 — 클라이언트가 finish 수신 즉시 다음 턴을 보내면 그 recall 이 이 save 보다 먼저 돌아 저장
  전 상태를 회상하는 레이스가 생기므로 save→finish→(다음 턴)recall 인과 순서 보장. save 는 deadline
  (5000ms)으로 bound — 무응답이어도 finish/drain 영구정지 방지(timeout→로그 후 finish).
  - **취소 의미 불변식**: **커밋 지점 = 최종 무도구 응답 분기 진입(= (b) 가드 통과 직후)**. 취소는 (b)
    가드까지 인정(그 전 도착 취소 → cancelled, UC1 계승 — provider 가 응답을 냈어도 (b) 전 취소면
    cancelled, save 안 함). (b) 통과해 분기에 들어오면 커밋 — 그 *이후*(save 중) 도착한 취소는 terminal
    결과를 바꾸지 않는다(finish 유지, save 무시 안 함). 즉 "저장된 턴"과 "cancelled 턴"은 (b) 가드에서 배타. ⚠️ **finish 는 save 성공을 보장하지 않는다**: save 는 best-effort(실패/timeout/부분
    저장이어도 finish 는 그대로, 진단 로그만). 소비자는 finish 를 영속 완료 증표로 해석하면 안 된다.
    영속 확인이 필요하면 별도 save-상태 채널이 필요(현재 범위 밖 — 도그푸딩/단일 사용자엔 불필요).
  - **프로토콜 전제(다음 턴 freshness)**: save→finish 순서는 "직전 턴 기억이 다음 턴 recall 에 보인다"를
    *클라이언트가 같은 대화의 다음 요청을 이전 finish 수신 후 보낸다*는 전제 하에 보장한다(표준 챗 UX =
    응답 표시 후 다음 입력, os→agent 의 턴-바이-턴 계약). 같은 대화 요청을 finish 전에 파이프라인하면 recall
    이 save 보다 먼저 돌 수 있다(freshness 미보장) — 그 경우는 conversation-key barrier 가 필요(미래).
    same-process 2턴·실프로세스 2턴 테스트가 이 gated 패턴(턴2 를 턴1 finish 후 전송)을 검증.
  - **assistant 텍스트 범위**: 도구 라운드 preamble 까지 포함한 *턴 전체* 누적분(최종 round.text 만 X).
  - **원자성 경계(best-effort)**: save 는 user/assistant 2회 encode 라 원자적이지 않다. 2번째 encode
    실패 시 user 만 부분 저장될 수 있으나, recall 은 content 기반이라 부분 episode 도 무해(정확성 위반
    아님). 핸들러는 save 실패/timeout 을 비치명(진단 로그·턴 유지)으로 처리. 트랜잭션은 naia-memory 가
    노출하지 않아 범위 밖.
  - **timeout 경로의 인과 범위 한정 + orphan 경계**: save→finish→다음 recall 인과 보장은 **deadline
    안에 완료된 save** 에만 적용된다. timeout 시 finish 를 방출하고 save 는 백그라운드 best-effort(다음
    턴 가시성·마지막 턴 영속 미보장; 종료 시 close 후 접근/프로세스 종료로 유실 가능, 모두 흡수돼
    턴/종료엔 무영향). deadline 은 *호출부* race 만 끝내고 backend 작업 자체는 취소하지 않으므로(포트가
    AbortSignal 미전달 — LocalAdapter 가 취소 미지원), 지속적 backend hang 시 미완료 작업(orphan)이 턴마다
    누적될 수 있다. **경계**: (1)정상 로컬 store(ms 단위)에선 timeout 자체가 안 나 orphan 0, (2)병리적
    hang 은 diag 로그로 표면화, (3)30s 종료 grace+force-exit 가 프로세스 수명을 bound 해 무한 누적 차단.
    backend 가 취소를 지원하게 되면 recall/save 에 AbortSignal 전달이 후속 과제. **close vs timeout-save
    동시성**: LocalAdapter 는 단일 worker 스레드 + atomic-rename 영속이라 timeout 된 encode 와 close 가
    *병렬 손상*을 일으키지 않는다(JS 단일 스레드 interleaving, parallel 아님; rename 원자적) — "어댑터
    흡수"는 이 동시성 모델에 근거. quiesce/operation-registry 포트 계약은 cancelable backend 시 후속.
  - **동시 턴·세션 순서 무관성**: 한 프로세스가 여러 requestId 를 동시 처리할 수 있고 encode 는 교차될
    수 있다(A-user,B-user,A-asst,B-asst). recall 정확성은 **content+project 기반**이라 encode 순서/인접성에
    무관 — 교차 저장돼도 양쪽 사실 모두 회상된다(테스트 ⑬). sessionId 는 provenance 메타데이터일 뿐
    회상 키가 아니다. 안정적 conversation 단위 provenance 가 필요하면 ChatRequest 가 sessionId 를 싣는
    확장이 미래 과제(현재 단일-project-per-process 에선 프로세스 수명=세션으로 충분).
- **FR-MEM-9 단일-project-per-process + workspace 유도 격리**: 한 agent 프로세스 = 한 사용자/워크스페이스
    (정본 os→agent gRPC 워크스페이스 주입). project 는 어댑터 생성 시 고정. 다중 테넌트를 한 프로세스가
    처리하는 토폴로지는 미지원(그 경우 scope 를 MemoryPort 호출 인자로 — 미래). ⚠️ 진입점 project 정본 =
    **`NAIA_MEMORY_PROJECT` override → workspace UUID → (실패) memory 비활성(fail-closed)`** 단일 경로.
    고정 `"default"` 나 경로 해시는 쓰지 않는다(서로 다른 워크스페이스가 한 키/store 를 공유하면 교차 누설
    = FR-MEM-5 위반). **workspace identity = 워크스페이스에 영속 저장된 UUID**(`<adkPath>/.naia/workspace-id`,
    없으면 발급·기록): (1) 워크스페이스 *이동/이름변경* 시 UUID 가 따라가 기억 연속성 유지, (2) 같은 경로에
    *새* 워크스페이스가 생기면 UUID 가 달라(없으면 새 발급) 이전 워크스페이스 기억이 누설되지 않음(경로
    재사용 leak 차단).
    **원자성/내구성(fail-closed)**: ENOENT 만 발급 대상 — invalid 파일·비-ENOENT read 오류(EACCES/corruption)는
    throw 해 잘못된 identity 로 회전·누설하지 않는다(호출부가 memory 비활성=isolated). 발급은 **배타 생성(`wx`)**
    — 동시 부팅 경쟁 시 EEXIST 면 winner 재조회(둘이 다른 UUID 쓰는 것 방지). ⚠️ **한계(clone 미구분)**: id
    파일이 *복제*(템플릿/백업복원/cp -r)되면 move 와 구분 불가 → 두 워크스페이스가 같은 identity 공유(교차
    누설). 진짜 clone 격리는 OS 관리 레지스트리 필요(미래). 완화 = 소비 워크스페이스가 `.naia/workspace-id`
    를 VCS/템플릿 복사에서 제외(gitignore) 권장. **config 오류 fail-closed**: id 파일 ENOENT 라도 workspace
    root 가 실재 디렉터리가 아니면 발급하지 않고 throw — 잘못된 NAIA_ADK_PATH 가 새 workspace 로 조용히
    분기되는 것 방지(memory 비활성). ⚠️ **store 파일도 project(workspace)별로 분리**(기본 store
    경로에 project 하위 디렉터리 포함) — 단일 store 를 여러 워크스페이스가 공유하면 종료 flush 의
    atomic-rename 이 lost-update 로 서로 덮어쓴다(project 는 검색 격리일 뿐 파일 동시쓰기 미보장). 파일 분리로
    **서로 다른 workspace 간** store 경합을 제거한다. ⚠️ *단일-writer 가정*: **같은 workspace 를 두 프로세스가
    동시에** 구동하는 토폴로지는 여전히 같은 store 파일을 공유하므로 lost-update 가능 — os→agent 정본(한
    워크스페이스 = 한 agent 프로세스)에선 발생 안 함. 진짜 동시 다중 프로세스가 필요하면 파일 잠금/프로세스별
    journal+merge 가 필요(LocalAdapter 한계, 미래). 디렉터리 조각은 project 해시(traversal-safe). `NAIA_MEMORY_DIR`
    (base dir) 지정 시도 그 아래 project-hash 서브디렉터리로 분리; `NAIA_MEMORY_STORE`(정확 파일)는 분리
    우회 **escape hatch**(테스트/단일-store, 다중 워크스페이스 동시 시 lost-update 위험). sessionId
    는 기본 **프로세스별 고유**(`proc-<uuid>`, 재시작마다 별 세션; 회상은 content+project 기반이라 정확성엔
    무관) — `NAIA_MEMORY_SESSION` override 는 의도적 고정(세션 위생 완화, 고급 용도 escape hatch).
- **FR-MEM-3 (옵셔널·비파괴)**: `memory` 미주입 시 동작은 기존과 동일(UC1/UC5 무회귀).
  recall/save 가 throw 해도 턴을 깨뜨리지 않는다(진단 로그만; 채팅 우선).
- **FR-MEM-4 (실 import)**: 어댑터는 `@nextain/naia-memory` 의 MemorySystem(LocalAdapter)
  을 실제로 import 해 recall/encode 한다(목 아님).
- **범위 경계 — scrub 은 UC3**: 저장 전 민감정보(자격증명/PII/도구출력) scrub(`memory-scrubber.ts`)은
  정본 수직 앵커(`docs/progress/agent-vertical-anchor-2026-06-10.md` A-memory 행)에서 **UC3 (이식+보충)**
  로 별도 배정된 책임이다 — 이 UC-memory(recall 주입/save 배선)의 범위가 아니다. 본 UC 는 원문을 그대로
  저장하며, 저장 단계 데이터 최소화는 UC3 에서 scrub 정책으로 다룬다(누락 아님, 분리). recall 프레이밍은
  주입 단계 신뢰경계이지 저장 단계 노출을 해결하지 않음을 명시.
- **NFR**: off-arm 무영향, terminal 래치/usage 1회 불변식 보존, 포트만 사용(domain 순수).
- **FR-MEM-5 (project 격리)**: 회상은 project 경계로 격리한다. 어댑터는 `scopeMode: "strict"` 를
  기본으로 전달한다(naia-memory 기본값 "soft" 는 타 project episode/fact 까지 누설 → 잘못된 기억이
  systemPrompt 에 주입되는 격리 위반). cross-project 회상이 필요할 때만 "soft" opt-in.
- **FR-MEM-6 (종료 드레인·영속)**: LocalAdapter 는 encode 를 버퍼링하고 `close()` 에서 store 로
  flush 한다. 런타임 진입점은 stdin EOF 시 (1)`drain()`(in-flight 턴 save 완료 대기) → (2)`memory.close()`
  (flush) → (3)stdout flush(빈 write 콜백) → (4)exit 순서로 종료해 마지막 턴 save·wire 출력 유실을 막는다
  (라우팅은 fire-and-forget). EOF 후엔 readline 이 닫혀 신규 요청이 들어오지 않는다(드레인 완료=in-flight 없음).
  **비동기 init 보존**: 라우터/종료 핸들러는 동적 import *후* 등록되므로 init 중 도착 입력은 **boot 큐**에
  보관했다 ready 시 순차 라우팅하고, init 중 EOF 는 **latch** 로 보류했다 핸들러 등록 시 실행한다(첫 요청
  유실·조기 EOF flush 누락 방지). boot 큐는 라인 수(1000)·byte(8MB) 상한에 닿으면 **stdin 을 pause(backpressure)**
  — 드롭이 아니라 일시정지라 요청 무손실·terminal 불변식 무영향(OS 파이프 버퍼링, ready 시 resume). 드롭+부분
  error 방출은 control frame 오방출/중복 terminal 위험이라 채택 안 함. EOF latch 발화 시 init-watchdog(30s
  force-exit)을 걸어 *hung init + 조기 EOF* 에서도 영구
  정지하지 않게 한다. store 디렉터리는 0700 생성(at-rest 기밀성 저비용 방어); 파일 권한(0600)·symlink·비정규
  파일 처리는 파일 I/O 를 소유한 naia-memory LocalAdapter 책임(이 wiring UC 범위 밖).
  **단계별 실패 격리**: drain·close 각각 독립 try/catch(실패=진단 로그만)로 후속 단계(특히 stdout flush)를
  건너뛰지 않는다. close 는 *hang* 도 flush 를 막지 못하게 timeout(8s)으로 bound — 어떤 경우든 stdout flush
  줄에 항상 도달해 이미 생성된 terminal 출력을 보존.
  **종료 grace(30s) 안전망**: 강제 종료 timer 를 await *전* 최상단에 설치(close 가 hang 해도 종료 보장).
  EOF=클라이언트 이미 연결 종료 → grace 목적은 응답 전달이 아니라 in-flight save 영속. 30s ≫ memory
  deadline(5s)·정상 턴 지연이라 정당한 작업 미선점, 병리적 provider/close hang 만 차단(한계 케이스 best-effort 유실).
- **FR-MEM-7 (bounded 주입)**: recall 블록은 항목당 `maxItemChars`(기본 500) + 블록 전체 `maxBlockChars`
  (기본 2000) 하드 캡으로 절단한다 — 긴 기억 1건이나 다수 항목이 systemPrompt 예산을 무한정 잠식하지
  못하게. **포트 반환 상한(방어)**: 어댑터는 항목 수(topK)·각 content(RAW_ITEM_CAP=4000자)로 반환을
  bound, formatter 는 항목 수(MAX_ITEMS=64) 상한 + 예산 충족 시 순회 조기중단 — 거대 반환이 deadline 후
  동기 처리에서 루프/메모리를 고갈시켜 lifecycle bound 를 우회하는 것 차단. **topK 는 외부 입력이라 어댑터가
  1..RAW_MAX_ITEMS(50) 유한 정수로 clamp**(거대/Infinity/NaN 가 backend 조회량을 폭증시키는 것 차단,
  backend 호출·반환 slice 모두 이 값 사용). **입력 상한**: recall query(QUERY_CAP=4000)·save 원문(SAVE_CAP=
  20000, user/assistant 각각, 초과 시 절단 표식)도 어댑터가 bound — 거대 턴이 embedding/디스크/flush 비용을
  폭증시키는 것 차단. store 전체 quota/retention(decay·archival)은 naia-memory(R3 lifecycle) 책임. **설계 경계**: 현재 ConversationPort 는 passthrough(token-budget 없음)라 recall 을 assemble
  *이후* 주입하나, ConversationPort 가 예산 정책을 가지면 recall 을 assembly 입력으로 옮겨 전체 프롬프트
  예산 안에서 우선순위·절단해야 한다(그때까지의 안전 상한이 이 하드 캡).
- **취소/종료 시 recall 생명주기**: `MemoryPort.recall` 은 signal 을 받지 않으므로 취소 시 호출부만
  `raceAbort` 로 즉시 풀리고(주입 생략) 실제 recall 은 백그라운드에서 끝난다. 이 abandoned recall 의
  늦은 resolve/reject 는 `void p.catch()` 로 흡수되며, close 후 접근이 발생해도 어댑터가 흡수(턴/종료 무영향).
  best-effort 회상 — 취소된 턴의 회상 결과는 버려진다.

## 설계 (seam)

`ChatTurnHandler.onChatRequest`:
1. `asm = conversation.assemble(...)` 직후 → **`lastUserText.trim()` 이 비어있지 않을 때만**
   `mem = await raceAbort(memory.recall(lastUserText), signal, deadline)`
   → `recalled = mem ? formatRecalledMemory(mem) : ""` → `systemPrompt = recalled ? asm.systemPrompt + "\n\n" + recalled : asm.systemPrompt`.
   recall 반환은 **구조화 `RecalledMemory{facts,episodes}`(원문, 비신뢰)** 이고, 프레이밍(FR-MEM-8)·예산
   절단(FR-MEM-7, body 만·끝 경계 보존)은 **domain `formatRecalledMemory`** 가 강제한다 — 어떤 MemoryPort
   구현을 쓰든 보장(헥사고날: 프롬프트 정책은 app/domain 소유, adapter 는 데이터만). recall 을 abort+deadline
   과 race — 멈춰도 풀려 (a) provider-전 가드가 cancelled 방출·registry 해제(terminal 항상 방출). 취소/무응답=주입 생략.
2. 기존 루프는 이 `systemPrompt` 로 `runRound` (asm.systemPrompt 대신).
3. (b) 가드(`signal.aborted`→cancelled) 통과 후 `round.calls.length === 0` 분기 진입 = **커밋 지점**.
   여기서 `memory?.save(lastUserText, 턴전체텍스트)`
   를 deadline 으로 bound 해 await → `terminalFinish()`. **취소 재검사 없음** — provider 가 최종 응답을
   낸 뒤(커밋 지점 이후)엔 취소를 무시하고 finish 한다("저장된 턴=finish 된 턴" 불변식; 취소는 (b)
   가드까지만 인정). save 실패/timeout=진단 로그, 턴 유지. save 는 wire 무방출이라 usage 1회/finish XOR
   error 불변식 무영향.

포트: `MemoryPort { recall(query): Promise<RecalledMemory>; save(user, assistant): Promise<void> }`.
lifecycle: `ManagedMemoryPort extends MemoryPort { close(): Promise<void> }` — 핸들러는 `MemoryPort` 만
의존(close 안 씀), 소유·종료(close=flush, FR-MEM-6) 책임은 진입점/composition. factory 는 ManagedMemoryPort 반환.
**포트 동시성 계약(호출 안전 + 최종 수렴)**: 핸들러는 여러 requestId 의 턴을 *동시*로 처리하므로 한
MemoryPort 인스턴스에 recall/save 가 병렬 호출될 수 있다 — 구현체는 **호출 안전**해야 한다(저장 유실·
버퍼/상태 손상·크래시 없음). 단, save 는 user/assistant 2-encode 라 **부분 가시성은 허용**(진행 중 save 의
중간 상태를 동시 recall 이 볼 수 있고 완료 후 최종 수렴 — 턴 단위 원자성 미보장, eventual consistency).
LocalAdapter 는 호출 안전 + 최종 수렴을 만족(동시 턴 교차 저장 테스트 ⑫). 더 강한 원자성이 필요하면
app/adapter 경계에 직렬화 큐를 둬야 한다.
**read-your-writes(필수, freshness 근거)**: `save()` resolve 후 같은 인스턴스에 시작하는 recall 은 그 save 를
본다 — FR-MEM-2 의 직전 턴 가시성(save→finish→다음 recall)이 이 포트 보장에 근거. eventual consistency 만
주는 어댑터는 이 계약을 위반(LocalAdapter 는 encode 동기 갱신으로 만족; 영속 재기동 회상 테스트 ②가 입증).
**project 필수(격리 우회 차단)**: `makeNaiaMemory` 는 `project` 를 필수로 받고, ""·공백이면 생성 시점에
**fail-closed(throw)** — 빈 project 가 backend global/기본 scope 로 축약돼 격리를 우회하는 것을 차단한다.
domain: `RecalledMemory{facts,episodes}` + `formatRecalledMemory(mem, opts)`(순수, 프레이밍+예산 절단).
어댑터: `makeNaiaMemory(opts)` → MemorySystem(LocalAdapter) 래핑. recall=검색 결과 **원문**(facts/episodes
content) 반환(빈 query=빈 결과), save=user/assistant encode. project=workspace 유도(FR-MEM-9).

## P02 테스트 커버리지 맵

- **UC-MEM-1 / FR-MEM-1·2·4**: `src/test/uc1-memory-stdio.integration.test.ts` — **실 stdio
  관통** 2-턴: ① 사실 발화 턴(save) → ② 회상 질문 턴(recall→systemPrompt 주입). provider 는
  systemPrompt 에 비밀이 있으면 비밀을, 없으면 "모름"을 답하는 inspecting fake → ②의 wire
  text 에 비밀이 나오면 recall→inject→provider 경로가 stdio 로 관통됨을 증명. 실
  `@nextain/naia-memory` 어댑터 사용.
- **FR-MEM-6 (영속/드레인)**: 같은 test 파일 ② 인스턴스 A save→close → 인스턴스 B 가 같은 store
  에서 회상(재기동 유실 없음), ③ finish 대기 없이 `drain()`→close 해도 in-flight 턴 save 유실 없음.
- **FR-MEM-5 (project 격리)**: 같은 test 파일 ④ tenant-a 기억이 tenant-b recall 에 누설 안 됨(strict),
  같은 project 는 회상됨(대조군).
- **인과 대조군**: 같은 test 파일 ⑥ store 에 비밀이 있어도 memory **미주입** 에이전트는 동일 질문에
  비밀을 못 답함(=기억이 회상의 원인, 모델 사전지식/대화문맥 아님), 같은 store 주입 시 회상됨.
- **FR-MEM-7 (bounded)**: 같은 test 파일 ⑦ `formatRecalledMemory` 직접 — body 만 절단하고 시작/끝
  경계는 보존(끝 경계 잘림 회귀 차단), `…` 표시.
- **FR-MEM-8 (비신뢰 프레이밍+위조방지)**: 같은 test 파일 ⑧ `formatRecalledMemory` 직접(프레이밍 경계) +
  경계표식 위조 무력화 테스트(끝 경계 정확히 1회). 모델 행동은 검증 범위 아님(완화책 한정).
- **FR-MEM-1a (빈 query)**: 같은 test 파일 — 빈/공백 query 는 빈 회상(주입 없음, backend 미호출).
- **FR-MEM-3 fault-injection(불변식)**: 같은 test 파일 ⑨ recall throw / ⑩ save throw / ⑪ recall·save
  hang(memoryTimeoutMs=20) 각각에서 턴이 finish 로 종결 — 정확히 finish 1회·error 없음·usage 1회.
- **인과 순서(save→finish)**: 같은 test 파일 — spy save 가 pending 인 동안 finish 미방출, save 완료 후 finish.
- **커밋 후 취소**: 같은 test 파일 — save pending 중 cancel_stream 도착해도 finish 유지(error/cancelled 아님).
- **FR-MEM-9 격리 유도(단위)**: 같은 test 파일 — `resolveWorkspaceId`(영속 UUID: 재호출 안정·이동 시
  따라감·경로 재사용 시 누설 없음·**동시부팅 EEXIST→winner 재조회**·**invalid/비-ENOENT read 오류→fail-closed
  throw**, **config 오류(workspace root 부재)→throw**), `storeDirKey`(traversal-safe hex). 진입점 인라인이
  아닌 추출 순수 함수라 P04 가 회귀 탐지(SoT=`adapters/workspace-project.ts`).
- **실 진입점 recall→inject e2e**: `uc1-memory-process.integration.test.ts` — `AGENT_PROVIDER=echo-system`
  (systemPrompt 반향) 으로 턴1 save → 턴2 가 턴1 사실을 질문 → wire text 에 비밀 노출 = 빌드된 진입점의
  동적 import→memory 주입→recall→systemPrompt 주입 경로 관통 증명(턴1 은 저장 전이라 비밀 없음=인과 분리).
- **종료/격리(스모크 검증)**: 진입점 OFF 모드 채팅 동작·workspace project 유도·드레인 영속·boot 큐는
  실 프로세스 스모크로 확인. drain/close hang→flush 는 close timeout(8s)+30s grace 로 코드 보장(병리 케이스).
- **동시 턴 순서무관**: 같은 test 파일 ⑫ 두 턴이 겹쳐 save 돼도(느린 provider) 재기동 회상에 양쪽 사실
  모두 존재(content 기반, encode 순서 무관).
- **현재 턴 경계**: 같은 test 파일 ⑬ 마지막 메시지가 assistant(continuation)면 spy MemoryPort 의
  recall/save 가 0회 호출(과거 user 재사용 안 함).
- **실 프로세스 관통**: `src/test/uc1-memory-process.integration.test.ts` — 빌드된 진입점을 child process
  로 구동, 요청 1건 후 stdin EOF → drained 턴 wire 출력(text/finish) 유실 없음 + save 영속(store 에 비밀).
  same-process 2턴 테스트의 turn2 는 turn1 메시지를 싣지 않고 provider 는 systemPrompt 만 보므로 대화문맥이
  출처일 가능성도 배제. 영속/재기동 인과는 ②(A close→B 회상, 새 session)·실프로세스 테스트가 담당.
- **FR-MEM-3 (무회귀)**: 기존 `uc1-agent.contract.test.ts` / `uc5-*` 그대로 통과(memory 미주입).
