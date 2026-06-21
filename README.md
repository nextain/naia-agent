# naia-agent

**naia 생태계의 "뇌" 런타임.** 셸(naia-os)이 메시지를 던지면, agent 가 대화를
조립하고 LLM provider 를 호출하고 도구를 실행해 응답을 스트리밍한다. 헥사고날
아키텍처로 깨끗하게 재구축(clean rebuild)된 코어.

---

## naia-agent 란?

naia-agent 는 **LLM 대화·도구 실행을 담당하는 헤드리스(GUI 없는) 처리 런타임**이다.
사용자가 직접 실행하는 앱이 아니라, **호스트(naia-os 데스크톱 셸 등)가 띄워서
gRPC 로 말을 거는 백엔드**다.

대화 한 턴의 흐름:

```
사용자 입력 ─(gRPC)→ naia-agent
                       │  1. recall   — (선택) 장기기억에서 관련 맥락 회수
                       │  2. assemble — 토큰예산 안에서 대화 조립(압축)
                       │  3. provider — LLM 호출, 텍스트·도구호출 스트림
                       │  4. tool-loop— 도구 실행 → 결과를 다시 LLM 에 전달
                       │  5. save     — (선택) 이번 턴을 장기기억에 저장
                       └─(gRPC 스트림)→ 셸이 화면에 표시
```

호스트는 **"무슨 provider 인지, 어떤 도구가 있는지" 몰라도 된다.** 메시지만 보내면
agent 가 기동 시 로딩한 설정(naia-adk 의 naia-settings)대로 알아서 처리한다.

---

## 무엇을 하나 (역량 · 상태)

| 역량 | 설명 | 상태 |
|------|------|:----:|
| **채팅 파이프라인** | provider 호출 → wire 스트림(텍스트·thinking·usage). ollama·openai 호환·게이트웨이 등 다중 provider | ✅ |
| **도구 실행 루프** | `toolUse → 실행 → 결과 스레딩 → 최종 응답`. 멀티 라운드 | ✅ |
| **agent-local 스킬** | github · obsidian · 메모 · 날씨(openmeteo) · MCP 브리지 · composite · 승인게이트(tier ask) · notify(slack/discord/google_chat) · adk-skills(SKILL.md) — 진입점 배선됨 | ✅ |
| **cron(예약) 스킬** | schedule/list/cancel 어댑터·계약테스트 존재. **진입점 미배선(dormant)** — 실 스케줄러(CronStorePort) 미주입 시 정직 unsupported. 환경(스케줄러) 신설 시 배선 | 🔜 dormant |
| **provider 출처·자격증명** | naia-settings/키체인 기반 provider·키 결정, 라이브 reload(앱 재시작 없이 모델 교체), 키는 OS 키체인(평문 미보존) | ✅ |
| **진단(Diagnostics) RPC** | provider/연결/상태 rich health 를 gRPC 로 보고 | ✅ |
| **브라우저 스킬** | cmd 화이트리스트 + 주입 CLI(navigate/click/fill) 어댑터·계약테스트 존재. **진입점 미배선(dormant)** — 환경 실행은 셸(naia-os) 사이드카 소유, agent 는 intent 만 emit(레이어 분리). 'intent→셸 사이드카' 경로 신설 시 배선 | 🔜 dormant |
| **BGM 스킬** | youtube 검색/재생/볼륨 어댑터·계약테스트 존재. **진입점 미배선(dormant)** — 브라우저 스킬과 동일(환경=셸 사이드카) | 🔜 dormant |
| **대화 토큰예산 가드** | 긴 대화를 provider 컨텍스트 예산 안으로 조립(최신 우선·오래된 것 **드롭**·tool 라운드 원자·systemPrompt 보존). ⚠️정보보존형 compaction(요약)은 naia-memory 책임 — agent 위임은 진행 예정(agent#3) | ✅(가드) |
| **장기기억·RAG 연동** | `@nextain/naia-memory` recall/save 배선 — 진입점 default-on(`NAIA_AGENT_MEMORY=off` 로 비활성), FR-MEM-1~11 계약테스트 통과(`docs/requirements.md`). 실 backend 성숙도(원격/qdrant/임베딩 품질)는 naia-memory 책임 | ✅ |
| **레퍼런스 호스트** | naia-os 임베드(✅) · CLI 호스트 · 메신저 봇 | 🔜 일부 계획 |

> ✅ = main 에 구현+계약테스트 통과 + **진입점(`scripts/builds/agent-stdio-entry.mjs`) 배선**.
> 🔜 dormant = 어댑터·계약테스트는 있으나 진입점에 미배선(설계상 환경=셸 사이드카 소유 또는 외부 store 미주입).
> 🔜 일부 계획 = 설계됐고 일부 코드 존재, 통합 진행 중.
> 정확한 추적은 `docs/progress/`(V모델 레지스트리)와 `docs/requirements.md` 참조.

---

## 생태계에서의 위치

naia-agent 는 4개 레포가 맞물린 naia 생태계의 **처리 계층**이다.

```
┌───────────────┐   gRPC    ┌───────────────┐  recall/save  ┌────────────────┐
│   naia-os     │ ────────▶ │  naia-agent   │ ────────────▶ │  naia-memory   │
│ (데스크톱 셸)  │ ◀──────── │   (이 레포)    │ ◀──────────── │  (인지 기억)    │
│  UI·음성·아바타 │  스트림    │  뇌/처리       │               │  장기기억·회상   │
└───────────────┘           └───────┬───────┘               └────────────────┘
                                    │ 설정·스킬 로딩
                                    ▼
                            ┌───────────────┐
                            │   naia-adk    │
                            │ (워크스페이스)  │  provider/모델/스킬 설정 SoT
                            └───────────────┘
```

- **naia-os** — 사용자가 보는 셸. agent 를 spawn 하고 gRPC 로 대화를 주고받는다.
- **naia-agent** (이 레포) — provider 호출·도구 실행·대화 조립을 하는 뇌.
- **naia-memory** — 장기기억. agent 가 recall(회수)/save(저장)로 연동.
- **naia-adk** — provider·모델·스킬 설정이 사는 워크스페이스. agent 가 기동 시 로딩.

**결합 방식 = 인터페이스, 런타임 의존 아님.** 레포들은 published 계약(gRPC proto,
설정 포맷)으로 맞물릴 뿐 서로의 코드를 임베드하지 않는다. agent 의 호스트는 naia-os
가 아니어도 된다(같은 gRPC 계약을 말하는 어떤 호스트든 가능).

---

## 아키텍처 한눈에

전형적 **헥사고날(ports & adapters)**. 도메인은 transport 를 모른다.

```
입력층  ports/uc1.ts (AgentIngressPort)      ← gRPC 서버가 여기로 수신
   │
처리   app/chat-turn-handler.ts             ← recall→assemble→provider→tool-loop→save
   │
출력층  AgentEgressPort                       ← text/thinking/toolUse/usage/finish emit

레이어: domain/(순수 계약) · app/(처리) · ports/(경계) · adapters/(gRPC·provider·skill·memory) · composition/(배선)
```

- **transport 직교**: `adapters/grpc/`(운영) 와 `adapters/stdio.ts`(테스트 in-process)가
  같은 Ingress/Egress 포트를 구현 → 도메인 코드 변경 없이 전송 방식 교체.
- 상세: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). 전체 사상(2축·인지 계층) SoT 는
  [`new-naia-os/docs/ARCHITECTURE.md`](../new-naia-os/docs/ARCHITECTURE.md).

---

## 빠른 시작

> **사전 요구: `naia-memory` 를 형제 디렉토리로 clone.** `package.json` 의
> `@nextain/naia-memory` 의존은 `file:../../naia-memory`(로컬 경로) 라서, agent 저장소의
> **부모 디렉토리와 같은 위치**에 `naia-memory` 가 있어야 `pnpm install` 이 성공한다.
>
> ```bash
> git clone https://github.com/nextain/new-naia-agent.git
> git clone https://github.com/nextain/naia-memory.git   # 형제로 — file:../../naia-memory 가 이걸 가리킴
> # 결과 레이아웃:  <workspace>/new-naia-agent  +  <workspace>/naia-memory
> ```

```bash
pnpm install        # 의존성 설치 (위 형제 clone 필요)
pnpm build          # tsc 빌드
pnpm test           # 단위·계약·통합 테스트 (vitest)
```

agent 는 **단독 실행보다 호스트가 spawn** 하는 게 정상 경로다. 직접 띄울 때:

```bash
pnpm start                  # = node scripts/builds/agent-stdio-entry.mjs
                            # stdout 에 `GRPC_LISTENING <addr>` 출력 → 호스트가 connect
```

> 진입점은 `scripts/builds/agent-stdio-entry.mjs` 이며 `dist/main/composition/index.js`(빌드 산출물,
> `pnpm build` 필요)를 로딩한다. 즉 `pnpm build` 를 먼저 실행해야 직접 기동된다.

기동하면 agent 는 호스트의 `SetWorkspace(adkPath)` 로 naia-adk 설정을 로딩해
provider/model 을 구성하고, `Chat(server-stream)` 으로 대화를 처리한다.

> naia-os 와 함께 쓰는 전체 데스크톱 경험은 [`new-naia-os`](../new-naia-os) README 참조.

---

## 개발 프로세스 (기여자용)

이 레포는 **계약 우선 + V모델**로 관리된다 — 코드 한 줄 전에 시나리오·요구사항·테스트가 먼저.

| 게이트 | 산출물 |
|--------|--------|
| P01 사용자 시나리오 | `docs/user-scenarios.md` UC |
| P02 테스트 시나리오 | Test Coverage Map 매핑 |
| P03 요구사항 | `docs/requirements.md` FR/NFR |
| P04 통합 테스트 | `src/test/*.contract.test.ts` |
| P05 완료 | 요구사항 상태 → Done |

추적성 레지스트리(요구사항→UC→테스트→기능→테스트, orphan 0):
`docs/progress/01.requirements ~ 05.features-tests`.

모든 AI 도구의 진입점·규칙은 **[`AGENTS.md`](AGENTS.md)** — 처음이라면 이 README 다음에 읽으세요.
빠른 첫 기여 가이드는 [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md)(15분 fast-path 포함).

---

## 프로젝트 구조

```
naia-agent/
├── AGENTS.md / CLAUDE.md / GEMINI.md / OPENCODE.md / CODEX.md   # AI 진입점(헌장) — AGENTS.md 가 SoT, 나머지는 자동 mirror
├── .agents/        # AI 컨텍스트(규칙·상태·훅) — 사람이 편집
│   └── context/    #   agents-rules.json(규칙 SoT) · process-status.json(진행) · module-manifest.json(파일단위 계약앵커)
├── .users/         # .agents/ 의 사람용 마크다운 mirror
├── src/
│   ├── main/       # 메인 소스 — domain / app / ports / adapters / composition
│   └── test/       # 계약·통합·단위 테스트
├── scripts/        # enforce-root-structure.sh(구조강제) · sync-harness-mirrors.sh(mirror 동기화) 등
└── docs/           # ARCHITECTURE · requirements · user-scenarios · progress(V모델 레지스트리)
```

구조 규칙: 새 루트 파일/폴더는 `agents-rules.json`(F12/F13)에 먼저 등록해야 한다.
미등록 시 `scripts/enforce-root-structure.sh --fix` 가 **삭제**한다.

---

## 라이선스

Apache License 2.0 — [`LICENSE`](LICENSE) 참조.
기여 가이드·행동강령·보안정책은 [`.github/`](.github/) 참조.

## 링크

- **naia-os** (셸) — `../new-naia-os`
- **naia-memory** (장기기억) — [github.com/nextain/naia-memory](https://github.com/nextain/naia-memory)
- **naia-adk** (워크스페이스) — [github.com/nextain/naia-adk](https://github.com/nextain/naia-adk)
- **Nextain** — [nextain.io](https://nextain.io)
