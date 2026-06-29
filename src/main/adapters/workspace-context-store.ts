// adapters/workspace-context-store — WorkspaceContextPort 구현: 워크스페이스 컨텍스트 경량 스냅샷.
//
// 설계 제약(GLM 독립리뷰): **shallow 1-depth 리스팅만** — `<adkPath>/projects/` 의 top-level **디렉터리명**만
// 수집한다(파일/dotfile 제외). 파일 내용 읽기·깊은 트리 walk 절대 금지(snapshot 덤프 방지, 상세는 read_file=S3).
// 비용: per-turn shallow readdir 1회(작은 비용 — 새 프로젝트 즉시 반영, 캐시 불요).
//
// ⚠️ 코어 순수 유지 — node:fs 직접 import 안 함. FsLike 주입(entry 가 node:fs 제공, 테스트는 fake).
//    (persona-source-store 의 PersonaFsRead 동형 — 여기선 readdirSync(withFileTypes) 추가.)
import type { WorkspaceContextPort } from "../ports/uc1.js";
import type { WorkspaceSnapshot } from "../domain/workspace-context.js";
import { PROJECT_RENDER_CAP } from "../domain/workspace-context.js";

/** 디렉터리 엔트리(node:fs Dirent 의 최소 인터페이스). isDirectory 로 디렉터리만 선별. */
export interface WorkspaceDirent {
  readonly name: string;
  isDirectory(): boolean;
}

/** projects/ 디렉터리 1-depth 나열용 최소 fs(persona-source-store PersonaFsRead 동형 + readdir). 테스트는 fake. */
export interface WorkspaceFsRead {
  existsSync(path: string): boolean;
  readdirSync(path: string, opts: { withFileTypes: true }): readonly WorkspaceDirent[];
}

/**
 * `<adkPath>/projects/` 의 top-level 디렉터리명 + cwd 를 경량 스냅샷으로 내는 WorkspaceContextPort.
 * - adkPath 빈값 = undefined 반환(워크스페이스 없음).
 * - projects/ 디렉터리 부재/읽기실패 = projects=[], projectTotal=0 으로 degrade(no-throw; cwd 는 여전히 보고).
 * - 디렉터리만 수집(파일/심링크파일 제외), dotfile(`.`으로 시작) 제외, 정렬(결정론).
 * - projectTotal = 수집된 *전체* 디렉터리 수, projects = 상위 PROJECT_RENDER_CAP 개만(렌더 토큰 bounded;
 *   도메인이 "+N more" 로 총계 표기). 파일 내용은 절대 읽지 않는다(shallow only).
 */
export function makeWorkspaceContextStore(deps: { fs: WorkspaceFsRead; adkPath: string; cwd: string }): WorkspaceContextPort {
  const { fs, adkPath, cwd } = deps;
  return {
    snapshot(): WorkspaceSnapshot | undefined {
      if (!adkPath) return undefined;
      const projectsDir = `${adkPath.replace(/[\\/]+$/, "")}/projects`;
      let names: string[] = [];
      try {
        if (fs.existsSync(projectsDir)) {
          names = fs
            .readdirSync(projectsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith("."))
            .map((e) => e.name)
            .sort();
        }
      } catch {
        names = []; // projects/ 읽기 실패 = no-throw degrade(프로젝트 0개)
      }
      return {
        cwd: cwd ?? "",
        projects: names.slice(0, PROJECT_RENDER_CAP), // 상위 cap 만 렌더(전체 수는 projectTotal)
        projectTotal: names.length,
      };
    },
  };
}
