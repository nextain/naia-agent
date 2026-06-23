// domain/orchestration — UC-CLI sub-agent supervisor 의 **순수 semantic 타입** (계약 §헥사고날 이식, 단계 2a).
// 구 `@nextain/agent-types` 의 NaiaStreamChunk/TaskSpec/Verifier 형상을 신 arch 의 직교 원칙으로 재정의.
//
// ⚠️ semantic 전용: 여기엔 "무엇이 일어났는가"(계획·도구·텍스트·세션종료·워크스페이스변경·검증리포트)만 산다.
// "어떻게"(PID/SIGTERM/stdout chunk/exit code/git diff 포맷/runner 이름)는 **adapter 안에만**. import-boundary 강제.
// Node 의존 0. transport 0. I/O 0.

/** sub-agent 에게 줄 작업 명세 — semantic(prompt + 작업 디렉터리 + 선택 모델). 구 TaskSpec 의 최소 핵.
 *  구판의 maxTurns/timeoutMs/env/extraSystemPrompt 는 2a 비범위(메커니즘·정책) — 필요 시 후속 단계에서 추가. */
export interface TaskSpec {
  readonly prompt: string;
  readonly workdir: string;
  /** 어느 모델로 구동할지(옵셔널 힌트). 미설정 = adapter 기본. roster 선택(AC6)은 2b. */
  readonly model?: string;
}

/**
 * sub-agent 세션 동안 흐르는 semantic 이벤트(판별 union). 구 NaiaStreamChunk 의 sub-agent 관련
 * variant 만 추려 transport-중립으로 재정의 — toolUseId/elapsedMs/tier 같은 메커니즘 필드는 뺐다(2a 골격).
 * `session_end` 가 **정확히 1회**인 terminal 이벤트(adapter 계약). ok=false 면 실패/중단(supervisor 는 그래도 verify).
 */
export type SubAgentEvent =
  | { readonly kind: "planning"; readonly note?: string }
  | { readonly kind: "tool_use_start"; readonly tool: string }
  | { readonly kind: "tool_use_end"; readonly tool: string; readonly ok: boolean }
  | { readonly kind: "text_delta"; readonly text: string }
  /** terminal — 세션당 정확히 1회. ok=false = 실패/취소/비정상종료. reason = 사람이 읽는 사유(opaque). */
  | { readonly kind: "session_end"; readonly ok: boolean; readonly reason?: string };

/** 워크스페이스 변경 요약(semantic) — 구 WorkspaceChange 스트림의 *집계 스냅샷*. 어떤 파일이
 *  추가/수정/삭제됐는지 경로 + 수치만(diff 포맷·git 메커니즘은 adapter). 2c 에서 실 어댑터가 채움. */
export interface WorkspaceChange {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
}

/** 검증 결과(semantic) — 구 VerificationResult 의 정규화. `checks[].name` 은 **opaque 문자열**(runner-specific
 *  enum 아님 — "test"/"lint" 등 메커니즘 이름을 domain 이 알지 못한다). pass + 선택 details 만. */
export interface VerificationReport {
  readonly ok: boolean;
  readonly checks: readonly { readonly name: string; readonly pass: boolean; readonly details?: string }[];
}

/** supervisor 가 세션 종료 시 내는 **정직 보고**(D19 계승) — 단일 terminal 산출물.
 *  workspace 변경 수치 + 검증 리포트 + sub-agent 세션 성공 여부. 구 report/session_aggregated 의 semantic 통합. */
export interface SupervisorReport {
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
  readonly verification: VerificationReport;
  /** sub-agent session_end.ok — 검증과 **독립**(세션 실패해도 verify 는 돈다, AC4). */
  readonly sessionOk: boolean;
}

/** 검증 미수행(verifier 미주입) 시의 중립 리포트 — ok=true(검증을 안 했을 뿐 실패 아님), checks 빈 배열. 순수. */
export function emptyVerification(): VerificationReport {
  return { ok: true, checks: [] };
}

/** 빈 워크스페이스 변경(workspace 포트 미주입 시 기본). 순수. */
export function emptyWorkspaceChange(): WorkspaceChange {
  return { added: [], modified: [], deleted: [] };
}

/**
 * latest(작업 종료 시점) 에서 baseline(작업 시작 시점에 이미 dirty 였던 상태)에 있던 (category,path)를 뺀,
 * **sub-agent 가 유발한 순수 변경**. 정직보고 — 작업 전부터 dirty 였던 파일을 "바꿈"으로 세지 않는다(재감사 2026-06-23 P2).
 * per-category 집합 차(예: 시작 시 modified 였다가 작업이 삭제하면 latest.deleted\baseline.deleted 로 deleted 집계).
 * baseline 미정(감시 시작 스냅샷 없음) = latest 그대로. 순수.
 *
 * ⚠️ **best-effort 한계(codex 재감사 2026-06-23)** — over-count(기존 dirty) 는 막지만 완벽한 인과 회계는 아니다:
 *   (1) baseline = 감시 첫 폴 스냅샷이라, 폴 간격보다 빨리 끝난 sub-agent 변경이 baseline 에 섞이면 under-count.
 *   (2) path+category granularity — 시작 시 modified 였던 파일을 sub-agent 가 *다시* 수정하면 둘 다 modified 라 0 으로 빠짐.
 *   정확한 변경 검증이 필요하면 content/hash baseline 또는 --check(verifier) 사용. 이 함수는 path 수준 근사.
 */
export function diffWorkspaceChange(latest: WorkspaceChange, baseline: WorkspaceChange | undefined): WorkspaceChange {
  if (!baseline) return latest;
  const minus = (cur: readonly string[], base: readonly string[]): string[] => {
    const baseSet = new Set(base);
    return cur.filter((p) => !baseSet.has(p));
  };
  return {
    added: minus(latest.added, baseline.added),
    modified: minus(latest.modified, baseline.modified),
    deleted: minus(latest.deleted, baseline.deleted),
  };
}
