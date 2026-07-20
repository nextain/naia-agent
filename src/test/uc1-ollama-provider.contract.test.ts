// ollama ProviderPort 계약 테스트 — mock fetch(실 ollama 없이 NDJSON 스트림 재현).
// UC5 §H(FR-PROV-6): tools 전송·message.tool_calls 파싱·tool-bearing 메시지 매핑·degrade 재시도.
import { describe, it, expect } from "vitest";
import { makeOllamaProvider } from "../main/adapters/ollama-provider.js";
import type { ProviderChunk, ProviderConfig } from "../main/domain/chat.js";

// NDJSON 줄들을 청크로 쪼개 흘려주는 mock fetch. bodies 는 요청 body 캡처(§H.1 형상 단언).
function mockFetch(lines: string[], opts: { ok?: boolean; status?: number; errorBody?: string } = {}) {
  const enc = new TextEncoder();
  const bodies: unknown[] = [];
  const fetch = async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    if (opts.ok === false) {
      // !ok 도 본문 reader 제공(§H.2 — 오류본문 소비·degrade 판별)
      let ei = 0;
      const errChunks = opts.errorBody !== undefined ? [opts.errorBody] : [];
      const errReader = {
        async read(): Promise<{ done: boolean; value?: Uint8Array }> {
          if (ei >= errChunks.length) return { done: true };
          return { done: false, value: enc.encode(errChunks[ei++]!) };
        },
      };
      return { ok: false, status: opts.status ?? 500, statusText: "err", body: opts.errorBody !== undefined ? { getReader: () => errReader } : null };
    }
    let i = 0;
    const reader = {
      async read(): Promise<{ done: boolean; value?: Uint8Array }> {
        if (i >= lines.length) return { done: true };
        return { done: false, value: enc.encode(lines[i++]!) };
      },
    };
    return { ok: true, status: 200, statusText: "OK", body: { getReader: () => reader } };
  };
  return Object.assign(fetch, { bodies });
}
const cfg: ProviderConfig = { provider: "ollama", model: "gemma4", ollamaHost: "http://h" };
async function collect(gen: AsyncIterable<ProviderChunk>) { const out: ProviderChunk[] = []; for await (const c of gen) out.push(c); return out; }

describe("makeOllamaProvider (native /api/chat, mock fetch)", () => {
	it("forwards a CPU-only Ollama profile as num_gpu=0", async () => {
		const fetch = mockFetch([JSON.stringify({ done: true }) + "\n"]);
		await collect(makeOllamaProvider({ fetch: fetch as never }).chat(
			{ ...cfg, ollamaNumGpu: 0 }, [{ role: "user", content: "hi" }], {},
		));
		expect((fetch.bodies[0] as { options: Record<string, unknown> }).options.num_gpu).toBe(0);
	});
  it("NDJSON content delta → per-chunk text 스트림 + usage + finish", async () => {
    const lines = [
      JSON.stringify({ message: { content: "안녕" } }) + "\n",
      JSON.stringify({ message: { content: "하세요" } }) + "\n",
      JSON.stringify({ done: true, prompt_eval_count: 5, eval_count: 7 }) + "\n",
    ];
    const out = await collect(makeOllamaProvider({ fetch: mockFetch(lines) as never }).chat(cfg, [{ role: "user", content: "hi" }], {}));
    expect(out).toEqual([
      { kind: "text", text: "안녕" }, { kind: "text", text: "하세요" },
      { kind: "usage", inputTokens: 5, outputTokens: 7 }, { kind: "finish" },
    ]); // ⚠️ 스트리밍(per-chunk) — buffer 아님(UC1 목표)
  });
  it("thinking delta → thinking chunk", async () => {
    const lines = [JSON.stringify({ message: { thinking: "음..." } }) + "\n", JSON.stringify({ done: true }) + "\n"];
    const out = await collect(makeOllamaProvider({ fetch: mockFetch(lines) as never }).chat(cfg, [], {}));
    expect(out[0]).toEqual({ kind: "thinking", text: "음..." });
    expect(out[out.length - 1]).toEqual({ kind: "finish" });
  });
  it("청크 경계가 줄 중간이어도 NDJSON 재조립", async () => {
    const lines = ['{"message":{"content":"부분', '1"}}\n{"message":{"content":"부분2"}}\n', '{"done":true}\n'];
    const out = await collect(makeOllamaProvider({ fetch: mockFetch(lines) as never }).chat(cfg, [], {}));
    expect(out.filter((c) => c.kind === "text").map((c) => (c as { text: string }).text)).toEqual(["부분1", "부분2"]);
  });
  it("!ok → throw(handler catch=error)", async () => {
    const gen = makeOllamaProvider({ fetch: mockFetch([], { ok: false, status: 503 }) as never }).chat(cfg, [], {});
    await expect(collect(gen)).rejects.toThrow(/503/);
  });
  it("HTTP 200 스트림 내 {error} → throw(성공 오인 방지, R4)", async () => {
    const lines = [JSON.stringify({ message: { content: "부분" } }) + "\n", JSON.stringify({ error: "model not found" }) + "\n"];
    const gen = makeOllamaProvider({ fetch: mockFetch(lines) as never }).chat(cfg, [], {});
    await expect(collect(gen)).rejects.toThrow(/model not found/);
  });
  it("손상 NDJSON 줄 skip(크래시 없음)", async () => {
    const lines = ["not json\n", JSON.stringify({ message: { content: "ok" } }) + "\n", JSON.stringify({ done: true }) + "\n"];
    const out = await collect(makeOllamaProvider({ fetch: mockFetch(lines) as never }).chat(cfg, [], {}));
    expect(out.some((c) => c.kind === "text" && (c as { text: string }).text === "ok")).toBe(true);
  });
});

// ── UC5 §H (FR-PROV-6) — ollama native tools ────────────────────────────────
describe("UC5 §H tools (ollama native tool_calls)", () => {
  const TOOLS = [
    { name: "skill_time", description: "Get current date and time", parameters: { type: "object", properties: {} } },
    { name: "skill_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
  ];
  const doneLine = JSON.stringify({ done: true, prompt_eval_count: 3, eval_count: 4 }) + "\n";

  it("(a) opts.tools → body.tools 매핑({type:function, function:{name,description,parameters}}); 미전달 시 tools 키 생략", async () => {
    const f1 = mockFetch([doneLine]);
    await collect(makeOllamaProvider({ fetch: f1 as never }).chat(cfg, [{ role: "user", content: "hi" }], { tools: TOOLS }));
    const b1 = f1.bodies[0] as { tools?: unknown[] };
    expect(b1.tools).toEqual(TOOLS.map((s) => ({ type: "function", function: { name: s.name, description: s.description, parameters: s.parameters } })));
    const f2 = mockFetch([doneLine]);
    await collect(makeOllamaProvider({ fetch: f2 as never }).chat(cfg, [{ role: "user", content: "hi" }], {}));
    expect((f2.bodies[0] as { tools?: unknown }).tools).toBeUndefined(); // H-I1: tools 없으면 키 자체 생략
  });

  it("(b) assistant.toolCalls(arguments=object 그대로) + tool(tool_call_id + tool_name 복원) 메시지 형상", async () => {
    const f = mockFetch([doneLine]);
    await collect(makeOllamaProvider({ fetch: f as never }).chat(cfg, [
      { role: "user", content: "몇 시?" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "skill_time", args: { tz: "Asia/Seoul" } }] },
      { role: "tool", toolCallId: "c1", content: '{"time":"23:40"}' },
    ], { tools: TOOLS }));
    const msgs = (f.bodies[0] as { messages: Array<Record<string, unknown>> }).messages;
    expect(msgs[1]).toEqual({
      role: "assistant", content: "",
      tool_calls: [{ id: "c1", function: { name: "skill_time", arguments: { tz: "Asia/Seoul" } } }], // ⚠️ object 그대로(stringify 아님 — ollama native 규약)
    });
    expect(msgs[2]).toEqual({ role: "tool", content: '{"time":"23:40"}', tool_call_id: "c1", tool_name: "skill_time" }); // id→name 맵 복원
  });

  it("(b2) tool 메시지 toolCallId 누락 → throw(§C.1 동일 — skip 금지)", async () => {
    const gen = makeOllamaProvider({ fetch: mockFetch([doneLine]) as never }).chat(cfg, [
      { role: "tool", content: "r" } as never,
    ], {});
    await expect(collect(gen)).rejects.toThrow(/toolCallId/);
  });

  it("(c) message.tool_calls(완성체) → 스트림 종료 후 toolUse → usage → finish 순", async () => {
    const lines = [
      JSON.stringify({ message: { content: "생각" } }) + "\n",
      JSON.stringify({ message: { content: "", tool_calls: [{ id: "abc", function: { index: 0, name: "skill_time", arguments: {} } }] }, done: true, prompt_eval_count: 5, eval_count: 7 }) + "\n",
    ];
    const out = await collect(makeOllamaProvider({ fetch: mockFetch(lines) as never }).chat(cfg, [{ role: "user", content: "hi" }], { tools: TOOLS }));
    expect(out).toEqual([
      { kind: "text", text: "생각" },
      { kind: "toolUse", id: "abc", name: "skill_time", args: {} },
      { kind: "usage", inputTokens: 5, outputTokens: 7 },
      { kind: "finish" },
    ]);
  });

  it("(d) id 누락 → call_{i} 배치-유일 합성 / nonempty 중복 id → throw", async () => {
    const l1 = [JSON.stringify({ message: { tool_calls: [{ function: { name: "skill_time", arguments: {} } }, { function: { name: "skill_weather", arguments: { city: "seoul" } } }] }, done: true }) + "\n"];
    const out = await collect(makeOllamaProvider({ fetch: mockFetch(l1) as never }).chat(cfg, [], { tools: TOOLS }));
    const uses = out.filter((c) => c.kind === "toolUse") as Array<{ id: string }>;
    expect(uses.map((u) => u.id)).toEqual(["call_0", "call_1"]);
    const l2 = [JSON.stringify({ message: { tool_calls: [{ id: "dup", function: { name: "a", arguments: {} } }, { id: "dup", function: { name: "b", arguments: {} } }] }, done: true }) + "\n"];
    await expect(collect(makeOllamaProvider({ fetch: mockFetch(l2) as never }).chat(cfg, [], { tools: TOOLS }))).rejects.toThrow(/duplicate tool_call id/);
  });

  it("(e) arguments: object=그대로 / string JSON=파싱 / 손상 string·비객체 → throw / 미설정 → {}", async () => {
    const mk = (argsWire: unknown) => [JSON.stringify({ message: { tool_calls: [{ id: "x", function: { name: "t", arguments: argsWire } }] }, done: true }) + "\n"];
    const argOf = async (argsWire: unknown) => {
      const out = await collect(makeOllamaProvider({ fetch: mockFetch(mk(argsWire)) as never }).chat(cfg, [], { tools: TOOLS }));
      return (out.find((c) => c.kind === "toolUse") as { args: unknown }).args;
    };
    expect(await argOf({ q: 1 })).toEqual({ q: 1 }); // object 그대로(실측 형태)
    expect(await argOf('{"q":2}')).toEqual({ q: 2 }); // 문자열 JSON 변종 방어
    expect(await argOf(undefined)).toEqual({}); // 인자 없는 도구
    expect(await argOf("")).toEqual({}); // 정확히 "" 만 {} (§C.2 동일)
    await expect(argOf("  ")).rejects.toThrow(/malformed tool_call arguments/); // 공백-only ≠ ""(리뷰 NIT — §C.2 정렬)
    await expect(argOf("not json")).rejects.toThrow(/malformed tool_call arguments/);
    await expect(argOf("[1]")).rejects.toThrow(/not an object/); // 문자열 JSON 배열
    await expect(argOf([1])).rejects.toThrow(/not an object/); // 실 배열(리뷰 NIT)
    await expect(argOf(7)).rejects.toThrow(/not an object/);
  });

  it("(e2) 빈 문자열 name(누락 아님) → throw / 분산 tool_calls(중간+마지막 청크 모두 유효) → 전부 순서대로 yield (리뷰 NIT)", async () => {
    const bad = [JSON.stringify({ message: { tool_calls: [{ id: "x", function: { name: "", arguments: {} } }] }, done: true }) + "\n"];
    await expect(collect(makeOllamaProvider({ fetch: mockFetch(bad) as never }).chat(cfg, [], { tools: TOOLS }))).rejects.toThrow(/tool_call missing name/);
    const dist = [
      JSON.stringify({ message: { tool_calls: [{ id: "a1", function: { name: "skill_time", arguments: {} } }] } }) + "\n",
      JSON.stringify({ message: { content: "그리고" } }) + "\n",
      JSON.stringify({ message: { tool_calls: [{ id: "a2", function: { name: "skill_weather", arguments: { city: "seoul" } } }] }, done: true }) + "\n",
    ];
    const out = await collect(makeOllamaProvider({ fetch: mockFetch(dist) as never }).chat(cfg, [], { tools: TOOLS }));
    expect(out.filter((c) => c.kind === "toolUse")).toEqual([
      { kind: "toolUse", id: "a1", name: "skill_time", args: {} },
      { kind: "toolUse", id: "a2", name: "skill_weather", args: { city: "seoul" } },
    ]); // 수신 순 보존 + 스트림 종료 후 일괄(finalize)
  });

  it("(f) 빈/누락 name → throw + 선행 toolUse 0 방출(원자성 — yield 는 finalize 에서만)", async () => {
    const lines = [
      JSON.stringify({ message: { tool_calls: [{ id: "ok1", function: { name: "good", arguments: {} } }] } }) + "\n",
      JSON.stringify({ message: { tool_calls: [{ id: "bad", function: { arguments: {} } }] }, done: true }) + "\n",
    ];
    const got: ProviderChunk[] = [];
    const gen = makeOllamaProvider({ fetch: mockFetch(lines) as never }).chat(cfg, [], { tools: TOOLS });
    await expect((async () => { for await (const c of gen) got.push(c); })()).rejects.toThrow(/tool_call missing name/);
    expect(got.filter((c) => c.kind === "toolUse")).toEqual([]); // 선행 유효 call 도 미방출
  });

  it("(g) abort commit-point: finalize 전 aborted → toolUse·usage·finish 전부 미방출", async () => {
    const ac = new AbortController();
    ac.abort();
    const lines = [JSON.stringify({ message: { content: "본문", tool_calls: [{ id: "z", function: { name: "t", arguments: {} } }] }, done: true, prompt_eval_count: 1, eval_count: 1 }) + "\n"];
    const out = await collect(makeOllamaProvider({ fetch: mockFetch(lines) as never }).chat(cfg, [], { tools: TOOLS, signal: ac.signal }));
    expect(out.filter((c) => c.kind !== "text")).toEqual([]); // 스트림 중 text 만(§C.2 모델), finalize 배치 0
  });

  it("(h) 400 'does not support tools' + tools → tools 제거 1회 재시도(text 정상); tools 없인 미재시도", async () => {
    // 1차 = 400(미지원), 2차 = 정상 스트림 — 순차 mock
    const enc = new TextEncoder();
    const bodies: Array<{ tools?: unknown }> = [];
    let call = 0;
    const seqFetch = async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      call++;
      if (call === 1) {
        let ei = 0;
        const err = ['{"error":"registry.ollama.ai/library/x does not support tools"}'];
        return {
          ok: false, status: 400, statusText: "Bad Request",
          body: { getReader: () => ({ async read() { return ei >= err.length ? { done: true } : { done: false, value: enc.encode(err[ei++]!) }; } }) },
        };
      }
      let i = 0;
      const lines = [JSON.stringify({ message: { content: "순수챗" } }) + "\n", JSON.stringify({ done: true }) + "\n"];
      return {
        ok: true, status: 200, statusText: "OK",
        body: { getReader: () => ({ async read() { return i >= lines.length ? { done: true } : { done: false, value: enc.encode(lines[i++]!) }; } }) },
      };
    };
    const out = await collect(makeOllamaProvider({ fetch: seqFetch as never }).chat(cfg, [{ role: "user", content: "hi" }], { tools: TOOLS }));
    expect(call).toBe(2);
    expect(bodies[0]!.tools).toBeDefined();
    expect(bodies[1]!.tools).toBeUndefined(); // 재시도는 tools 없이
    expect(out.some((c) => c.kind === "text" && (c as { text: string }).text === "순수챗")).toBe(true);
    expect(out[out.length - 1]).toEqual({ kind: "finish" });
    // tools 미전달인데 400 → 재시도 없이 그대로 throw (⚠️ 호출수 단언 — 리뷰 MINOR: /400/ 만으론 스퓨리어스 재시도 불가시)
    const fNoTools = mockFetch([], { ok: false, status: 400, errorBody: '{"error":"does not support tools"}' });
    const gen = makeOllamaProvider({ fetch: fNoTools as never }).chat(cfg, [], {});
    await expect(collect(gen)).rejects.toThrow(/400/);
    expect(fNoTools.bodies.length).toBe(1); // 정확히 1회 — 미재시도 실증
  });

  it("(h2) 그 외 !ok 는 오류본문 포함 throw(진단성)", async () => {
    const gen = makeOllamaProvider({ fetch: mockFetch([], { ok: false, status: 404, errorBody: '{"error":"model not found"}' }) as never }).chat(cfg, [], { tools: TOOLS });
    await expect(collect(gen)).rejects.toThrow(/404.*model not found/s);
  });
});
