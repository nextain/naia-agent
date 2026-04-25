# ref-openclaw review — 2026-04-25

**Source**: https://github.com/qwibitai/nanoclaw (commit 8d85222, 2026-04-25)
**Prior analysis**: `.agents/progress/issue-186-openclaw-analysis.md`
**Prior review**: commit a81e1651, updated from 2026-04-18

## 0. Baseline 요약

Prior analysis(issue-186)는 OpenClaw 제거 및 MCP 표준 채택을 4단계로 결정. 이미 naia-os에서 Phase 1-4 완료(merge 1e049285, 2026-04-03) — 모든 참조 제거, ~/.openclaw/ → ~/.naia/ 이관, Gateway 전환 완료. Prior review(a81e1651)는 NanoClaw v2 preview(Chat SDK 15플랫폼 단일 코드) 확인했고, 우리 4-repo plan과 정렬 상태 평가.

## 1. a81e1651 → 8d85222 간 변동

**Skill 기반 MCP 통합 패턴 정착** (v2.0.11-13):
- `/add-gmail-tool` (c7f8e98, 1.1.11), `/add-gcal-tool` (6d35c85) 병합 — OneCLI vault credential stubs (`"onecli-managed"` placeholder) + gateway token 주입 모델 구현
- Stub 파일(`~/.gmail-mcp/credentials.json`) 자체는 raw tokens 없음; 모든 실제 토큰은 OneCLI gateway에서 request-time에 주입
- 각 skill은 SKILL.md 4단계 워크플로(pre-flight 검증 → Dockerfile MCP 추가 → tool allowlist 와이어링 → per-group container.json 설정)

**Engage mode + fan-out 라우팅** (16b9499, 010-engage-modes):
- `trigger_rules` + `response_scope` 제거 → `engage_mode`('pattern'|'mention'|'mention-sticky') + `engage_pattern`(regex) + `sender_scope`('all'|'known') + `ignored_message_policy`('drop'|'accumulate')로 교체
- 다중 에이전트 fan-out: 같은 메시지 → 각 wired agent 독립 평가 → 매칭 agent별로 별도 session+wake
- Accumulate: miss 시에도 context로 메시지 유지(trigger=0) — 후속 engage 시 prior chatter 포함
- 이전 review 미언급 패턴

**Channel 레지스트리 버그 수정** (fc375ca):
- Register 2버그 수정: ① legacy 필드명(trigger_rules) → 신규 필드명(engage_mode 등) 정렬 ② native platform_id(WhatsApp JID, Signal phone 등)에 `<channel>:` prefix 오류 제거
- 이는 우리 ExtensionPack의 dynamic wiring 시 관련성 있음

## 2. Baseline에 누락된 채택 후보 패턴

**OneCLI Vault 보안 모델 — 제거/추상화 미필요**:
- NanoClaw v2의 invariant: 컨테이너는 raw keys 무소유, OneCLI만 credential path
- Stub pattern(`access_token: "onecli-managed"` + `expiry_date: 99999999999999`)으로 gateway가 request-time token 교체
- 우리 Phase 2(NativeCommandExecutor) + Phase 3(MCP 브릿지)에서 같은 수준 보안 목표 가능 — gateway는 MCP 클라이언트가 아닌 Host가 관리하는 것이 차이

**Engagement 정확도 — 우리 ExtensionPack 구조에 영향**:
- `engage_pattern` (regex source)을 명시적 필드로: 설정 가능성 높음
- DM 기본값(`engage_mode='pattern'`, `engage_pattern='.'`) vs Group 기본값(`engage_mode='mention'`)의 차이 — 우리도 비슷한 기본값 제공 시 고려할 가치
- Accumulate 모드로 컨텍스트 누적 — 우리 session memory와 직접 연결 가능

**Per-agent fan-out 라우팅**:
- 같은 channel에 다중 agent wiring 시, 각각 독립 session 생성 (격리)
- 현재 우리 skill-manager는 단일 agent 기준 로드; 다중 agent scenario는 미구현 → Phase 4(ExtensionPack) 확장 시 참고 필요

## 3. 우리 작업 진척과의 정합성

**naia-agent 현 상태**:
- FileSkillLoader (SKILL.md YAML parsing) 구현 완료 — naia-adk format 파싱
- SkillDescriptor tier('T0'-'T3') 정의 완료
- 우리 skill-tool-bridge는 단일 agent tool 호출 모델; NanoClaw의 multi-agent per-channel 배포는 미구현

**naia-os 진척**:
- Phase 4 (OpenClaw 제거) 완료 (2026-04-03)
- X1 adapter 추가 (0b25697f) — @nextain/agent-providers 통합 시작
- 우리의 MCP 브릿지(Phase 3) 준비 완료, 실제 구현은 naia-agent에서 진행 중

**일관성**: prior decisions 유지, 새 결정 불필요. 다만 engage_mode + fan-out 패턴은 우리 ExtensionPack의 channel isolation 설계에 직접 반영할 가치.

## 4. R0 채택/거부/이연 권고

**채택 유지**:
- MCP 정렬 (Phase 3): NanoClaw v2의 Chat SDK 15플랫폼 + credential stub 패턴은 정확히 prior analysis의 "MCP 표준 정렬" 비전 구현. 우리 any-LLM + MCP도 동일 방향.
- Skill-based MCP 배포(SKILL.md 4단계 워크플로): 우리 naia-adk skill ecosystem과 100% 호환. Container image rebuild 자동화만 남음.

**새 채택 — engage_mode + fan-out**:
- Group isolation의 명시적 표현(engage_pattern regex + sender_scope + ignored_message_policy)
- 다중 agent per-channel wiring 지원 시 필수
- 우리 ExtensionPack의 channel config layer(EXTENSION.md)에 `engageMode`, `engagePattern`, `senderScope` 필드 추가 권고
- 현재 정적 manifest OK → Phase 4 이연 가능하나, 설계 단계부터 반영 권고

**이연 — Per-agent session fan-out 구현**:
- NanoClaw의 `findSessionForAgent(agentGroupId, mgId, threadId)` 수준 격리는 Phase 4 후기(multi-agent ExtensionPack)에 필요
- 현재는 단일 agent 가정; 아직 우리 멀티테넌시 모델 미정의

## 5. 열린 질문

1. **OneCLI Agent Vault 통합 시점**: Phase 2(자체 실행 엔진) vs Phase 3(MCP 브릿지)에서 credential stub 패턴 도입? NanoClaw는 이미 v2.0.0에서 기본 모델이므로 우리도 early adoption 권고(Phase 2 단계).

2. **Engagement 정보 저장소**: 현재 우리 skill-manager는 code-driven config(naia-adk)만 읽음. NanoClaw처럼 DB 기반 `engage_mode` 저장 + runtime 변경 지원할 것인가? 아니면 EXTENSION.md 정적 선언 유지?

3. **Chat SDK 15플랫폼 채택 수준**: Prior analysis는 "MCP 표준", NanoClaw v2는 "Chat SDK 단일 코드"로 해결. 우리가 Chat SDK 직접 통합할 것인가, 아니면 MCP로만 노출할 것인가?
