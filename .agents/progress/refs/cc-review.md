# ref-cc review — 2026-04-25

**Sources**:
- private analysis: `nextain/ref-cc` (analysis-report.md 등 4개 docs, 2026-04 분석 시점, 원본 source 1,884 files 유실)
- public cleanroom: `ghuntley/claude-code-source-code-deobfuscation` (2025-03, claude-code 0.2.x 시절 cleanroom, 55 files / 476KB)

**Note on freshness**: 분석은 2026-04(최신, 1.x~2.x), cleanroom은 2025-03(약 13개월 전, 0.2.x). 신규 모듈은 분석 우선, 핵심 아키텍처는 둘 다 일치하는 부분만 안전 채택. cleanroom은 **기초 구현 reference** 역할.

## 1. 무엇인가

Claude Code = Anthropic 공식 CLI 에이전트 (Node.js + TypeScript). 대화 루프 → tool 실행 → 자동 compaction → 멀티 워커 조정. 우리 4-repo 허브 런타임(`naia-agent`)의 **핵심 architecture reference**. R0 설계 재점검에서 명시적으로 우선순위 매트릭스에 없었던 결정을 정식화하는 첫 리뷰.

## 2. 분석 vs cleanroom 일치 (안전한 채택 후보)

| 패턴 | 분석 구현 | Cleanroom 구현 | 채택 가능 |
|---|---|---|---|
| AI Client 계약 | Message[], system, streaming | Message[], CompletionRequest | ✓ |
| Auth 프레임워크 | OAuth + token refresh + auto-renew | AuthManager + EventEmitter | ✓ |
| Execution sandbox | dangerous command filter (rm -rf, fork bomb) | exec/spawn wrapper | ✓ |
| 명령어 레지스트리 | CommandRegistry(name, description, execute) | commandRegistry.get/list/getCategories | ✓ |
| 에러 타입 | ErrorCategory (FS/Auth/API/Network/User) | ErrorCategory enum + UserError | ✓ |

## 3. 분석에만 있는 신규 (cleanroom 1년 후 추가된 핵심 기능)

| 패턴 | 중요도 | 우리 도입 |
|---|---|---|
| Tool 메타데이터 (`isConcurrencySafe`, `isDestructive`, `searchHint`) | P0 | 필수 |
| Context Window 3중 방어 (auto-compact + reactive + snip) | P0 | 필수 (long session) |
| Task 프레임워크 (7가지 TaskType, 5가지 Status, 디스크 출력, eviction) | P0 | 필수 |
| Hook 시스템 (28 이벤트, 5 훅 타입) | P1 | 다음 스프린트 |
| Agent Coordinator (중앙 + 다중 워커 + Scratchpad 공유) | P1 | Q3 |

## 4. Cleanroom 디렉터리 구조 — 우리에게 의미

- **ai/**: AIClient (Message[], CompletionOptions). 우리 LLMClient가 더 상세 — **채택도 낮음**
- **auth/**: AuthManager (OAuth + token refresh timer + EventEmitter). 우리 HostContext.identity는 정적 → **이 패턴 차용 가치** (P1, daemon용)
- **execution/**: ExecutionEnvironment + DANGEROUS_COMMANDS regex. 우리 ToolExecutor 보안 필터 약함 → **직접 차용** (P0)
- **fileops/ + fs/**: path normalization, directory traversal 방지. **native 라이브러리로 전개 권장** (skill 오버헤드 회피, P0 보안)
- **terminal/**: TUI (색상, 포맷팅). 우리는 Tauri shell 책임 → **0**
- **telemetry/**: 기초 enum만. 우리 Logger/Tracer/Meter가 더 진전 → **낮음**
- **commands/**: CommandRegistry + 카테고리 + availability 필터. 우리 slash command 평탁 → **차용 (P1)**

## 5. 차용 가능한 패턴 후보 (5개 명시)

### adopt-cc-01: Execution 보안 필터 (P0-fast-track)
**출처**: cleanroom/src/execution/index.ts
```typescript
const DANGEROUS_COMMANDS = [
  /^\s*rm\s+(-rf?|--recursive)\s+[\/~]/i,
  /^\s*dd\s+.*of=\/dev\/(disk|hd|sd)/i,
  /^\s*mkfs/i,
  /^\s*:\(\)\{\s*:\|:\s*&\s*\}\s*;/,  // fork bomb
  /^\s*>(\/dev\/sd|\/dev\/hd)/,
  /^\s*sudo\s+.*(rm|mkfs|dd|chmod|chown)/i
];
```
**공수**: S (1시간). **즉시 가능**.

### adopt-cc-02: AuthManager 이벤트 기반 토큰 갱신 (P1)
**출처**: cleanroom/src/auth/manager.ts:27-62
EventEmitter (auth:state_changed, auth:token_refreshed) + refreshTimer with `tokenRefreshThreshold` (5분 before expiry) + `maxRetryAttempts`. **공수**: M (1-2일).

### adopt-cc-03: Path Normalization (P0)
**출처**: cleanroom/src/fileops/index.ts
```typescript
const normalizedPath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
return path.resolve(this.workspacePath, normalizedPath);
```
모든 readFile/writeFile 경로 정규화. **공수**: S (30분).

### adopt-cc-04: Command Registry 계층 (P1)
**출처**: cleanroom/src/commands/index.ts:658
- `command.category` (Code, Config, Debug)
- `command.availability: ['claude-ai']` (구독자별 필터)
- `command.hidden` (internal-only)
**공수**: M (1-2일).

### adopt-cc-05: Error Category Discriminated Union (P2)
**출처**: cleanroom/src/errors/types.ts
ErrorCategory enum + UserError discriminated union (category, resolution, cause). **공수**: S (6시간).

## 6. 명시적으로 채택 안 할 것

- **TUI 직접** (cleanroom terminal/): 우리는 embeddable runtime + Tauri/CLI host 분리. Terminal은 host 책임
- **`/bug`, `/feedback`, `/install-github-app`** 등 Anthropic SaaS 특화: 우리는 self-hosted Naia OS
- **Telemetry (Sentry-style)**: cleanroom telemetry는 기초 event enum만. 우리 Observability 야망(Logger/Tracer/Meter + ModelCosts tracking)이 더 상세

## 7. 이미 우리에 반영된 부분

`naia-os-adoption.yaml` (private ref-cc) 의 P0 항목들:
- **adopt-01** Tool 메타데이터: 분석 출처. cleanroom에 없음 → 우리가 먼저 정의
- **adopt-02** Context Window: 분석 출처. cleanroom에 없음 → 우리가 먼저 설계
- **adopt-03** Task 프레임워크: 분석 출처. cleanroom에 없음 → 우리가 먼저 설계

**결론**: adoption.yaml의 P0 항목은 cleanroom과 무관하게 R0에서 이미 설정됨. cleanroom은 **보조 검증 역할**만.

## 8. R0 채택/거부/이연 권고

| 항목 | 상태 | 근거 |
|---|---|---|
| DANGEROUS_COMMANDS regex | 채택 (P0-fast) | 보안 강화, 즉시 가능 |
| Path 정규화 | 채택 (P0) | 보안, 30분 |
| AuthManager 이벤트 | 이연 (P1) | daemon용, 우선순위 낮음 |
| Command Registry 카테고리 | 이연 (P1) | 명령어 < 50개라 미루기 |
| ErrorCategory enum | 이연 (P2) | nice-to-have, Logger 충분 |
| 28-event Hook 시스템 | 거부 → 분석 우선 | cleanroom에 없음, 분석 28-event 시스템 채택 |
| Tool 메타데이터/Context Window/Task | 이미 채택 | adoption.yaml에서 정의됨 |

## 9. 열린 질문

- **Cleanroom은 정말 0.2.x?** — 2025-03 commit 기준 추정. 우리 분석은 1.x~2.x. 1년 gap의 주요 변경 확인하려면 npm 1.0.x 시절 번들 역공학 필요 (본 리뷰는 이미 충분, 권고 안 함)
- **Tool 메타데이터(isConcurrencySafe)**: cleanroom에 없는데 분석엔 있음. 분석이 1년 신규 기능 캡처 → 우리가 먼저 도입해도 무방

## 10. 재추출 권고 (선택)

본 리뷰는 cleanroom + 분석 + adoption.yaml로 충분히 진행 가능. 향후 옵션:
- npm 1.0.128 등 옛 JS 번들 시절 역공학 시도 — 기초 패턴 재확인 (지금 불필요)
- Claude Code 공식 docs (docs.anthropic.com) — spec 참고 (시간 있을 때)

---

**최종 권고**:
- **P0-fast-track (이번 주)**: DANGEROUS_COMMANDS regex + Path normalization 이식
- **P0 (Q2)**: adopt-01/02/03 (Tool metadata, Context Window, Task) 실행 (adoption.yaml 따르기)
- **P1 (Q3)**: AuthManager 이벤트 + Command Registry 카테고리 + 28-event Hook
- **P2**: ErrorCategory enum (nice-to-have)
