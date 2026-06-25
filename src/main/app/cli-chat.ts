// app/cli-chat — UC-CLI S1(대화) host 의 **순수 로직**: argv 파싱 · 멀티턴 REPL 컨트롤러(history+ingress/egress)
// · provider config 선택 · login .env upsert. process I/O·readline·fs 는 bin/naia-agent-chat.mjs(host) 가 주입.
// ⚠️ 같은 파이프라인(NFR-CLI-shared): 여기서 만드는 ingress/egress 는 gRPC 와 **동일 `wireAgentUC1`** 에 주입되는
//    AgentIngressPort/AgentEgressPort 어댑터다. 별도 대화 엔진/도구루프 신설 아님 — transport 표면만 stdio/readline.
import type { AgentIngressPort, AgentEgressPort } from "../ports/uc1.js";
import type { AgentRequest, AgentEmit, ChatMessage, ProviderConfig } from "../domain/chat.js";

// ── provider → 기본 모델 / api-key env 이름 (login·auto-detect·flag 기본값) ──
// 기본 모델: naia main=gemini-3.1-flash-lite, anthropic=claude-sonnet-4-6(메모리 정본). 그 외는 --model 필수.
export const PROVIDER_DEFAULT_MODEL: Readonly<Record<string, string>> = {
  anthropic: "claude-sonnet-4-6",
  gemini: "gemini-3.1-flash-lite",
};
export const PROVIDER_API_KEY_ENV: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  glm: "ZHIPUAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  vertex: "GOOGLE_APPLICATION_CREDENTIALS",
  naia: "NAIA_API_KEY",
};
// 로그인 키 자동 감지 precedence(옛 direct-mode 호환: anthropic>openai>glm>gemini).
export const PROVIDER_AUTODETECT_ORDER = ["anthropic", "openai", "glm", "gemini"] as const;

export interface ChatArgs {
  readonly mode: "chat" | "login";
  // chat
  readonly systemPrompt?: string;
  readonly once?: string;     // 단발 메시지(파이프/스크립트) — 처리 후 종료
  readonly noTools?: boolean;
  readonly provider?: string; // --provider override
  readonly model?: string;    // --model override
  // login
  readonly key?: string;      // --key (없으면 host 가 stdin 프롬프트)
}

export interface ParseResult {
  readonly ok: boolean;
  readonly args?: ChatArgs;
  readonly help?: boolean;
  readonly error?: string;
}

export const CHAT_USAGE = `naia-agent chat — naia-agent 단독 대화(멀티턴 REPL) + 로그인

사용법:
  naia-agent-chat [chat] [--system <prompt>] [--once <message>] [--no-tools]
                          [--provider <p>] [--model <id>]
  naia-agent-chat login --provider <p> [--key <value>]   # 없으면 stdin 으로 키 입력

대화(chat):
  naia-os 없이 터미널에서 naia-agent 와 멀티턴 대화. provider/도구/기억/대화조립은
  naia-os gRPC 경로와 **동일 코어(wireAgentUC1)** — transport 만 stdin/readline.
  provider 선택 우선순위: --provider/--model > naia-settings(llm.json) > 로그인 키 자동감지.
  빈 줄/ Ctrl+C(턴 중)=현재 턴 취소, Ctrl+D(EOF)=종료.

로그인(login):
  provider 키를 ~/.naia-agent/.env (0600) 에 저장 → 이후 키 인자 없이 chat.
  provider: anthropic | openai | glm | gemini | vertex | naia

옵션:
  --system <p>    시스템 프롬프트(persona) 지정
  --once <msg>    단발 메시지 1회 처리 후 종료(파이프/스크립트용)
  --no-tools      도구(스킬) 비활성 — 순수 대화
  --provider <p>  provider 강제(anthropic/openai/glm/gemini/vertex)
  --model <id>    모델 강제
  -h, --help      이 도움말`;

/** argv(서브커맨드 포함) → ChatArgs. mode=chat(기본) | login. */
export function parseChatArgs(argv: readonly string[]): ParseResult {
  const a = [...argv];
  if (a.includes("-h") || a.includes("--help")) return { ok: false, help: true, error: CHAT_USAGE };

  let mode: "chat" | "login" = "chat";
  if (a[0] === "login") { mode = "login"; a.shift(); }
  else if (a[0] === "chat") { a.shift(); }

  let systemPrompt: string | undefined;
  let once: string | undefined;
  let noTools = false;
  let provider: string | undefined;
  let model: string | undefined;
  let key: string | undefined;

  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    const needsValue = (): string | undefined => {
      const v = a[i + 1];
      if (v === undefined || v.startsWith("--")) return undefined;
      i++;
      return v;
    };
    switch (t) {
      case "--system": { const v = needsValue(); if (v === undefined) return { ok: false, error: `${t} 에 값이 필요합니다` }; systemPrompt = v; break; }
      case "--once": { const v = needsValue(); if (v === undefined) return { ok: false, error: `${t} 에 값이 필요합니다` }; once = v; break; }
      case "--no-tools": noTools = true; break;
      case "--provider": { const v = needsValue(); if (v === undefined) return { ok: false, error: `${t} 에 값이 필요합니다` }; provider = v; break; }
      case "--model": { const v = needsValue(); if (v === undefined) return { ok: false, error: `${t} 에 값이 필요합니다` }; model = v; break; }
      case "--key": { const v = needsValue(); if (v === undefined) return { ok: false, error: `${t} 에 값이 필요합니다` }; key = v; break; }
      default: return { ok: false, error: `알 수 없는 인자: ${t}\n\n${CHAT_USAGE}` };
    }
  }

  if (mode === "login") {
    if (!provider) return { ok: false, error: "login 에는 --provider <p> 가 필요합니다 (anthropic/openai/glm/gemini/vertex/naia)" };
    if (!(provider in PROVIDER_API_KEY_ENV)) return { ok: false, error: `알 수 없는 provider: ${provider} (가능: ${Object.keys(PROVIDER_API_KEY_ENV).join(", ")})` };
    return { ok: true, args: { mode, provider, ...(key !== undefined ? { key } : {}) } };
  }
  return {
    ok: true,
    args: {
      mode,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(once !== undefined ? { once } : {}),
      ...(noTools ? { noTools } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
    },
  };
}

/** login 시 .env 한 줄 upsert(순수). 기존 같은 key 라인 교체, 주석·타 key 보존, 단일 trailing newline. */
export function upsertEnvLine(content: string, key: string, value: string): string {
  const lines = (content ? content.split(/\r?\n/) : []).filter((l) => !l.startsWith(key + "="));
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  lines.push(`${key}=${value}`);
  return lines.join("\n") + "\n";
}

/** provider 별 api-key env 이름(login 기록 대상 / 주입 lookup). 미지 provider=null. */
export function apiKeyEnvFor(provider: string): string | null {
  return PROVIDER_API_KEY_ENV[provider] ?? null;
}

export type ChooseResult =
  | { readonly ok: true; readonly config: ProviderConfig; readonly source: string }
  | { readonly ok: false; readonly error: string };

/**
 * 활성 provider config 선택(순수). 우선순위: 명시 flag > naia-settings(defaultConfig) > 로그인 키 자동감지.
 * envKey = api-key env lookup(host 가 ~/.naia-agent/.env 로드 후 주입). naia-settings 경로는 apiKey 가 이미 resolve 돼 있음.
 */
export function chooseProviderConfig(opts: {
  argProvider?: string;
  argModel?: string;
  defaultConfig?: ProviderConfig;
  envKey: (name: string) => string | undefined;
}): ChooseResult {
  const { argProvider, argModel, defaultConfig, envKey } = opts;
  const naiaKey = envKey("NAIA_API_KEY");
  // 1) 명시 --provider
  if (argProvider) {
    const model = argModel ?? PROVIDER_DEFAULT_MODEL[argProvider];
    if (!model) return { ok: false, error: `provider '${argProvider}' 는 기본 모델이 없습니다 — --model <id> 를 지정하세요.` };
    const env = apiKeyEnvFor(argProvider);
    const apiKey = env ? envKey(env) : undefined;
    return { ok: true, source: "flag", config: { provider: argProvider, model, ...(apiKey ? { apiKey } : {}), ...(naiaKey ? { naiaKey } : {}) } };
  }
  // 2) naia-settings defaultConfig (apiKey 이미 resolve). --model 만 override 허용.
  if (defaultConfig) {
    return { ok: true, source: "naia-settings", config: { ...defaultConfig, ...(argModel ? { model: argModel } : {}) } };
  }
  // 3) 로그인 키 자동감지(precedence)
  for (const p of PROVIDER_AUTODETECT_ORDER) {
    const env = apiKeyEnvFor(p);
    const apiKey = env ? envKey(env) : undefined;
    if (!apiKey) continue;
    const model = argModel ?? PROVIDER_DEFAULT_MODEL[p];
    if (!model) continue; // 기본 모델 없는 provider 는 --model 없이 자동선택 안 함
    return { ok: true, source: `auto(${env})`, config: { provider: p, model, apiKey, ...(naiaKey ? { naiaKey } : {}) } };
  }
  return {
    ok: false,
    error: "provider 설정 없음 — `naia-agent-chat login --provider <p> --key <k>` 로 로그인하거나, naia-settings(llm.json)를 두거나, --provider/--model 을 지정하세요.",
  };
}

// ── 멀티턴 REPL 컨트롤러 (순수 — IO 주입) ──
export interface ReplIO {
  write(s: string): void; // stdout 으로(개행 미추가)
  prompt(): void;         // 입력 프롬프트 표시
}
export interface ReplConversation {
  readonly ingress: AgentIngressPort;
  readonly egress: AgentEgressPort;
  /** 입력 한 줄 제출 — 턴 시작 시 true. 빈 줄·턴 진행중·미start = false. */
  submit(line: string): boolean;
  /** 진행 중 턴 취소(Ctrl+C) — CancelRequest 전송 + 로컬 리셋. 취소한 requestId(없으면 null). */
  cancel(): string | null;
  isBusy(): boolean;
  /** 턴 종료(finish/error/cancel) 시 1회 호출 — host 가 once-mode 종료/프롬프트에 사용. */
  setOnTurnEnd(fn: (info: { kind: "finish" | "error" | "cancel"; text: string; error?: string }) => void): void;
  /** 누적 대화 history(검사/테스트용 — 변형 금지). */
  readonly history: readonly ChatMessage[];
}

export interface ReplConversationOpts {
  io: ReplIO;
  newRequestId: () => string;
  /** ChatRequest.provider override(있으면). 보통은 미설정 — agent defaultConfig 사용("메시지만 던진다"). */
  provider?: ProviderConfig;
  systemPrompt?: string;
  enableTools?: boolean;
  sessionId?: string;
  /** thinking/도구 이벤트 표시(기본 false=조용). */
  verbose?: boolean;
}

/** AgentIngressPort/AgentEgressPort + host-side 멀티턴 history. wireAgentUC1 에 그대로 주입. */
export function makeReplConversation(opts: ReplConversationOpts): ReplConversation {
  const history: ChatMessage[] = [];
  let routeCb: ((req: AgentRequest) => void) | null = null;
  let activeReqId: string | null = null;
  let acc = "";
  let onTurnEnd: ((info: { kind: "finish" | "error" | "cancel"; text: string; error?: string }) => void) | null = null;

  const ingress: AgentIngressPort = {
    onRequest: (cb) => { routeCb = cb; return () => { routeCb = null; }; },
  };

  const submit = (line: string): boolean => {
    const text = line.trim();
    if (!text) { opts.io.prompt(); return false; }
    if (activeReqId) return false; // 턴 진행 중 입력 무시(단일 턴 직렬)
    if (!routeCb) return false;    // wireAgentUC1.start() 전
    history.push({ role: "user", content: text });
    const requestId = opts.newRequestId();
    activeReqId = requestId; acc = "";
    const req = {
      kind: "chat" as const,
      requestId,
      messages: [...history],
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.enableTools !== undefined ? { enableTools: opts.enableTools } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    };
    routeCb(req);
    return true;
  };

  const endTurn = (kind: "finish" | "error" | "cancel", error?: string) => {
    const text = acc;
    activeReqId = null; acc = "";
    onTurnEnd?.({ kind, text, ...(error !== undefined ? { error } : {}) });
    opts.io.prompt();
  };

  const egress: AgentEgressPort = {
    emit: (requestId, e: AgentEmit) => {
      if (requestId !== activeReqId) return; // 취소·종료된 잔류 emit 무시(터미널 불변식)
      switch (e.kind) {
        case "text": acc += e.text; opts.io.write(e.text); break;
        case "thinking": if (opts.verbose) opts.io.write(`\x1b[2m${e.text}\x1b[0m`); break;
        case "toolUse": if (opts.verbose) opts.io.write(`\n\x1b[2m[도구 호출] ${e.toolName}\x1b[0m\n`); break;
        case "toolResult": if (opts.verbose) opts.io.write(`\x1b[2m[도구 결과] ${e.toolName} ${e.success ? "ok" : "실패"}\x1b[0m\n`); break;
        case "error": opts.io.write(`\n\x1b[31m[오류] ${e.message}\x1b[0m\n`); history.push({ role: "assistant", content: acc }); endTurn("error", e.message); break;
        case "finish": history.push({ role: "assistant", content: acc }); opts.io.write("\n"); endTurn("finish"); break;
        default: break; // usage/log/compacted 등 비-terminal — 조용
      }
    },
  };

  const cancel = (): string | null => {
    if (!activeReqId) return null;
    const id = activeReqId;
    routeCb?.({ kind: "cancel", requestId: id }); // 같은 파이프라인: handler 가 provider 스트림 abort
    history.push({ role: "assistant", content: acc }); // 부분 응답 보존
    opts.io.write("\n\x1b[2m[취소됨]\x1b[0m\n");
    endTurn("cancel");
    return id;
  };

  return {
    ingress, egress, submit, cancel,
    isBusy: () => activeReqId !== null,
    setOnTurnEnd: (fn) => { onTurnEnd = fn; },
    history,
  };
}
