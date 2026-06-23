// Import-boundary contract — 헥사고날 레이어 순수성 게이트 (codex 크로스리뷰 #5).
//
// "디렉터리 모양 ≠ 아키텍처". 단일패키지라 app/domain 이 adapter util 을 "딱 한 번"
// import 해 계약·직교를 주장하면서 실제로는 subprocess/git/transport 에 결합되기 쉽다.
// 이 테스트는 현재 청결한 경계를 못박아, 향후 이식(sub-agent supervisor·workspace
// watcher·verifier·benchmark 배선)이 메커니즘을 seam 너머로 밀반입하지 못하게 한다.
//
// 규칙(의존 방향: domain ← ports ← app ← composition; adapters 는 domain/ports 구현):
//   domain      : 자기 자신만. ports/app/adapters/composition 및 process/transport 금지.
//   ports       : domain 만. app/adapters/composition 및 process/transport 금지.
//   app          : domain + ports 만. adapters/composition 및 child_process/git/chokidar 금지.
//   adapters    : domain + ports + 자기 자신 + npm/node(IO 는 여기 산다). app/composition 금지.
//   composition : 배선층 — 제한 없음(검사 제외).
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MAIN = join(dirname(fileURLToPath(import.meta.url)), "../main");
const LAYERS = ["domain", "ports", "app", "adapters", "composition"] as const;
type Layer = (typeof LAYERS)[number];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** static import / export-from / dynamic import / require 의 모듈 specifier 추출. */
function specifiers(src: string): string[] {
  const out: string[] = [];
  // side-effect import("import 'x'", from 절 없음)도 포함 — 메커니즘 모듈 부수효과 import 누수 검출(재감사 2026-06-23).
  const re =
    /(?:\bimport\b[^'"]*?\bfrom\s*|\bexport\b[^'"]*?\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+(?=['"]))['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

const norm = (p: string) => p.replace(/\\/g, "/");

/** 파일 절대경로 → 소속 레이어. */
function fileLayer(file: string): Layer | null {
  const rel = norm(file.slice(MAIN.length + 1));
  const top = rel.split("/")[0] as Layer;
  return LAYERS.includes(top) ? top : null;
}

/** 상대 specifier → 타깃 레이어(같은 레이어 내부면 자기 레이어). bare 면 null. */
function targetLayer(spec: string, fileDir: string): Layer | null {
  if (!spec.startsWith(".")) return null;
  const abs = norm(join(fileDir, spec));
  if (!abs.startsWith(norm(MAIN) + "/")) return null; // src/main 밖
  const top = abs.slice(norm(MAIN).length + 1).split("/")[0] as Layer;
  return LAYERS.includes(top) ? top : null;
}

// 레이어별 금지 타깃 레이어
const FORBIDDEN_TARGET: Record<Layer, Layer[]> = {
  domain: ["ports", "app", "adapters", "composition"],
  ports: ["app", "adapters", "composition"],
  app: ["adapters", "composition"],
  adapters: ["app", "composition"],
  composition: [],
};
// domain/ports/app 에서 금지하는 bare 모듈(process/transport 메커니즘 누수)
const FORBIDDEN_BARE =
  /^(node:)?(child_process|net|dgram|cluster|worker_threads)$|^(simple-git|chokidar|execa|cross-spawn|node-pty)$/;
const BARE_GUARDED: Layer[] = ["domain", "ports", "app"];

describe("import-boundary 계약 — 헥사고날 레이어 순수성 (cross-review #5)", () => {
  const files = tsFiles(MAIN).filter((f) => !f.endsWith(".d.ts"));

  it("스캔 대상 파일이 존재한다(테스트 vacuous 아님)", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("레이어 간 의존 방향 위반 0 (domain←ports←app, adapters/composition 분리)", () => {
    const violations: string[] = [];
    for (const file of files) {
      const from = fileLayer(file);
      if (!from || from === "composition") continue;
      const dir = dirname(file);
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        const to = targetLayer(spec, dir);
        if (to && to !== from && FORBIDDEN_TARGET[from].includes(to)) {
          violations.push(`${norm(file.slice(MAIN.length + 1))}  →  ${spec}  [${from} ↛ ${to}]`);
        }
      }
    }
    expect(violations, `레이어 경계 위반:\n${violations.join("\n")}`).toEqual([]);
  });

  it("domain/ports/app 이 process/transport 메커니즘(child_process·git·chokidar 등) 미import", () => {
    const violations: string[] = [];
    for (const file of files) {
      const from = fileLayer(file);
      if (!from || !BARE_GUARDED.includes(from)) continue;
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        if (FORBIDDEN_BARE.test(spec)) {
          violations.push(`${norm(file.slice(MAIN.length + 1))}  →  ${spec}  [${from} 은 메커니즘 금지]`);
        }
      }
    }
    expect(violations, `메커니즘 누수:\n${violations.join("\n")}`).toEqual([]);
  });
});
