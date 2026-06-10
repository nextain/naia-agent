// UC5 실 스킬 계약 테스트 (§E.4) — 주입 clock/fetch/memo, 외부 의존 0.
import { describe, it, expect, vi } from "vitest";
import { makeBuiltinSkillsExecutor, type MemoStore } from "../main/adapters/builtin-skills.js";
import type { ToolCall } from "../main/domain/chat.js";

const CALL = (name: string, args: unknown = {}): ToolCall => ({ id: "c", name, args });
const FIXED = new Date("2026-06-11T03:04:05.000Z");

describe("UC5 실 스킬 (§E)", () => {
  it("(a) get_time(주입 clock) → UTC ISO; tz 주면 고정 포맷", async () => {
    const ex = makeBuiltinSkillsExecutor({ clock: () => FIXED });
    expect((await ex.execute(CALL("get_time"), {})).output).toBe("2026-06-11T03:04:05.000Z");
    const tz = await ex.execute(CALL("get_time", { timezone: "Asia/Seoul" }), {});
    expect(tz.output).toBe("2026-06-11 12:04:05 (Asia/Seoul)"); // KST = UTC+9
  });

  it("(b) get_weather(mock) → 포맷 / 비-abort reject → isError / aborted → reject", async () => {
    const ok = makeBuiltinSkillsExecutor({ fetchWeather: async () => ({ tempC: 21, code: 3 }) });
    expect((await ok.execute(CALL("get_weather", { latitude: 37.5, longitude: 127 }), {})).output).toBe("기온 21°C, 코드 3");
    const boom = makeBuiltinSkillsExecutor({ fetchWeather: async () => { throw new Error("net down"); } });
    const r = await boom.execute(CALL("get_weather", { latitude: 0, longitude: 0 }), {});
    expect(r.isError).toBe(true); expect(r.output).toMatch(/net down/);
    const ac = new AbortController(); ac.abort();
    await expect(boom.execute(CALL("get_weather", { latitude: 0, longitude: 0 }), { signal: ac.signal })).rejects.toThrow();
  });

  it("(c) memo save→list→get 왕복 / 빈 목록", async () => {
    const ex = makeBuiltinSkillsExecutor(); // memo 기본 in-memory
    expect((await ex.execute(CALL("memo_list"), {})).output).toBe("(없음)");
    expect((await ex.execute(CALL("memo_save", { title: "T1", content: "hello" }), {})).output).toBe("저장됨: T1");
    expect((await ex.execute(CALL("memo_list"), {})).output).toBe("T1");
    expect((await ex.execute(CALL("memo_get", { title: "T1" }), {})).output).toBe("hello");
    expect((await ex.execute(CALL("memo_get", { title: "none" }), {})).output).toBe("(없음)");
  });

  it("(d) arg 누락/타입오류/배열/null → isError", async () => {
    const ex = makeBuiltinSkillsExecutor({ clock: () => FIXED });
    expect((await ex.execute(CALL("memo_get", {}), {})).isError).toBe(true);
    expect((await ex.execute(CALL("memo_save", { title: "x" }), {})).isError).toBe(true); // content 누락
    expect((await ex.execute(CALL("get_time", []), {})).isError).toBe(true); // 배열 args=비객체→isError
    expect((await ex.execute(CALL("memo_get", null), {})).isError).toBe(true);
  });

  it("(e) 미등록 name → isError", async () => {
    expect((await makeBuiltinSkillsExecutor().execute(CALL("nope"), {})).isError).toBe(true);
  });

  it("(f) tier: memo_save=ask, 나머지=none(미설정)", async () => {
    const specs = makeBuiltinSkillsExecutor().specs();
    expect(specs.find((s) => s.name === "memo_save")?.tier).toBe("ask");
    for (const n of ["get_time", "get_weather", "memo_list", "memo_get"]) expect(specs.find((s) => s.name === n)?.tier).toBeUndefined();
  });

  it("(g) clock/fetch 미주입 → isError; memo 는 항상 가용", async () => {
    const ex = makeBuiltinSkillsExecutor(); // clock/fetch 없음
    expect((await ex.execute(CALL("get_time"), {})).output).toMatch(/unavailable/);
    expect((await ex.execute(CALL("get_weather", { latitude: 0, longitude: 0 }), {})).output).toMatch(/unavailable/);
    expect((await ex.execute(CALL("memo_list"), {})).isError).toBeUndefined(); // 정상
  });

  it("(h) lat/lon NaN/Infinity/범위밖 → isError", async () => {
    const ex = makeBuiltinSkillsExecutor({ fetchWeather: async () => ({ tempC: 1, code: 1 }) });
    for (const args of [{ latitude: NaN, longitude: 0 }, { latitude: Infinity, longitude: 0 }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: 181 }, { latitude: "1", longitude: 0 }]) {
      expect((await ex.execute(CALL("get_weather", args), {})).isError).toBe(true);
    }
  });

  it("(i) invalid timezone → isError(Intl throw catch)", async () => {
    const ex = makeBuiltinSkillsExecutor({ clock: () => FIXED });
    expect((await ex.execute(CALL("get_time", { timezone: "Not/AZone" }), {})).isError).toBe(true);
  });

  it("(j) getter-throw args / sync-throw clock → isError(no-throw)", async () => {
    const ex = makeBuiltinSkillsExecutor({ clock: () => { throw new Error("clock boom"); } });
    expect((await ex.execute(CALL("get_time"), {})).isError).toBe(true);
    const evil = {} as Record<string, unknown>;
    Object.defineProperty(evil, "title", { get() { throw new Error("getter boom"); }, enumerable: true });
    const ex2 = makeBuiltinSkillsExecutor();
    expect((await ex2.execute(CALL("memo_get", evil), {})).isError).toBe(true);
  });

  it("(k) 이미 aborted signal → reject(진입 가드)", async () => {
    const ac = new AbortController(); ac.abort();
    await expect(makeBuiltinSkillsExecutor().execute(CALL("memo_list"), { signal: ac.signal })).rejects.toThrow();
  });

  it("(l) memo_save: aborted → reject + 미저장", async () => {
    const save = vi.fn();
    const store: MemoStore = { save, list: () => [], get: () => null };
    const ac = new AbortController(); ac.abort();
    await expect(makeBuiltinSkillsExecutor({ memo: store }).execute(CALL("memo_save", { title: "t", content: "c" }), { signal: ac.signal })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it("(m) malformed weather(tempC NaN) → isError", async () => {
    const ex = makeBuiltinSkillsExecutor({ fetchWeather: async () => ({ tempC: NaN, code: 1 }) });
    expect((await ex.execute(CALL("get_weather", { latitude: 0, longitude: 0 }), {})).isError).toBe(true);
  });

  it("(n) fetchWeather await 후 abort → reject", async () => {
    const ac = new AbortController();
    const ex = makeBuiltinSkillsExecutor({ fetchWeather: async () => { ac.abort(); return { tempC: 20, code: 1 }; } });
    await expect(ex.execute(CALL("get_weather", { latitude: 0, longitude: 0 }), { signal: ac.signal })).rejects.toThrow();
  });

  it("(o) malformed memo 반환(list 비배열) → isError / (p) clock 무효 Date → isError", async () => {
    const badStore = { save: () => {}, list: () => "nope" as unknown as readonly string[], get: () => null };
    expect((await makeBuiltinSkillsExecutor({ memo: badStore }).execute(CALL("memo_list"), {})).isError).toBe(true);
    const ex = makeBuiltinSkillsExecutor({ clock: () => new Date("invalid") });
    expect((await ex.execute(CALL("get_time"), {})).isError).toBe(true);
  });
});
