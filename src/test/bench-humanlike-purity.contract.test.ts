// UC-HLMEM import purity (FR-HLMEM-7) — the import-boundary axis the contract leans
// on, ENFORCED where the HLMEM core actually lives (benchmark/src/humanlike/*), which
// the src/main-scoped import-boundary.contract.test.ts never reaches.
//
// The deterministic core must NOT drag back the OLD-lineage stale deps
// (@nextain/agent-*, naia-memory FS absolute paths) nor a raw provider client — a
// future P5 live SUT must go through the canonical MemoryPort/ProviderPort (relative
// src/main imports), never a bare provider SDK or an absolute sibling-repo path.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HUMANLIKE = join(dirname(fileURLToPath(import.meta.url)), "../../benchmark/src/humanlike");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function specifiers(src: string): string[] {
  const out: string[] = [];
  const re =
    /(?:\bimport\b[^'"]*?\bfrom\s*|\bexport\b[^'"]*?\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+(?=['"]))['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]!);
  return out;
}

// OLD-lineage / raw-client specifiers that must never reappear in the HLMEM code.
const FORBIDDEN =
  /^@nextain\/agent-|naia-memory\/(src|dist)\/|packages\/(benchmarks|providers|types)\/|^@ai-sdk\/|VercelClient/;
// absolute FS path to a sibling repo (e.g. /var/home/.../naia-memory/src/...).
const isAbsolute = (s: string) => s.startsWith("/");

describe("UC-HLMEM import purity (FR-HLMEM-7, enforced at benchmark/src/humanlike)", () => {
  const files = tsFiles(HUMANLIKE);

  it("scans real files (not vacuous)", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it("no @nextain/agent-* / naia-memory FS / stale packages / raw provider-client imports", () => {
    const violations: string[] = [];
    for (const f of files) {
      for (const spec of specifiers(readFileSync(f, "utf8"))) {
        if (FORBIDDEN.test(spec) || isAbsolute(spec)) {
          violations.push(`${f.slice(HUMANLIKE.length + 1)}  →  ${spec}`);
        }
      }
    }
    expect(violations, `HLMEM 순수성 위반(옛 계보 dep/절대경로 밀반입):\n${violations.join("\n")}`).toEqual([]);
  });

  it("deterministic core files are self-contained (only relative + node: imports)", () => {
    const CORE = new Set(["types.ts", "parse.ts", "pipeline.ts", "metrics.ts", "scenarios.ts", "fixture.ts", "index.ts"]);
    const violations: string[] = [];
    for (const f of files) {
      const base = f.slice(HUMANLIKE.length + 1);
      if (!CORE.has(base)) continue; // live-SUT (P5) may import canonical ports via relative src/main path
      for (const spec of specifiers(readFileSync(f, "utf8"))) {
        const ok = spec.startsWith(".") || spec.startsWith("node:");
        if (!ok) violations.push(`${base}  →  ${spec}`);
      }
    }
    expect(violations, `결정론 코어에 외부 의존:\n${violations.join("\n")}`).toEqual([]);
  });
});
