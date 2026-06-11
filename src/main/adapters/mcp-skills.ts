// adapters/mcp-skills — S25 MCP(Model Context Protocol) 클라이언트 스킬 ToolExecutorPort(동적 도구). 계약 §G.
// MCP 서버(사용자 설정)를 JSON-RPC(initialize/tools-list/tools-call)로 연결해 그 도구를 agent 도구로 노출.
// transport 주입(코어 순수 — stdio/SSE 연결·framing·id상관·바이트한도는 어댑터). 보수적 tier(기본 ask)·다층 검증.
import type { ToolExecutorPort } from "../ports/uc1.js";
import type { ToolSpec, ToolCall } from "../domain/chat.js";
import { isAborted } from "./signal-util.js";

// JSON-RPC 레벨 transport(주입). request=요청→result(에러/abort/바이트한도 시 reject). notify=알림(signal 받음·await).
export interface McpTransport {
  request(method: string, params: unknown, opts: { signal?: AbortSignal }): Promise<unknown>;
  notify(method: string, params: unknown, opts?: { signal?: AbortSignal }): Promise<void>;
}
export interface McpDeps {
  transport: McpTransport;
  serverName: string;
  defaultTier?: string;
  clientInfo?: { name: string; version: string };
  maxTools?: number;
  initSignal?: AbortSignal;
  initTimeoutMs?: number;
}

const SUPPORTED_VERSION = "2025-06-18"; // MCP protocol 버전(클라이언트 제시)
const DEFAULT_MAX_TOOLS = 100, MAX_TOOLS_CAP = 1000;
const DEFAULT_INIT_TIMEOUT = 10000, MAX_INIT_TIMEOUT = 120000;
const MAX_PAGES = 50, MAX_OUT = 8000;
const VALID_TIERS = new Set(["none", "ask"]);
const SEG = /^[A-Za-z0-9_.-]+$/; // serverName/tool 식별자 문자

const ok = (output: string) => ({ output });
const err = (output: string) => ({ output, isError: true });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function safeMsg(e: unknown): string {
  try { if (e !== null && typeof e === "object") { const m = (e as { message?: unknown }).message; if (typeof m === "string") return m; } } catch { /* getter throw */ }
  try { return String(e); } catch { return "tool error"; }
}
// 정규화: 유한 양의 정수 강제.
function normInt(v: unknown, def: number, cap: number): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? Math.min(v, cap) : def;
}
function normTimeout(v: unknown, def: number, cap: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(v, cap) : def;
}

// initSignal + timeout 을 결합한 단일 abort 신호(둘 중 먼저). 타이머 정리 cleanup 반환.
function combinedDeadline(initSignal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const ac = new AbortController();
  const onAbort = () => { try { ac.abort(); } catch { /* noop */ } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (initSignal) {
    if (isAborted(initSignal)) ac.abort();
    else { try { initSignal.addEventListener("abort", onAbort, { once: true }); } catch { /* noop */ } }
  }
  if (!ac.signal.aborted) timer = setTimeout(onAbort, timeoutMs);
  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer);
    if (initSignal) { try { initSignal.removeEventListener("abort", onAbort); } catch { /* noop */ } }
  };
  return { signal: ac.signal, cleanup };
}

// 경량 arg 검증(전체 JSON-schema 아님 — 서버 최종책임): required 키 존재 + 최상위 primitive type 일치만.
function validateArgs(args: Record<string, unknown>, schema: unknown): string | null {
  if (!isObj(schema)) return null; // 스키마 불명 = 통과(서버 검증)
  const req = schema.required;
  const props = isObj(schema.properties) ? schema.properties : undefined;
  if (Array.isArray(req)) {
    for (const k of req) { if (typeof k === "string" && !Object.prototype.hasOwnProperty.call(args, k)) return `missing required arg: ${k}`; } // own prop만(상속 prop 은 직렬화서 사라짐)
  }
  if (props) {
    for (const [k, v] of Object.entries(args)) {
      const ps = props[k];
      const t = isObj(ps) ? ps.type : undefined;
      if (typeof t !== "string") continue; // 타입 미지정/복합 = skip
      const actual = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
      const matches =
        (t === "string" && actual === "string") ||
        (t === "number" && actual === "number") ||
        (t === "integer" && actual === "number" && Number.isInteger(v)) ||
        (t === "boolean" && actual === "boolean") ||
        (t === "object" && actual === "object") ||
        (t === "array" && actual === "array") ||
        (t === "null" && actual === "null");
      if (!matches) return `arg ${k} type mismatch (expected ${t})`;
    }
  }
  return null;
}

// tools/call result.content[] → text 추출(비-text 표기). 최종 출력 길이 ≤ MAX_OUT 보장(marker 공간 예약).
const OUT_MARK = "…(생략)";
function extractContent(content: unknown[]): string {
  const parts: string[] = [];
  let total = 0;
  for (const block of content) {
    if (total >= MAX_OUT) break; // 이미 충분 — 더 모으지 않음(증분 bound)
    const piece = isObj(block) && block.type === "text" && typeof block.text === "string" ? block.text : "[non-text 생략]";
    parts.push(piece);
    total += piece.length + 1;
  }
  const joined = parts.join("\n");
  return joined.length > MAX_OUT ? joined.slice(0, MAX_OUT - OUT_MARK.length) + OUT_MARK : joined; // marker 포함 ≤ MAX_OUT
}

/** §G ToolExecutorPort 구현. **async 팩토리** — initialize+tools/list 발견 후 반환. */
export async function makeMcpSkillsExecutor(deps: McpDeps): Promise<ToolExecutorPort> {
  const { transport, serverName } = deps;
  if (!transport || typeof serverName !== "string" || !SEG.test(serverName)) {
    throw new Error("mcp: invalid deps (transport/serverName)");
  }
  const maxTools = normInt(deps.maxTools, DEFAULT_MAX_TOOLS, MAX_TOOLS_CAP);
  const initTimeout = normTimeout(deps.initTimeoutMs, DEFAULT_INIT_TIMEOUT, MAX_INIT_TIMEOUT);
  const tier = typeof deps.defaultTier === "string" && VALID_TIERS.has(deps.defaultTier) ? deps.defaultTier : "ask";
  const clientInfo = deps.clientInfo ?? { name: "naia-agent", version: "0" };

  const specs: ToolSpec[] = [];
  const nameMap = new Map<string, string>();   // exposed → 원본 MCP tool name
  const schemaMap = new Map<string, unknown>(); // exposed → inputSchema(경량 검증용)

  const { signal: initSig, cleanup } = combinedDeadline(deps.initSignal, initTimeout);
  try {
    // (1) initialize + 검증
    const init = await transport.request("initialize", { protocolVersion: SUPPORTED_VERSION, capabilities: {}, clientInfo }, { signal: initSig });
    if (!isObj(init)) throw new Error("mcp: malformed initialize result");
    if (typeof init.protocolVersion !== "string") throw new Error("mcp: missing protocolVersion");
    if (!isObj(init.capabilities)) throw new Error("mcp: missing capabilities");
    if (!isObj(init.serverInfo)) throw new Error("mcp: missing serverInfo");
    // (2) initialized 알림 — 게이트/ tools-list 전 await(순서·실패 포착, deadline signal)
    await transport.notify("notifications/initialized", undefined, { signal: initSig });
    // (3) capabilities.tools 광고된 경우만 tools/list, 아니면 빈 specs
    if (isObj(init.capabilities.tools)) {
      // (4) tools/list 페이지네이션(cursor 순환·maxPages 차단)
      const seen = new Set<string>();         // 본 cursor(순환 차단)
      const allExposed = new Set<string>();    // 본 exposed name 전체(cap 무관 dup 결정적 reject)
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        if (pages >= MAX_PAGES) throw new Error("mcp: too many tools/list pages");
        pages++;
        const page = await transport.request("tools/list", cursor === undefined ? {} : { cursor }, { signal: initSig });
        if (!isObj(page) || !Array.isArray(page.tools)) throw new Error("mcp: malformed tools/list");
        // 페이지 전체 검사(cap 도달해도 잔여 tool 의 dup 검출 위해 break 안 함). 노출은 maxTools 까지만.
        for (const tdef of page.tools) {
          if (!isObj(tdef) || typeof tdef.name !== "string" || tdef.name === "" || !SEG.test(tdef.name)) continue; // 손상 tool skip
          const sch = tdef.inputSchema;
          if (!isObj(sch) || (sch.type !== undefined && sch.type !== "object")) continue; // object schema 만(type:"string" 등 비-object skip)
          const exposed = `mcp__${serverName}__${tdef.name}`;
          if (allExposed.has(exposed)) throw new Error(`mcp: duplicate exposed tool name ${exposed}`); // 결정적 reject(순서/cap 무관)
          allExposed.add(exposed);
          if (specs.length < maxTools) { // 노출은 cap 까지만
            nameMap.set(exposed, tdef.name);
            schemaMap.set(exposed, sch);
            specs.push({ name: exposed, description: typeof tdef.description === "string" ? tdef.description : "", parameters: sch, tier });
          }
        }
        if (specs.length >= maxTools) break; // cap 도달 = 추가 페이지 안 받음
        const nc = page.nextCursor;
        if (nc === undefined || nc === null) break;
        if (typeof nc !== "string" || nc === "") throw new Error("mcp: invalid nextCursor");
        if (seen.has(nc)) throw new Error("mcp: cursor cycle"); // 반복 cursor → 무한루프 차단
        seen.add(nc);
        cursor = nc;
      }
    }
  } finally {
    cleanup();
  }

  return {
    specs: () => specs,
    async execute(call: ToolCall, opts: { signal?: AbortSignal }): Promise<{ output: string; isError?: boolean }> {
      let signal: AbortSignal | undefined;
      let aborted = false;
      const abortGuard = () => { if (isAborted(signal)) { aborted = true; throw new Error("aborted"); } };
      try {
        signal = opts?.signal;
        abortGuard();
        const original = nameMap.get(call.name);
        if (original === undefined) return err(`unknown tool: ${call.name}`); // 미등록·prefix 위조
        if (!isObj(call.args)) return err("args must be object");
        const ve = validateArgs(call.args, schemaMap.get(call.name));
        if (ve) return err(ve);
        abortGuard(); // (request 직전)
        const res = await transport.request("tools/call", { name: original, arguments: call.args }, { ...(signal ? { signal } : {}) });
        abortGuard(); // (request 직후 — 마지막 호출 후 abort 도 reject)
        if (!isObj(res)) return err("malformed tool result");
        if (!Array.isArray(res.content)) return err("malformed tool result (content required)"); // MCP 규약: content 필수
        const text = extractContent(res.content);
        return res.isError === true ? err(text || "tool error") : ok(text);
      } catch (e) {
        if (aborted || isAborted(signal)) throw e instanceof Error ? e : new Error("aborted"); // abort(flag 우선) → reject
        return err(safeMsg(e)); // 비-abort = isError(no-throw)
      }
    },
  };
}
