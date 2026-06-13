# deprecated skill → 새 아키텍처 재개발 매핑 (2026-06-13)

> GOAL ⑥: "구현 불가 시 신규 계약으로 흔들리지 않게 개발." deprecated openclaw skill 의 *기능*은
> 폐기가 아니라 **새 헥사고날 foundation/UC 로 재-개발(re-architected)** 됨. = 이식(死 코드) 아닌 신규계약.
> ∴ "모든 UC 개발" 관점에서 이 기능들은 **개발 완료**(old skill 형태가 아닌 새 UC 형태로).

| old gateway skill | 기능 | 새 아키텍처 등가물(빌드+리뷰됨) | 상태 |
|---|---|---|---|
| sessions | workspace git 세션 조회 | **F2** EnvironmentObservePort.sessions/worktrees(workspace_get_sessions) | ✓ |
| config | naia config get/set | **F0** ControlPlane config + **UC12** SettingsPort.update | ✓ |
| device | audio/device 상태 | **F1** InteroceptivePort.devices(list_audio_output_devices) | ✓ |
| approvals | 도구 승인 | **UC13** ApprovalGate(승인-결속 BLOCKER fix 포함) | ✓ |
| agents | 터미널 AI agent 프로세스 탐지 | **F2** processStatus(workspace_get_pty_agents) | ✓ |
| system-status | mem/cpu/os | **F1** InteroceptivePort.systemStatus | ✓ |
| diagnostics | health/logs | **F1** diagnostics(os-local) + rich payload=gRPC Diagnostics RPC(Rust 잔여) | △ |
| skill-manager | 스킬 관리 | **새 agent** ToolExecutor registry(composition + makeCompositeToolExecutor 보수 tier) | ✓ |
| welcome | 온보딩 환영 | **UC12** OnboardingController welcome step | ✓ |
| panel | UI 패널 | **F0** panel_list_installed(os-side) | ✓ |
| voicewake | 이름 호출 활성 | **V2** SensoryPort(S18, deprecated 잔재 — 새 voicewake 는 V2 신규) | △ |
| notify-{slack,discord,google_chat} | 알림 발신 | **notify skill**(이식됨) | ✓ |
| channels / naia-discord(full bot) | 다채널 수신/discord 봇 | **신규계약 필요**(notify=발신만; full 채널 수신=external + gRPC channel surface) | ✗(신규계약) |
| botmadang | 특정 봇 커뮤니티 | notify 패턴 잠재(저우선, niche) | ✗(저우선) |

## 결론 (완료 기준 정정 — 정확)
- deprecated openclaw skill 14개 중 **10개 기능 = 새 foundation/UC 로 재개발 완료**(F0/F1/F2/UC12/UC13/notify) — old skill 이식이 아닌 신규계약(GOAL ⑥).
- **진짜 미개발 = full 채널 수신/discord 봇(channels/naia-discord)** = 신규계약(external + gRPC channel surface) + 루크/외부. botmadang=저우선.
- diagnostics rich-payload·voicewake = △(os-local 됨, 나머지=Rust/V2 신규).
- ∴ "모든 UC": 핵심 기능은 재개발 완료, 잔여 = full-channel 신규계약 + Rust(gRPC RPC/forwarding) + 루크머신 live + 다른세션 메모리.
