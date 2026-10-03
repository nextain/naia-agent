// Browser-boundary contract — 브라우저 진입점의 Node/외부 패키지 미의존 보장 게이트 (FE-05).
//
// 범위:
// 이 시험이 보장하는 것은 "브라우저 진입점에서 브라우저 로더(정적 import·export-from,
// import(), 상수 인자 require 직접 호출, importScripts·Worker)로 닿는 모듈 그래프에
// Node 내장·외부 패키지가 없고, 해석할 수 없는 모듈 로딩이 없다"는 것이다(FE-05).
// eval·Function·(()=>{}).constructor 같은 동적 코드 실행은 이 시험의 대상이 아니다.
// 형태를 하나씩 막는 방식으로는 닫히지 않으므로, 웹 빌드의 CSP 에서 unsafe-eval 을 빼
// 런타임에 구조적으로 막는다(조정자가 웹 빌드 쪽 별도 항목으로 처리한다).

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = join(ROOT, "main");
const ENTRY = join(MAIN, "composition/browser-agent.ts");

export const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "fs/promises", "http", "http2", "https", "inspector",
  "module", "net", "os", "path", "path/posix", "path/win32", "perf_hooks",
  "process", "punycode", "querystring", "readline", "readline/promises",
  "repl", "stream", "stream/consumers", "stream/promises", "stream/web",
  "string_decoder", "sys", "timers", "timers/promises", "tls", "trace_events",
  "tty", "url", "util", "util/types", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

const LOADER_NAMES = new Set(["Worker", "SharedWorker", "importScripts"]);

export interface ExtractedSpecifiers {
  specifiers: string[];
  unresolvable: string[];
}

export interface BoundaryViolationResult {
  reachableFiles: Set<string>;
  visited: Set<string>;
  violations: string[];
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let curr = node;
  while (true) {
    if (ts.isParenthesizedExpression(curr)) {
      curr = curr.expression;
    } else if (ts.isAsExpression(curr)) {
      curr = curr.expression;
    } else if (ts.isTypeAssertionExpression(curr)) {
      curr = curr.expression;
    } else if (ts.isNonNullExpression(curr)) {
      curr = curr.expression;
    } else if (ts.isSatisfiesExpression && ts.isSatisfiesExpression(curr)) {
      curr = curr.expression;
    } else {
      break;
    }
  }
  return curr;
}

function isInsideTypeOnly(node: ts.Node): boolean {
  let curr: ts.Node | undefined = node.parent;
  while (curr) {
    if (ts.isImportSpecifier(curr) && curr.isTypeOnly) return true;
    if (ts.isExportSpecifier(curr) && curr.isTypeOnly) return true;
    if (ts.isImportClause(curr) && curr.isTypeOnly) return true;
    if (ts.isExportDeclaration(curr) && curr.isTypeOnly) return true;
    if (ts.isImportEqualsDeclaration(curr) && curr.isTypeOnly) return true;
    curr = curr.parent;
  }
  return false;
}

/**
 * TypeScript 소스에서 런타임 import specifier 및 해석 불가/별도 로더 항목 추출.
 * 구문 트리를 전체 순회하며 판정한다.
 */
export function extractRuntimeSpecifiers(code: string): ExtractedSpecifiers {
  const sourceFile = ts.createSourceFile("temp.ts", code, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const unresolvable: string[] = [];

  function getLine(node: ts.Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  }

  function visit(node: ts.Node): void {
    // 1. 브라우저 별도 로더 부류: Worker, SharedWorker, importScripts
    if (ts.isIdentifier(node)) {
      if (LOADER_NAMES.has(node.text) && !isInsideTypeOnly(node)) {
        unresolvable.push(`${getLine(node)}: 별도 로더 ${node.text}`);
      }
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (LOADER_NAMES.has(node.text) && !isInsideTypeOnly(node)) {
        unresolvable.push(`${getLine(node)}: 별도 로더 ${node.text}`);
      }
    }

    // 2. ImportDeclaration
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (!clause) {
        // 부수효과 import: import "foo"
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          specifiers.push(node.moduleSpecifier.text);
        }
      } else if (clause.isTypeOnly) {
        // import type ... -> 제외
      } else if (clause.name) {
        // default 이름이 있으면 런타임 의존
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          specifiers.push(node.moduleSpecifier.text);
        }
      } else if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          // import * as X -> 런타임 의존
          if (ts.isStringLiteral(node.moduleSpecifier)) {
            specifiers.push(node.moduleSpecifier.text);
          }
        } else if (ts.isNamedImports(clause.namedBindings)) {
          const elements = clause.namedBindings.elements;
          if (elements.length > 0 && elements.every((e) => e.isTypeOnly)) {
            // 항목이 모두 isTypeOnly 이면 제외
          } else {
            // 하나라도 값이거나 빈 목록이면 런타임 의존
            if (ts.isStringLiteral(node.moduleSpecifier)) {
              specifiers.push(node.moduleSpecifier.text);
            }
          }
        }
      }
    }

    // 3. ExportDeclaration (moduleSpecifier 가 있을 때만)
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (node.isTypeOnly) {
        // export type { ... } from "..." -> 제외
      } else if (!node.exportClause) {
        // export * from "..." -> 런타임 의존
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          specifiers.push(node.moduleSpecifier.text);
        }
      } else if (ts.isNamespaceExport(node.exportClause)) {
        // export * as X from "..." -> 런타임 의존
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          specifiers.push(node.moduleSpecifier.text);
        }
      } else if (ts.isNamedExports(node.exportClause)) {
        const elements = node.exportClause.elements;
        if (elements.length > 0 && elements.every((e) => e.isTypeOnly)) {
          // 항목이 모두 isTypeOnly 이면 제외
        } else {
          // 하나라도 값이거나 빈 목록이면 런타임 의존
          if (ts.isStringLiteral(node.moduleSpecifier)) {
            specifiers.push(node.moduleSpecifier.text);
          }
        }
      }
    }

    // 4. ImportEqualsDeclaration
    else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        if (!node.isTypeOnly) {
          const expr = node.moduleReference.expression;
          if (expr && ts.isStringLiteral(expr)) {
            specifiers.push(expr.text);
          }
        }
      }
    }

    // 5. CallExpression
    else if (ts.isCallExpression(node)) {
      // (a) callee 가 import 키워드인 경우
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const firstArg = node.arguments[0] ? unwrapExpression(node.arguments[0]) : undefined;
        if (firstArg && (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg))) {
          specifiers.push(firstArg.text);
        } else {
          unresolvable.push(`${getLine(node)}: 해석 불가 동적 import`);
        }
      }
      // (b) require 직접 호출
      else {
        const unwrapped = unwrapExpression(node.expression);
        if (ts.isIdentifier(unwrapped) && unwrapped.text === "require") {
          const firstArg = node.arguments[0] ? unwrapExpression(node.arguments[0]) : undefined;
          if (firstArg && (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg))) {
            specifiers.push(firstArg.text);
          } else {
            unresolvable.push(`${getLine(node)}: 해석 불가 require`);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { specifiers, unresolvable };
}

function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..";
}

/**
 * 모듈 그래프를 순회하며 브라우저 경계 위반 목록과 도달 파일 집합을 반환하는 순수 함수.
 */
export function findBoundaryViolations(
  entry: string,
  readSource: (path: string) => string,
  resolve: (fromFile: string, spec: string) => string | null,
): BoundaryViolationResult {
  const visited = new Set<string>();
  const queue: string[] = [entry];
  const violations: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const content = readSource(current);
    const { specifiers, unresolvable } = extractRuntimeSpecifiers(content);

    for (const item of unresolvable) {
      const colonIdx = item.indexOf(":");
      const line = item.slice(0, colonIdx).trim();
      const reason = item.slice(colonIdx + 1).trim();
      violations.push(`${current}:${line} → ${reason}`);
    }

    for (const spec of specifiers) {
      if (spec.startsWith("node:")) {
        violations.push(`${current} → ${spec} (node: 접두사 금지)`);
      } else if (NODE_BUILTINS.has(spec)) {
        violations.push(`${current} → ${spec} (Node 내장 모듈 금지)`);
      } else if (!isRelativeSpecifier(spec)) {
        violations.push(`${current} → ${spec} (비-상대 경로 외부 패키지 import 금지)`);
      } else {
        const nextPath = resolve(current, spec);
        if (nextPath === null) {
          violations.push(`${current} → ${spec} (해석 실패)`);
        } else if (!visited.has(nextPath)) {
          queue.push(nextPath);
        }
      }
    }
  }

  return { reachableFiles: visited, visited, violations };
}

export function resolveTsPath(fromDir: string, spec: string): string | null {
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

describe("3.1 / 3.3 extractRuntimeSpecifiers 추출 시험", () => {
  const cases: Array<{
    source: string;
    specifiers: string[];
    unresolvable: string[];
  }> = [
    {
      source: "import(`node:fs`)",
      specifiers: ["node:fs"],
      unresolvable: [],
    },
    {
      source: 'const n = "node:fs"; import(n)',
      specifiers: [],
      unresolvable: ["1: 해석 불가 동적 import"],
    },
    {
      source: "import(`./${x}`)",
      specifiers: [],
      unresolvable: ["1: 해석 불가 동적 import"],
    },
    {
      source: 'import("https://example.org/mod.js")',
      specifiers: ["https://example.org/mod.js"],
      unresolvable: [],
    },
    {
      source: 'const s = "// not a comment"; import("node:os")',
      specifiers: ["node:os"],
      unresolvable: [],
    },
    {
      source: 'import type { A } from "node:fs"',
      specifiers: [],
      unresolvable: [],
    },
    {
      source: 'import { type A } from "node:fs"',
      specifiers: [],
      unresolvable: [],
    },
    {
      source: 'import D, { type A } from "node:fs"; console.log(D)',
      specifiers: ["node:fs"],
      unresolvable: [],
    },
    {
      source: 'import * as NS from "node:fs"',
      specifiers: ["node:fs"],
      unresolvable: [],
    },
    {
      source: 'export type { A } from "node:fs"',
      specifiers: [],
      unresolvable: [],
    },
    {
      source: 'export { type A } from "node:fs"',
      specifiers: [],
      unresolvable: [],
    },
    {
      source: 'export { type A, b } from "node:fs"',
      specifiers: ["node:fs"],
      unresolvable: [],
    },
    {
      source: 'export * from "node:fs"',
      specifiers: ["node:fs"],
      unresolvable: [],
    },
    {
      source: 'import "node:fs"',
      specifiers: ["node:fs"],
      unresolvable: [],
    },
    {
      source: 'import x = require("node:fs")',
      specifiers: ["node:fs"],
      unresolvable: [],
    },
    {
      source: 'import type X = require("node:fs")',
      specifiers: [],
      unresolvable: [],
    },
    {
      source: 'require("node:fs")',
      specifiers: ["node:fs"],
      unresolvable: [],
    },
    {
      source: 'globalThis.require("node:fs")',
      specifiers: [],
      unresolvable: [],
    },
    {
      source: 'const r = require; r("node:fs")',
      specifiers: [],
      unresolvable: [],
    },
    {
      source: "const u = import.meta.url",
      specifiers: [],
      unresolvable: [],
    },
    {
      source: 'globalThis["require"]("node:fs")',
      specifiers: [],
      unresolvable: [],
    },
    {
      source: 'const n = "node:fs"; require(n)',
      specifiers: [],
      unresolvable: ["1: 해석 불가 require"],
    },
    {
      source: "class C extends (await import(x)).B {}",
      specifiers: [],
      unresolvable: ["1: 해석 불가 동적 import"],
    },
    {
      source: "class C extends (await import(`node:fs`)).B {}",
      specifiers: ["node:fs"],
      unresolvable: [],
    },
    {
      source: 'importScripts("a.js")',
      specifiers: [],
      unresolvable: ["1: 별도 로더 importScripts"],
    },
    {
      source: 'new Worker(new URL("./w.js", import.meta.url))',
      specifiers: [],
      unresolvable: ["1: 별도 로더 Worker"],
    },
    {
      source: 'type T = typeof import("node:fs")',
      specifiers: [],
      unresolvable: [],
    },
    {
      source: '(require)("probe-module")',
      specifiers: ["probe-module"],
      unresolvable: [],
    },
    {
      source: '(require as any)("probe-module")',
      specifiers: ["probe-module"],
      unresolvable: [],
    },
    {
      source: 'require!("probe-module")',
      specifiers: ["probe-module"],
      unresolvable: [],
    },
    {
      source: 'new globalThis.Worker("./w.js", { type: "module" })',
      specifiers: [],
      unresolvable: ["1: 별도 로더 Worker"],
    },
    {
      source: 'const W = Worker; new W("./w.js")',
      specifiers: [],
      unresolvable: ["1: 별도 로더 Worker"],
    },
    {
      source: 'new globalThis["SharedWorker"]("./w.js")',
      specifiers: [],
      unresolvable: ["1: 별도 로더 SharedWorker"],
    },
  ];

  it.each(cases)("추출 사례: $source", ({ source, specifiers, unresolvable }) => {
    const result = extractRuntimeSpecifiers(source);
    expect(result.specifiers).toEqual(specifiers);
    expect(result.unresolvable).toEqual(unresolvable);
  });
});

describe("3.2 / 3.4 findBoundaryViolations 경계 판정 시험 (가짜 그래프)", () => {
  it("진입 파일이 ./a.js 를 import 하고 a.ts 가 node:fs 를 import → 위반 1건(a.ts)", () => {
    const files: Record<string, string> = {
      "entry.ts": 'import "./a.js";',
      "a.ts": 'import "node:fs";',
    };
    const result = findBoundaryViolations(
      "entry.ts",
      (f) => files[f],
      (_from, spec) => (spec === "./a.js" ? "a.ts" : null),
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("a.ts");
    expect(result.violations[0]).toContain("node:fs");
  });

  it("진입 파일이 해석되지 않는 ./missing.js 를 import → 위반 1건(해석 실패)", () => {
    const files: Record<string, string> = {
      "entry.ts": 'import "./missing.js";',
    };
    const result = findBoundaryViolations(
      "entry.ts",
      (f) => files[f],
      () => null,
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("entry.ts");
    expect(result.violations[0]).toContain("./missing.js");
    expect(result.violations[0]).toContain("해석 실패");
  });

  it('도달 파일이 import("https://example.org/mod.js") → 위반 1건(외부 의존)', () => {
    const files: Record<string, string> = {
      "entry.ts": 'import "./b.ts";',
      "b.ts": 'import("https://example.org/mod.js");',
    };
    const result = findBoundaryViolations(
      "entry.ts",
      (f) => files[f],
      (_from, spec) => (spec === "./b.ts" ? "b.ts" : null),
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("b.ts");
    expect(result.violations[0]).toContain("https://example.org/mod.js");
  });

  it("도달 파일이 import(n) → 위반 1건(해석 불가 동적 import)", () => {
    const files: Record<string, string> = {
      "entry.ts": 'import "./b.ts";',
      "b.ts": 'const n = "node:fs"; import(n);',
    };
    const result = findBoundaryViolations(
      "entry.ts",
      (f) => files[f],
      (_from, spec) => (spec === "./b.ts" ? "b.ts" : null),
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("b.ts");
    expect(result.violations[0]).toContain("해석 불가 동적 import");
  });

  it("도달 파일이 import(`./${x}`) → 위반 1건", () => {
    const files: Record<string, string> = {
      "entry.ts": 'import "./b.ts";',
      "b.ts": "import(`./${x}`);",
    };
    const result = findBoundaryViolations(
      "entry.ts",
      (f) => files[f],
      (_from, spec) => (spec === "./b.ts" ? "b.ts" : null),
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("b.ts");
    expect(result.violations[0]).toContain("해석 불가 동적 import");
  });

  it("위반이 없는 두 파일 그래프 → 위반 0건, 도달 파일 2개", () => {
    const files: Record<string, string> = {
      "entry.ts": 'import { helper } from "./helper.js"; export const run = () => helper();',
      "helper.ts": "export const helper = () => 42;",
    };
    const result = findBoundaryViolations(
      "entry.ts",
      (f) => files[f],
      (_from, spec) => (spec === "./helper.js" ? "helper.ts" : null),
    );
    expect(result.violations).toHaveLength(0);
    expect(result.reachableFiles.size).toBe(2);
  });
});

describe("browser-boundary 계약 — 브라우저 번들 런타임 순수성 (FE-05)", () => {
  const result = findBoundaryViolations(
    ENTRY,
    (file) => readFileSync(file, "utf8"),
    (fromFile, spec) => resolveTsPath(dirname(fromFile), spec),
  );

  it("browser-agent 에서 도달 가능한 파일이 5개 이상 존재한다 (빈 시험 방지)", () => {
    expect(result.reachableFiles.size).toBeGreaterThanOrEqual(5);
  });

  it("browser-agent 에서 도달 가능한 파일 목록에 webllm-provider.ts 가 포함된다", () => {
    const webllmFile = join(MAIN, "adapters/webllm-provider.ts");
    expect(result.reachableFiles.has(webllmFile)).toBe(true);
  });

  it("도달 가능한 모든 파일에서 node: / Node 내장 / 외부 패키지 import 가 0건이다", () => {
    expect(result.violations, `브라우저 경계 위반 모듈 발견:\n${result.violations.join("\n")}`).toEqual([]);
  });
});
