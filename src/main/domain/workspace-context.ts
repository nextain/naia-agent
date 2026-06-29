// domain — 워크스페이스 컨텍스트(cwd + 프로젝트 목록) → system prompt 줄 합성(순수, 외부 의존 없음).
//
// 설계 제약(GLM 독립리뷰): **snapshot(전량덤프) 금지 → 경량 shallow 리스팅만**. 여기서 다루는 입력은
// 프로젝트 *이름*(디렉터리명 1-depth) + cwd 뿐 — 파일 내용/깊은 walk 는 절대 포함하지 않는다(상세는 read_file
// 도구=S3 몫). 렌더는 토큰 bounded: 프로젝트 목록은 PROJECT_RENDER_CAP 개까지만 표기하고 초과분은 "+N more"로
// 총계만 보인다(수백 토큰 상한). 프로젝트 이름은 **데이터로 렌더**(프롬프트 지시문처럼 해석되지 않게 단순 목록).

/**
 * 워크스페이스 스냅샷 — 어댑터(workspace-context-store)가 1-depth shallow readdir 로 수집한 경량 입력.
 * - cwd: 현재 작업 디렉터리(에이전트 프로세스의 process.cwd()).
 * - projects: `<adkPath>/projects/` 의 top-level 디렉터리명(정렬). **cap 적용된** 상위 목록(전량 아님).
 * - projectTotal: cap 과 무관한 *전체* 프로젝트 수(렌더가 "+N more" 를 계산하는 근거).
 * ⚠️ 파일 내용·깊은 트리 없음(스냅샷 덤프 방지) — 이름 + cwd 만.
 */
export interface WorkspaceSnapshot {
  readonly cwd: string;
  readonly projects: readonly string[];
  readonly projectTotal: number;
}

/** 프롬프트에 나열할 프로젝트 이름 최대 개수. 초과분은 "+N more" 총계로만(토큰 bounded). */
export const PROJECT_RENDER_CAP = 40;

/** 프로젝트 이름 새니타이즈 후 최대 길이(악성/비정상 디렉터리명이 프롬프트를 잠식 못 하게 — 정상명은 무손실). */
export const PROJECT_NAME_CAP = 64;

/**
 * 프로젝트 이름 새니타이즈(C2 인젝션 차단, domain 순수) — 디렉터리명은 *데이터*(목록 항목)이지 지시문이 아니다.
 * 개행/제어문자를 제거(개행 포함 악성 디렉터리명이 "IMPORTANT: ignore persona" 처럼 system prompt 에 지시
 * 줄로 삽입되는 것 차단)하고 길이 cap. 콤마는 디렉터리명에 정상이라 보존(목록 구분자와 충돌해도 데이터일 뿐).
 * 정상 이름(영문/한글/숫자/하이픈/언더스코어/점 등)은 무손실 통과(새니타이즈가 정상명을 망가뜨리지 않음).
 */
function sanitizeProjectName(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    // 제어문자(개행·탭·CR 포함, U+0000~001F · U+007F~009F) 제거 — 한 줄 강제.
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    out += ch;
  }
  return out.length > PROJECT_NAME_CAP ? out.slice(0, PROJECT_NAME_CAP) : out;
}

/**
 * WorkspaceSnapshot → 워크스페이스 컨텍스트 줄(순수). persona 조립 **뒤에 append** 되는 경량 블록.
 *
 * 렌더 규칙(토큰 bounded):
 *  - cwd 도 projects 도 없으면 "" 반환(append 할 컨텍스트 없음 = 무영향).
 *  - cwd 만 있으면 cwd 줄만(프로젝트 0개 워크스페이스).
 *  - projects 가 있으면 "Projects (<projectTotal>): a, b, c[, +N more]" 한 줄(이름은 데이터).
 *  - 항상 "상세는 read_file 도구로(S3)" 안내 한 줄(S2 는 이름만, 내용 retrieval 은 도구 몫).
 *
 * ⚠️ snap.projects 는 이미 어댑터가 cap 을 적용한 상위 목록이지만, 도메인도 방어적으로 cap 을 재적용한다
 *    (어댑터 무관 토큰 bounded 보장). projectTotal > 표기 개수면 "+N more".
 */
export function composeWorkspaceContext(snap: WorkspaceSnapshot): string {
  const cwd = (snap.cwd ?? "").trim();
  const all = snap.projects ?? [];
  const total = snap.projectTotal ?? all.length;

  const lines: string[] = [];
  if (cwd) lines.push(`Current dir: ${cwd}`);

  if (all.length > 0) {
    // 각 이름 새니타이즈(C2 인젝션 차단) 후 cap 까지만 나열 — 악성 디렉터리명이 지시문으로 삽입되지 않게.
    const shown = all.slice(0, PROJECT_RENDER_CAP).map(sanitizeProjectName);
    const more = total - shown.length;
    const list = shown.join(", ") + (more > 0 ? `, +${more} more` : "");
    lines.push(`Projects (${total}): ${list}`);
    // S2 = 이름만(경량). 파일 내용/상세 retrieval 은 read_file 도구(S3) 몫임을 명시.
    lines.push("(Project details: use the read_file tool — names only here.)");
  }

  if (lines.length === 0) return "";
  return `## Workspace\n${lines.join("\n")}`;
}
