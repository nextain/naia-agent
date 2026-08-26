// #112 후속 — 두 저장소 wire 어휘 동기 게이트 (REQ-022 / UC-022 / SPEC-021).
//
// 왜 있는가: naia-agent 와 naia-shell 은 2026-06-10 에 갈라졌다. 그때 경계를 지키기로 한 probe 들은
// 옛 baseline 대조라 오늘 SKIP 되고, 그 사이 실제로 하나가 8주간 조용히 깨져 있었다 — 셸이
// `kind: "panel"` 을 `"app"` 으로 바꿨는데 이 디코더는 옛 이름만 받아 앱 컨텍스트를 통째로 버렸다(#113).
//
// 별칭으로 때우면 *다음* 이름 변경을 또 놓친다. 그래서 어휘 자체를 게이트로 만든다:
// 양쪽이 자기 코드에서 어휘를 뽑아 같은 표본과 대조하고, 디코더가 union 의 모든 kind 를
// 실제로 받는지 런타임으로 확인한다. #113 을 잡았을 단언이 아래 "디코더가 …" 묶음이다.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeEnvironmentSegments, encodeEmit } from "../main/adapters/protocol.js";

const FIXTURE_PATH = resolve(__dirname, "fixtures", "wire-union.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  readonly agentEmitsChatTurn: readonly string[];
  readonly shellAcceptsChatTurn: readonly string[];
  readonly shellAcceptsNonChat: readonly string[];
  readonly environmentSegmentKinds: readonly string[];
};

function sliceFrom(path: string, start: string): string {
  const src = readFileSync(path, "utf8");
  const at = src.indexOf(start);
  expect(at, `${path} 에서 "${start}" 를 못 찾았다`).toBeGreaterThan(-1);
  const rest = src.slice(at + start.length);
  const stop = rest.search(/\n(?:export |function |const )/);
  return stop === -1 ? rest : rest.slice(0, stop);
}

const MAIN = resolve(__dirname, "..", "main");
/** 뇌가 실제로 내보내는 chat-turn 종류 — 손으로 적은 표가 아니라 `encodeEmit` 본문에서. */
const emitted = [
  ...new Set(
    [...sliceFrom(resolve(MAIN, "adapters", "protocol.ts"), "export function encodeEmit").matchAll(
      /type: "([a-z_]+)"/g,
    )].map((m) => m[1] as string),
  ),
].sort();
/** 이 저장소의 `EnvironmentSegment` union kind — 타입은 런타임에 없으므로 소스에서. */
const unionKinds = [
  ...new Set(
    [...sliceFrom(resolve(MAIN, "domain", "chat.ts"), "export type EnvironmentSegment =").matchAll(
      /kind: "([A-Za-z]+)"/g,
    )].map((m) => m[1] as string),
  ),
].sort();

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe("추출이 공허하지 않다 (REQ-022)", () => {
  // 추출이 0건이면 아래 대조가 전부 공허하게 참이 된다. 그 경로부터 막는다.
  it("송신 목록과 union kind 를 실제로 뽑았다", () => {
    expect(emitted.length).toBeGreaterThan(5);
    expect(unionKinds.length).toBeGreaterThan(1);
  });
});

describe("뇌의 어휘가 표본과 같다 (SPEC-021)", () => {
  it("`encodeEmit` 이 내보내는 종류가 표본과 같다", () => {
    expect(emitted).toEqual(sorted(fixture.agentEmitsChatTurn));
  });

  it("`EnvironmentSegment` union kind 가 표본과 같다", () => {
    expect(unionKinds).toEqual(sorted(fixture.environmentSegmentKinds));
  });

  it("보내는 종류를 셸이 전부 안다", () => {
    const known = new Set([...fixture.shellAcceptsChatTurn, ...fixture.shellAcceptsNonChat]);
    expect(emitted.filter((t) => !known.has(t))).toEqual([]);
  });
});

describe("디코더가 union 의 모든 kind 를 실제로 받는다 (#113 을 잡았을 단언)", () => {
  /** kind 하나짜리 최소 입력. 디코더가 형태를 요구하는 필드만 채운다. */
  const sample = (kind: string): Record<string, unknown> => {
    switch (kind) {
      case "app":
        return { kind, entries: [{ type: "bgm", data: { track: "x" } }] };
      case "responseStyle":
        return { kind, style: "brief" };
      case "environmentSurfaces":
        return {
          kind,
          surfaces: [{ ref: "s-1", label: "빌더", activity: "working", focused: true }],
          omitted: 0,
        };
      default:
        return { kind };
    }
  };

  for (const kind of unionKinds) {
    it(`"${kind}" 를 드롭하지 않는다`, () => {
      const out = decodeEnvironmentSegments([sample(kind)]);
      expect(out.map((s) => s.kind), `union 에 있는 kind 인데 디코더가 버렸다 — #113 과 같은 조용한 유실`).toEqual([kind]);
    });
  }

  it("union 밖 kind 는 여전히 드롭한다 — 화이트리스트가 느슨해지지 않았다", () => {
    expect(decodeEnvironmentSegments([{ kind: "panel" }, { kind: "totally_new" }])).toEqual([]);
  });

  it("한 배열 안에서 모든 kind 가 함께 살아남는다", () => {
    const out = decodeEnvironmentSegments(unionKinds.map(sample));
    expect(out.map((s) => s.kind).sort()).toEqual(unionKinds);
  });
});

describe("`encodeEmit` 추출이 실제 산출과 맞다", () => {
  // 소스에서 뽑은 목록이 진짜 실행 결과와 같은지 — 표본이 죽은 문자열이 되지 않게.
  it("추출한 이름 중 하나가 실제 인코딩 결과와 같다", () => {
    expect(encodeEmit("r1", { kind: "text", text: "안녕" })["type"]).toBe("text");
    expect(emitted).toContain("text");
  });

  it("추출 목록에 없는 이름을 인코더가 내지 않는다 — finish/error 도 표본 안이다", () => {
    for (const e of [{ kind: "finish" as const }, { kind: "error" as const, message: "x" }]) {
      expect(emitted).toContain(String(encodeEmit("r1", e)["type"]));
    }
  });
});

describe("짝 저장소와의 표본 드리프트 (REQ-022)", () => {
  const REL = ["src", "test", "fixtures", "wire-union.json"];
  const roots: string[] = [];
  for (let up = 2; up <= 6; up += 1) {
    const base = resolve(__dirname, ...Array.from({ length: up }, () => ".."));
    roots.push(resolve(base, "naia-shell", ...REL));
    for (const wt of ["naia-shell-497-universal-agent"]) {
      roots.push(resolve(base, "naia-shell", "worktrees", wt, ...REL));
      roots.push(resolve(base, "naia-shell-worktrees", wt, ...REL));
    }
  }
  const peer = roots.find((p) => existsSync(p));

  it("짝 저장소 표본을 실제로 찾았다 — 건너뛴 게이트는 게이트가 아니다", () => {
    expect(peer, `찾은 곳 없음. 훑은 경로: ${roots.join(", ")}`).toBeDefined();
  });

  it.skipIf(peer === undefined)("두 저장소의 표본이 한 글자도 다르지 않다", () => {
    expect(readFileSync(peer as string, "utf8")).toBe(readFileSync(FIXTURE_PATH, "utf8"));
  });
});
