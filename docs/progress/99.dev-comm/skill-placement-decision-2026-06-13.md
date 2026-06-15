# 남은 built-in skill placement 결정 (2026-06-13) — "흔들리지 않게" (GOAL ⑥)

session_id: ec74cc29-3347-4f6e-b29a-237ea29f301e

> 잔여 old built-in skill 12개의 이식 여부/위치를 *blind 이식 금지*(wrong-placement·dead-code=drift) 원칙으로 판정.
> 근거: 새 agent skill 모델 = **ToolExecutorPort(injected dep)**. openclaw `ctx.gateway`(skill 실행 게이트웨이)는 **#201로 제거**(canon) — 새 agent 에 `ctx.gateway` 0건 확인. = gateway-coupled skill 은 새 아키텍처에 의존처가 없음.

## 분류 (old skills/built-in 기준)
| skill | old 호출 | 판정 | 사유 |
|---|---|---|---|
| sessions·skill-manager·config·device·channels·agents·approvals | `ctx.gateway` | **DEPRECATED(미이식)** | openclaw gateway(#201 제거) coupled = 새 arch서 死. 이식=dead-code drift(금지). 필요 기능은 신규 UC로 재설계해야(예: sessions=os workspace_get_sessions=F2 에 이미). |
| naia-discord (472줄) | `ctx.gateway`+Discord | **DEPRECATED(미이식)** | openclaw discord 채널 통합. 새 arch=별도 채널 신규계약 필요(이식 아님). |
| voicewake·welcome | OpenClaw 잔재 | **DEPRECATED(미이식)** | OpenClaw 잔재·미검증(F1 scouting 확인). dead code. |
| panel | `readFile`(UI 패널) | **OS-SIDE(미이식 to agent)** | 패널=os shell UI 영역. agent skill 아님. os-side 처리(이미 F0 panel_list_installed 등). |
| botmadang (114줄) | `fetch` (외부 API) | **AGENT-ELIGIBLE(저우선)** | 외부 API(gateway 무관, notify 패턴). 단 niche(특정 봇 커뮤니티 등록). 우선순위 낮음 — 필요 시 notify 패턴으로 이식. |

## 결정 (campaign 완료 기준 정정)
- **이식 완료 = clean agent-local skill 9개**(github/mcp/obsidian/weather/memo·bgm·browser·notify·cron) — UC5/UC6/UC8.
- **이식 안 함(정당)**: gateway-coupled 9개 + OpenClaw 잔재 2개 = **deprecated(새 arch서 死, #201)**. "모든 UC" 의 "UC" 에 *제거된 openclaw 기능* 은 포함 안 됨(superseded). 이식 시 drift.
- **os-side**: panel.
- **잠재 신규(저우선)**: botmadang(notify 패턴).
- = 잔여 12 skill 중 **이식 대상은 사실상 0~1(botmadang)**. 나머지는 deprecated/os-side 로 **정당하게 미이식**(흔들리지 않게 — 死 코드 이식 금지).

## 남은 진짜 작업 (skill 외)
1. gRPC Voice RPC(V2 음성)·Diagnostics RPC(F1 rich health) — cross-repo(os Rust prost) 신규계약.
2. UC3 메모리 = 다른 세션.
3. 전 UC live-graft + e2e = 루크 머신.
