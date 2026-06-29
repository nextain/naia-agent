// domain/fs-sandbox — UC-FS-TOOLS 보안계약의 **순수** 경로 정책(무 I/O). C3 + GLM 독립리뷰.
//
// 이 모듈은 *문자열만* 본다(파일시스템 접근 0 — realpath I/O 는 어댑터가 수행 후 이 함수를 **재호출**).
// 책임: (1) allow-root 컨테인먼트(정규화 후 prefix) (2) 경로 탈출 차단(`..`/드라이브절대/env확장/널바이트)
//   (3) 민감경로 denylist(allow-root 안이라도 거부 — `.keys` read 한 번도 치명, GLM). cross-platform.
//
// ⚠️ 코어 순수 — node:path 도 import 안 함(domain 불변, import-boundary). 경로 정규화/구분자 처리는
//   순수 문자열 로직으로 직접 구현(POSIX `/` 정규형). 대소문자/구분자 정규화 후 denylist 매칭.

/** 경로 검증 결과 — ok 면 정규화된(POSIX `/`, 절대) 경로, 아니면 거부 사유. */
export type PathValidation =
  | { readonly ok: true; readonly normalized: string }
  | { readonly ok: false; readonly reason: string };

export interface SandboxPolicy {
  /** 허용 루트들(절대경로). 정규화된 경로가 이 중 하나의 *하위*(또는 동일)여야 통과. 비면 전부 거부. */
  readonly allowRoots: readonly string[];
}

// ── 민감경로 denylist(allow-root 안이라도 거부) ──
// 정규화된(소문자 + POSIX `/`) 경로의 **세그먼트/접미사** 로 매칭. 키·시크릿·개인정보·VCS 내부.
// `.keys` 유출은 read_file 한 번으로도 치명(GLM) → read 도 거부. 매칭은 정규화 후(대소문자/구분자 무관).
//
// ⚠️ 이름기반 denylist = **defense-in-depth(보장 아님)**. 실 secret 이 비표준 이름(예: `prod.txt`,
//   `cfg.json` 안의 토큰)으로 저장돼 있으면 통과할 수 있다 — 근본 방어는 allow-root 최소화(워크스페이스만)
//   + opt-in(기본 off) + 승인 게이트. 아래 목록은 *알려진* 민감 패턴을 추가로 차단하는 보강일 뿐이다.

/** 경로 어디든 이 **세그먼트**(디렉터리/파일명)가 있으면 거부. */
const DENY_SEGMENTS: readonly string[] = [
  ".keys",          // naia-settings/.keys (DPAPI 키체인)
  ".ssh",           // SSH 키 디렉터리
  ".git",           // VCS 내부(.git/config 토큰, objects)
  "data-private",   // T3 보안(키/시크릿/개인정보)
  "data-business",  // T3 보안(사업 기밀)
  ".env",           // .env 디렉터리(드묾) — 파일은 아래 접미사/이름 매칭
  "secret",         // secret/ 디렉터리(일반 시크릿 저장소)
  "secrets",        // secrets/ 디렉터리
  ".gnupg",         // GnuPG 홈(개인키·신뢰DB)
  ".password-store", // pass(1) 암호 저장소
];

/** 경로 마지막 세그먼트(파일명)가 이것이면 거부(정확 일치). */
const DENY_FILENAMES: readonly string[] = [
  ".env",
  ".npmrc",         // npm 토큰
  ".netrc",         // 자격증명
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  ".pgpass",
  "credentials",    // aws/gcloud credentials(확장자 없는 것)
  "authorized_keys", // SSH 허용키
  "known_hosts",    // SSH known_hosts
  "service-account.json", // GCP 서비스계정 키
  ".git-credentials", // git 평문 자격증명 저장
  "gha-creds",      // GitHub Actions creds(WIF 토큰 등)
  "wif-config.json", // Workload Identity Federation 구성
];

/** 파일명이 이 접미사로 끝나면 거부. */
const DENY_SUFFIXES: readonly string[] = [
  ".dpapi",        // Windows DPAPI 키체인 파일
  ".pem",          // 사설키/인증서
  ".key",          // 사설키
  ".p12",
  ".pfx",          // 코드서명/인증서
  ".keystore",
  ".jks",
  ".age",          // age 암호화 키
  ".gpg",
  ".asc",          // PGP 키
];

/** 파일명이 이 prefix 로 시작하면 거부(.env / .env.local / .env.production 등). */
const DENY_FILENAME_PREFIXES: readonly string[] = [
  ".env.",         // .env.* (.env 자체는 DENY_FILENAMES)
  "id_rsa",        // id_rsa, id_rsa.pub
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
];

/** 정규화된(소문자/POSIX) 경로 어디든 이 부분문자열이 있으면 거부(브라우저 프로필·토큰 저장소). */
const DENY_SUBSTRINGS: readonly string[] = [
  "/login data",          // 브라우저 저장 비번
  "/cookies",             // 브라우저 쿠키
  "/.config/gcloud",      // gcloud 자격증명 저장소
  "/.aws/",               // aws 자격증명
  "/.docker/config",      // docker 레지스트리 토큰
  "/.kube/config",        // kube 자격증명
  "/serviceaccount",      // (k8s/GCP) serviceaccount 토큰 마운트/디렉터리
  "-key.json",            // *-key.json (GCP/서비스 키 관용 이름)
  "service-account",      // service-account 포함 파일/경로(키·json)
];

/** Windows 드라이브 절대경로(C:\ · D:/ 등) 또는 UNC(\\server) — 정규화 *전* raw 검사용. */
const DRIVE_ABS = /^[A-Za-z]:[\\/]/;
const UNC_ABS = /^[\\/]{2}/;
/** env 확장 토큰: %VAR% · $VAR · ${VAR}. 정규화 *전* raw 검사(확장은 셸/실행기 책임 — 코어가 미리 차단). */
const ENV_EXPANSION = /%[^%]*%|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/;

/** 구분자 정규화(역슬래시→슬래시) + 중복 슬래시 collapse + 후행 슬래시 제거. 절대성/대소문자는 유지. */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

/** allow-root 정규화 — 절대경로 가정(어댑터가 절대 adkPath 주입). POSIX 형 + 후행 슬래시 제거. */
function normRoot(root: string): string {
  return toPosix(root);
}

/** a 가 b(루트)와 동일하거나 그 하위인가(POSIX, 대소문자 보존 — Windows 는 대소문자 무관이나 보수적으로
 *  소문자 비교를 별도 수행). 세그먼트 경계 강제( `/root` 가 `/rootx` 를 포함으로 오인하지 않게). */
function isWithin(child: string, root: string): boolean {
  if (root === "") return false; // 빈 루트 = 매칭 안 함(빈 allowRoots 전부 거부와 일관)
  if (child === root) return true;
  return child.startsWith(root.endsWith("/") ? root : root + "/");
}

/** 경로 세그먼트 배열(빈 세그먼트 제거). 정규화된 POSIX 경로 기준. */
function segments(posixPath: string): string[] {
  return posixPath.split("/").filter((s) => s.length > 0);
}

/** 정규화된 경로가 민감경로(denylist)인가. 정규화는 **소문자**로(대소문자 무관 매칭). */
export function isSensitivePath(normalizedPath: string): boolean {
  const lower = toPosix(normalizedPath).toLowerCase();
  const segs = segments(lower);
  const filename = segs.length > 0 ? segs[segs.length - 1] : "";

  for (const seg of DENY_SEGMENTS) if (segs.includes(seg)) return true;
  if (DENY_FILENAMES.includes(filename)) return true;
  for (const suf of DENY_SUFFIXES) if (filename.endsWith(suf)) return true;
  for (const pre of DENY_FILENAME_PREFIXES) if (filename.startsWith(pre)) return true;
  for (const sub of DENY_SUBSTRINGS) if (lower.includes(sub)) return true;
  return false;
}

/**
 * 순수 경로 정책 검증. rawPath(에이전트 인자) → allow-root 컨테인먼트 + 탈출 차단 + denylist.
 *
 * 단계(순서 중요):
 *  1. 타입/널바이트 거부.
 *  2. env 확장 토큰(%X%/$X/${X}) 거부 — raw 단계(확장 전에).
 *  3. 드라이브 절대(C:\)·UNC(\\) 거부 — allow-root 가 절대라도 *다른* 드라이브 탈출 차단(정규화로 흡수 안 됨).
 *  4. POSIX 정규화 + `.`/`..` 세그먼트 해소(`..` 가 루트 위로 올라가면 탈출 — 명시 거부).
 *  5. allow-root 컨테인먼트(정규화 후 prefix, 세그먼트 경계). 대소문자 보수 비교(Windows).
 *  6. denylist(isSensitivePath) — allow-root 안이라도 거부.
 *
 * ⚠️ realpath(symlink/junction) 재검증은 **어댑터**가 실행 시점에 realpath 후 이 함수를 **재호출**(TOCTOU, GLM f).
 *    여기선 문자열만 — `..` 가 *문자열상* 루트 위로 가는 것까지만 차단. 실제 링크 해소는 I/O 라 도메인 밖.
 */
export function validatePath(rawPath: string, policy: SandboxPolicy): PathValidation {
  if (typeof rawPath !== "string" || rawPath.length === 0) return { ok: false, reason: "path must be non-empty string" };
  if (rawPath.includes("\0")) return { ok: false, reason: "path contains null byte" };
  if (ENV_EXPANSION.test(rawPath)) return { ok: false, reason: "path contains environment-variable expansion (forbidden)" };

  const roots = policy.allowRoots.map(normRoot).filter((r) => r.length > 0);
  if (roots.length === 0) return { ok: false, reason: "no allow-root configured (deny-all)" };

  // 드라이브/UNC 절대경로 = 명시 거부(다른 드라이브/네트워크 탈출). allow-root 가 절대라도 입력은
  // 상대(allow-root 하위) 또는 allow-root 자체로만 — 드라이브 절대를 직접 받지 않는다.
  // 단, allow-root 자체가 드라이브절대(C:\...)인 경우, *입력이 그 루트의 prefix 인 절대경로* 면 허용(아래 정규화로 검증).
  // 그래서 드라이브절대 입력은 일단 정규화 후 컨테인먼트로만 판정(거부 아님). UNC 는 항상 거부(루트가 UNC 일 수 없음 가정).
  if (UNC_ABS.test(rawPath)) return { ok: false, reason: "UNC path forbidden" };

  // 입력이 절대(드라이브절대 or POSIX 절대)면 그대로, 상대면 **각 루트 기준**으로 해소.
  const rawPosix = toPosix(rawPath);
  const isDriveAbs = DRIVE_ABS.test(rawPath);
  const isPosixAbs = rawPosix.startsWith("/");

  // 후보 절대경로 목록 — 절대입력=그 자체(루트 무관), 상대입력=각 루트에 결합.
  const candidates: { abs: string; root: string }[] = [];
  if (isDriveAbs || isPosixAbs) {
    // 절대입력: `..` 해소 후 어느 루트에 들어가는지 컨테인먼트로 판정.
    const resolved = resolveDotSegments(rawPosix);
    if (resolved === null) return { ok: false, reason: "path escapes above root (..)" };
    for (const root of roots) candidates.push({ abs: resolved, root });
  } else {
    // 상대입력: 각 루트에 결합 후 `..` 해소(루트 위로 가면 그 루트 후보는 탈출 — 제외).
    for (const root of roots) {
      const joined = `${root}/${rawPosix}`;
      const resolved = resolveDotSegments(joined);
      if (resolved === null) continue; // 이 루트 기준 탈출 — 다른 루트 시도
      candidates.push({ abs: resolved, root });
    }
    if (candidates.length === 0) return { ok: false, reason: "path escapes above root (..)" };
  }

  // 컨테인먼트: 후보 중 자기 root 안에 있는 것 1개라도 있으면 그 정규화 경로 채택.
  for (const { abs, root } of candidates) {
    if (isWithin(abs, root) || isWithin(abs.toLowerCase(), root.toLowerCase())) {
      // denylist — allow-root 안이라도 거부(민감경로).
      if (isSensitivePath(abs)) return { ok: false, reason: "path is sensitive (denylisted)" };
      return { ok: true, normalized: abs };
    }
  }
  return { ok: false, reason: "path outside allow-root" };
}

/**
 * POSIX 경로의 `.`/`..` 세그먼트 해소(순수 — I/O 없음). `..` 가 루트(절대경로의 최상위) **위**로 가면 null(탈출).
 * 절대경로(선행 `/` 또는 드라이브 `X:`) 보존. 상대 결합경로도 동일(이미 루트가 prefix 라 절대처럼 취급).
 */
function resolveDotSegments(posixPath: string): string | null {
  // 드라이브 prefix(X:) 분리 — 세그먼트 해소가 드라이브문자를 먹지 않게.
  let drive = "";
  let rest = posixPath;
  const dm = rest.match(/^([A-Za-z]:)(\/?)(.*)$/);
  if (dm) { drive = dm[1]; rest = "/" + dm[3]; } // 드라이브절대는 항상 루트앵커 취급
  const absolute = rest.startsWith("/");
  const segs = rest.split("/");
  const out: string[] = [];
  for (const s of segs) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (out.length === 0) {
        if (absolute || drive) return null; // 절대경로에서 루트 위로 탈출
        out.push(".."); // 순수 상대(루트 없음)에서의 .. 는 보존 — 결합단계서 탈출 판정
        continue;
      }
      if (out[out.length - 1] === "..") { out.push(".."); continue; }
      out.pop();
      continue;
    }
    out.push(s);
  }
  const body = out.join("/");
  if (drive) return `${drive}/${body}`;
  if (absolute) return `/${body}`;
  return body;
}
