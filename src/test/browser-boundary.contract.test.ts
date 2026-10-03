// Browser-boundary contract — 브라우저 진입점의 Node/외부 패키지 미의존 보장 게이트 (FE-05).
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = join(ROOT, "main");
const ENTRY = join(MAIN, "composition/browser-agent.ts");

const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "fs/promises", "http", "http2", "https", "inspector",
  "module", "net", "os", "path", "path/posix", "path/win32", "perf_hooks",
  "process", "punycode", "querystring", "readline", "readline/promises",
  "repl", "stream", "stream/consumers", "stream/promises", "stream/web",
  "string_decoder", "sys", "timers", "timers/promises", "tls", "trace_events",
  "tty", "url", "util", "util/types", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

/**
 * TypeScript 소스에서 런타임 import specifier 추출.
 * - import type 및 export type 은 제외
 * - 동적 import() 및 require() 포함
 */
export function extractRuntimeSpecifiers(code: string): string[] {
  // 1. 주석 제거 (블록 주석 및 한줄 주석)
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*/g, "");

  // 2. import type 및 export type 구문 제거
  const noTypeImports = stripped
    .replace(/(?:^|;|\n)\s*import\s+type\b[\s\S]*?from\s*['"][^'"]+['"]/g, "")
    .replace(/(?:^|;|\n)\s*export\s+type\b[\s\S]*?from\s*['"][^'"]+['"]/g, "");

  // 3. 런타임 import, export-from, import(), require() 추출
  const out: string[] = [];
  const re =
    /(?:\bimport\b[^'"]*?\bfrom\s*|\bexport\b[^'"]*?\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+(?=['"]))['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noTypeImports)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function resolveTsPath(fromDir: string, spec: string): string | null {
  const abs = join(fromDir, spec);
  if (abs.endsWith(".js")) {
    const ts = abs.slice(0, -3) + ".ts";
    if (existsSync(ts)) return ts;
  }
  if (existsSync(abs)) return abs;
  if (existsSync(abs + ".ts")) return abs + ".ts";
  if (existsSync(join(abs, "index.ts"))) return join(abs, "index.ts");
  return null;
}

const norm = (p: string) => p.replace(/\\/g, "/");

describe("browser-boundary 계약 — 브라우저 번들 런타임 순수성 (FE-05)", () => {
  const visited = new Set<string>();
  const specifiersByFile = new Map<string, string[]>();
  const queue: string[] = [ENTRY];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const content = readFileSync(current, "utf8");
    const specs = extractRuntimeSpecifiers(content);
    specifiersByFile.set(current, specs);

    for (const spec of specs) {
      if (spec.startsWith(".")) {
        const nextPath = resolveTsPath(dirname(current), spec);
        if (nextPath && !visited.has(nextPath)) {
          queue.push(nextPath);
        }
      }
    }
  }

  it("browser-agent 에서 도달 가능한 파일이 5개 이상 존재한다 (빈 시험 방지)", () => {
    expect(visited.size).toBeGreaterThanOrEqual(5);
  });

  it("도달 가능한 모든 파일에서 node: / Node 내장 / 외부 패키지 import 가 0건이다", () => {
    const violations: string[] = [];

    for (const [file, specs] of specifiersByFile.entries()) {
      const relFile = norm(file.slice(MAIN.length + 1));
      for (const spec of specs) {
        if (spec.startsWith("node:")) {
          violations.push(`${relFile} → ${spec} (node: 접두사 금지)`);
        } else if (NODE_BUILTINS.has(spec)) {
          violations.push(`${relFile} → ${spec} (Node 내장 모듈 금지)`);
        } else if (!spec.startsWith("./") && !spec.startsWith("../")) {
          violations.push(`${relFile} → ${spec} (비-상대 경로 외부 패키지 import 금지)`);
        }
      }
    }

    expect(violations, `브라우저 경계 위반 모듈 발견:\n${violations.join("\n")}`).toEqual([]);
  });
});
