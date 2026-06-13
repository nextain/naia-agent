// adapters — workspace 경로 → 안정적 격리 키 유도(순수 함수, fs realpath 는 주입). 진입점이 사용하며
// 단위 테스트 가능(.mjs 진입점 인라인 로직의 회귀를 P04 가 탐지하도록 추출). FR-MEM-9 격리 로직의 SoT.
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** project → store 디렉터리 조각(고정 안전 hex). 사용자 지정 project 에 `../`·경로 구분자가 있어도
 *  traversal/충돌 없이 안전(파일 분리는 해시 키로, backend scope 는 원 project 로). */
export function storeDirKey(project: string): string {
  return createHash("sha256").update(String(project)).digest("hex").slice(0, 32);
}

export interface WorkspaceIdDeps {
  /** 파일 읽기 — 없으면 `.code === "ENOENT"` 인 Error throw, 다른 오류는 그 code 보존. */
  readFile(path: string): string;
  /** 배타 생성(`wx`) — 이미 있으면 `.code === "EEXIST"` throw(경쟁 감지용). */
  writeFileExclusive(path: string, data: string): void;
  mkdir(path: string): void; // recursive
  /** workspace root 가 실재하는 디렉터리인가 — 잘못된 NAIA_ADK_PATH 에 새 workspace 를 만드는 것 방지. */
  isDirectory(path: string): boolean;
  randomUUID(): string;
}

const VALID_WS_ID = /^[0-9a-fA-F-]{16,64}$/;

/** workspace identity = **워크스페이스에 영속 저장된 UUID**(`<adkPath>/.naia/workspace-id`). 경로 해시
 *  대신 쓰는 이유: (1) 워크스페이스 *이동/이름변경* 시 UUID 가 따라가 기억 연속성 유지, (2) 같은 경로에
 *  *새* 워크스페이스가 생기면 UUID 가 달라(없으면 새 발급) 이전 워크스페이스 기억 누설 차단(경로 재사용 leak).
 *  **원자성/내구성(fail-closed)**: ENOENT 만 발급 대상으로 인정 — invalid 파일·비-ENOENT read 오류(EACCES/
 *  corruption)는 **throw(fail-closed)** 해 잘못된 identity 로 회전·누설하지 않는다(호출부가 memory 비활성).
 *  발급은 **배타 생성(`wx`)** — 동시 부팅 경쟁 시 EEXIST 면 winner 를 재조회(둘이 다른 UUID 쓰는 것 방지).
 *  ⚠️ **한계(clone 미구분)**: id 파일이 *복제*(템플릿/백업복원/cp -r)되면 move 와 구분 불가 → 두 워크스페이스가
 *  같은 identity 공유(교차누설). 진짜 clone 격리는 OS 관리 레지스트리 필요(미래). 완화=`.naia/workspace-id`
 *  를 VCS/템플릿 복사에서 제외(gitignore). */
export function resolveWorkspaceId(adkPath: string, deps: WorkspaceIdDeps): string {
  const abs = resolve(adkPath);
  const dir = `${abs}/.naia`;
  const idFile = `${dir}/workspace-id`;
  const readValid = (): string => {
    const v = deps.readFile(idFile).trim(); // read 오류는 그대로 throw(상위 fail-closed)
    if (!VALID_WS_ID.test(v)) throw new Error("invalid workspace-id (fail-closed, 회전 금지)");
    return v;
  };
  try {
    return `ws-${readValid()}`;
  } catch (e: unknown) {
    if (!(e && typeof e === "object" && (e as { code?: string }).code === "ENOENT")) {
      throw e; // invalid 파일 / 비-ENOENT read 오류 → fail-closed(회전·누설 방지)
    }
  }
  // ENOENT(id 파일 없음) → 발급. 단 **workspace root 가 실재 디렉터리일 때만** — 잘못된 NAIA_ADK_PATH 가
  // 새 workspace 로 조용히 생성돼 기억이 단절·분기되는 것 방지(config 오류 fail-closed).
  if (!deps.isDirectory(abs)) throw new Error(`workspace root 없음(config 오류, fail-closed): ${abs}`);
  // 배타 생성(경쟁 안전).
  const id = deps.randomUUID();
  deps.mkdir(dir);
  try {
    deps.writeFileExclusive(idFile, id);
    return `ws-${id}`;
  } catch (e: unknown) {
    if (e && typeof e === "object" && (e as { code?: string }).code === "EEXIST") {
      return `ws-${readValid()}`; // 경쟁 — 다른 프로세스가 먼저 씀 → winner 재조회
    }
    throw e; // 쓰기 실패 → fail-closed
  }
}
