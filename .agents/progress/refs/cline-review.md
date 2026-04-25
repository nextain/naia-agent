# ref-cline review — 2026-04-25

**Source**: https://github.com/cline/cline (commit 901d1b5c9, v2.17.0-cli-2)
**Updated from**: prior review at commit 10af2439b (8일치 변동 §0 반영)

## 0. 이전 리뷰 대비 변동

8일간 21개 commit. 핵심 변동 4건:

1. **feat(memory-observability)** (70f0e8d54): 5분 주기 `[MEMORY]` 마커 로깅 + V8 heapsnapshot 추적
2. **fix(hooks)** (901d1b5c9): Bash/PowerShell hook template JSON literal escape 강화
3. **모델 추가**: GPT-5.4/5.4-nano/5.5, SAP AI Core 통합 개선
4. **보안**: protobufjs CVE-2026-41242 pinning

**구조·핵심 패턴 변동 없음** — extension-webview gRPC, HostProvider 싱글톤 DI, 파일 기반 상태 저장소 유지. 메모리 관찰성은 순수 additive.

## 1. 무엇인가 / 무엇이 아닌가

여전히 VS Code IDE plugin (3.81.0). Claude Sonnet 백엔드 + agentic coding assistant. 파일 편집/셸/브라우저/MCP 도구를 권한 승인 하에 수행. **IDE webview UI, VS Code host API에 깊게 결합**. 우리 embeddable runtime과는 범위 직교.

## 2. 차용 가능한 패턴 후보

- **Memory observability** (70f0e8d54): 5분 주기 로깅(`unref()` 타이머) + graceful shutdown 시 최종 스냅샷. 우리 compaction policy와 조합 가능 — 메모리 pressure 감지 시 automatic truncation trigger.
- **Hook 쉘 escape**: JSON literal을 Bash 문자열로 전달 시 이중 escape (`'${var}'` vs `"${var}"`). 우리 stdio/gRPC hook 설계 시 참고.
- **Proto enum multi-location 매핑** (이전 리뷰 유지): 새 모델 추가 시 enum + proto-conversion 양방향 검증. SAP AI Core 추가 시도 동일 패턴.
- **HostProvider 싱글톤 DI** (이전 리뷰 유지): `HostProvider.initialize()` → `HostProvider.get()` 명확한 초기화 ordering. 우리 HostContext 설계 영감.

## 3. 명시적으로 채택 안 할 이유

- **IDE plugin 결합**: VS Code webview, terminal manager, comment review controller. Embeddable runtime은 host 추상화만 필요.
- **Webview-centric UI loop**: 우리는 shell-agnostic.
- **OpenTelemetry + PostHog 포함**: src/services/telemetry/, feature-flags 존재. 우리는 zero-runtime-dep 원칙 유지.
- **Approval UI를 host에 위임**: Cline은 approval UI를 extension 내에 두고 tool execution을 host에 위임. 우리는 execution을 ToolExecutor로 추상화하되 approval **정책**은 runtime 소유 (plan A.6).
- **Foreground terminal 제거** (1862f1595): VS Code extension에서 foreground terminal 제거. 우리 standalone runtime과 무관.

## 4. 이미 우리에 반영된 부분

- **HostProvider DI 싱글톤 영향**: 우리 HostContext 설계와 유사 패턴.
- **파일 기반 상태 마이그레이션**: `~/.cline/data/` 전환(exportVSCodeStorageToSharedFiles 패턴)은 우리 멀티플랫폼 설계 선례.
- **Task streaming + approval flow**: ToolExecutor + permission handler callback이 우리 GatedToolExecutor와 유사 (D5).

## 5. R0 채택/거부/이연 권고

- **채택**: 메모리 모니터링 패턴 (5분 주기 + unref() 타이머) — compaction trigger or observability를 위해 `.agents/progress/` 로그에 적용 검토
- **이연**: Hook 쉘 escape 세부 — 우리 hook 설계 확정 후(A.5 이후) script template 예제에 반영
- **거부**: OpenTelemetry, IDE plugin 기능, Webview 우선 패턴

## 6. 열린 질문

- Memory 로깅(`[MEMORY]` 마커)을 naia-agent progress log에 포함할 때 성능 임계값(예: RSS > 1GB) 설정 필요?
- Hook의 JSON escape 규칙이 우리 planned shell-agnostic hook executor(A.5)에 필요한가, 아니면 proto RPC로 충분한가?
