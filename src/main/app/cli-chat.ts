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
  // naia 게이트웨이(lab-proxy) — provider 라우트 이름은 `nextain`(resolveProviderRoute). `naia` 는 로그인 별칭.
  nextain: "NAIA_API_KEY",
  naia: "NAIA_API_KEY",
};
// 게이트웨이 provider(resolveProviderRoute → lab-proxy): 키가 apiKey 가 아니라 **naiaKey** 슬롯에 실린다.
export const GATEWAY_PROVIDERS: ReadonlySet<string> = new Set(["nextain", "naia"]);
// 로그인 키 자동 감지 precedence(옛 direct-mode 호환: anthropic>openai>glm>gemini).
export const PROVIDER_AUTODETECT_ORDER = ["anthropic", "openai", "glm", "gemini"] as const;

export interface ChatArgs {
  readonly mode: "chat" | "login" | "workspace";
  // chat
  readonly systemPrompt?: string;
  readonly once?: string;
  readonly noTools?: boolean;
  /** UC-THINKING — 추론(thinking) 출력 on/off. 미지정=모델 기본. `--no-think` → false / `--think` → true.
   *  ⚠️ 이게 없으면 CLI 로는 추론 모델의 "생각에 예산 다 쓰고 빈 답" 결함을 재현/검증할 수 없다
   *  (셸은 gRPC 로 보내지만 CLI 엔 표면이 없었다). */
  readonly enableThinking?: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly workspace?: string;     // --workspace <path> : 이번 실행만 적용(per-invocation override)
  // login
  readonly key?: string;
  // workspace
  readonly workspacePath?: string; // `workspace <path>` : 전역 설정 저장(미지정=현재 값 출력)
}

export interface ParseResult {
  readonly ok: boolean;
  readonly args?: ChatArgs;
  readonly help?: boolean;
  readonly error?: string;
}

export const CHAT_USAGE = `naia-agent chat — naia-agent 단독 대화(멀티턴 REPL) + 로그인 + 워크스페이스

사상: 1기기=1설정=단일 워크스페이스. LLM/스킬/기억 설정은 워크스페이스(<ws>/naia-settings/)에서
로딩된다. 워크스페이스 아래 다중 프로젝트가 사상(프로젝트별 설정 아님).

사용법:
  naia-agent-chat [chat] [--system <prompt>] [--once <message>] [--no-tools]
                          [--no-think | --think]
                          [--provider <p>] [--model <id>] [--workspace <ws>]
  naia-agent-chat login --provider <p> [--key <value>]        # 없으면 stdin 으로 키 입력
  naia-agent-chat workspace [<path>]                          # <path>: 전역 워크스페이스 저장 / 없음: 현재 값 출력

대화(chat):
  naia-os 없이 터미널에서 naia-agent 와 멀티턴 대화. provider/도구/기억/대화조립은
  naia-os gRPC 경로와 **동일 코어(wireAgentUC1)** — transport 만 stdin/readline.
  provider 선택 우선순위: --provider/--model > naia-settings(llm.json/config.json) > 로그인 키 자동감지.
  워크스페이스 우선순위: --workspace > NAIA_ADK_PATH env > 전역 config > 기본 ~/naia-adk.
  빈 줄/ Ctrl+C(턴 중)=현재 턴 취소, Ctrl+D(EOF)=종료.

워크스페이스(workspace):
  단일 device 워크스페이스를 전역('~/.naia-agent/config.json')에 고정. 이후 모든 CLI 실행이
  같은 워크스페이스에서 LLM/설정을 로딩. 예: naia-agent-chat workspace D:\\naia-adk

로그인(login):
  provider 키를 ~/.naia-agent/.env (0600) 에 저장 → 이후 키 인자 없이 chat.
  provider: anthropic | openai | glm | gemini | vertex | naia

옵션:
  --system <p>    시스템 프롬프트(persona) 지정
  --once <msg>    단발 메시지 1회 처리 후 종료(파이프/스크립트용)
  --no-tools      도구(스킬) 비활성 — 순수 대화
  --no-think      추론(thinking) 출력 끔 — 추론 모델이 생각에 출력 토큰을 다 쓰고
                  본문을 못 내는 것을 막는다(로컬 ollama/vLLM 에만 적용, UC-THINKING)
  --think         추론 출력 켬. 미지정 = 모델 기본
  --provider <p>  provider 강제(anthropic/openai/glm/gemini/vertex/nextain)
  --model <id>    모델 강제
  --workspace <w> 워크스페이스(ADK) 경로 — 이번 실행만 적용(전역 저장 안 함)
  --key <v>       (login) ⚠️ argv 는 ps/셸 히스토리에 노출됨 — 생략 시 stdin 입력 권장
  -h, --help      이 도움말`;

/** argv(서브커맨드 포함) → ChatArgs. mode=chat(기본) | login | workspace. */
export function parseChatArgs(argv: readonly string[]): ParseResult {
  const a = [...argv];
  if (a.includes("-h") || a.includes("--help")) return { ok: false, help: true, error: CHAT_USAGE };

  let mode: "chat" | "login" | "workspace" = "chat";
  if (a[0] === "login") { mode = "login"; a.shift(); }
  else if (a[0] === "workspace") { mode = "workspace"; a.shift(); }
  else if (a[0] === "chat") { a.shift(); }

  // workspace 모드: `workspace <path>`(전역 저장) 또는 `workspace`(현재 값 출력). 다른 플래그 无.
  if (mode === "workspace") {
    const wp = a[0];
    return { ok: true, args: { mode, ...(wp !== undefined ? { workspacePath: wp } : {}) } };
  }

  let systemPrompt: string | undefined;
  let once: string | undefined;
  let noTools = false;
  let enableThinking: boolean | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let workspace: string | undefined;
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
      // UC-THINKING: 추론 출력 제어. 미지정 시 필드 자체를 안 실어 모델 기본을 유지(무회귀).
      case "--no-think": enableThinking = false; break;
      case "--think": enableThinking = true; break;
      case "--provider": { const v = needsValue(); if (v === undefined) return { ok: false, error: `${t} 에 값이 필요합니다` }; provider = v; break; }
      case "--model": { const v = needsValue(); if (v === undefined) return { ok: false, error: `${t} 에 값이 필요합니다` }; model = v; break; }
      case "--workspace": { const v = needsValue(); if (v === undefined) return { ok: false, error: `${t} 에 값이 필요합니다` }; workspace = v; break; }
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
      ...(enableThinking !== undefined ? { enableThinking } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
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

/**
 * workspace(ADK) 경로 우선순위 해석(순수). 사상: **1기기=1설정=단일 workspace** — LLM/스킬/기억 설정이
 * workspace({adkPath}/naia-settings/) 에서 로딩된다. 우선순위:
 *   (1) `--workspace <path>` 플래그(이번 실행만)
 *   (2) `NAIA_ADK_PATH` env
 *   (3) 전역 config(`~/.naia-agent/config.json` adkPath) — **단일 device workspace 고정**
 *   (4) 기본 `<defaultPath>`(host 가 `~/naia-adk` 주입)
 * host 가 이 결과를 NAIA_ADK_PATH 에 올려 composeAgentRuntimeDeps 가 workspace-의존 LLM 로딩을 하게 함.
 */
export function resolveAdkPath(opts: { flag?: string; env?: string; global?: string; defaultPath: string }): string {
  return opts.flag ?? opts.env ?? opts.global ?? opts.defaultPath;
}

/**
 * 전역 CLI config(`~/.naia-agent/config.json`) 의 adkPath upsert(순수). 기존 JSON 보존(다른 키 유지),
 * 손상시 초기화. 단일 device workspace 를 고정 — CLI 가 매 실행 같은 workspace 에서 LLM/설정을 로딩.
 */
export function setGlobalConfigAdk(current: string | null, adkPath: string): string {
  let obj: Record<string, unknown> = {};
  if (current) {
    try { obj = JSON.parse(current) as Record<string, unknown>; } catch { /* 손상 → 폐기 후 재구성 */ obj = {}; }
  }
  obj["adkPath"] = adkPath;
  return JSON.stringify(obj, null, 2) + "\n";
}

/** 전역 config 에서 adkPath 만 읽기(순수). 미설정/손상 = undefined. */
export function readGlobalConfigAdk(current: string | null): string | undefined {
  if (!current) return undefined;
  try {
    const obj = JSON.parse(current) as Record<string, unknown>;
    return typeof obj["adkPath"] === "string" ? obj["adkPath"] : undefined;
  } catch { return undefined; }
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
  // 1) 명시 --provider
  if (argProvider) {
    const model = argModel ?? PROVIDER_DEFAULT_MODEL[argProvider];
    if (!model) return { ok: false, error: `provider '${argProvider}' 는 기본 모델이 없습니다 — --model <id> 를 지정하세요.` };
    if (GATEWAY_PROVIDERS.has(argProvider)) {
      // 게이트웨이(lab-proxy): 키는 naiaKey 슬롯. apiKey 미부여(직결 provider 와 키 슬롯 다름).
      const nk = envKey("NAIA_API_KEY");
      return { ok: true, source: "flag", config: { provider: argProvider, model, ...(nk ? { naiaKey: nk } : {}) } };
    }
    const env = apiKeyEnvFor(argProvider);
    const apiKey = env ? envKey(env) : undefined;
    // ⚠️ naiaKey 는 게이트웨이 전용 — 직결 provider config 에 끼워넣지 않는다(무관 자격증명 ride-along 방지, 적대리뷰 L2).
    return { ok: true, source: "flag", config: { provider: argProvider, model, ...(apiKey ? { apiKey } : {}) } };
  }
  // 2) naia-settings defaultConfig (apiKey/naiaKey 이미 resolve). --model 만 override 허용.
  if (defaultConfig) {
    return { ok: true, source: "naia-settings", config: { ...defaultConfig, ...(argModel ? { model: argModel } : {}) } };
  }
  // 3) 로그인 키 자동감지(precedence) — 직결 API-key provider 만(게이트웨이는 명시 --provider nextain 필요).
  for (const p of PROVIDER_AUTODETECT_ORDER) {
    const env = apiKeyEnvFor(p);
    const apiKey = env ? envKey(env) : undefined;
    if (!apiKey) continue;
    const model = argModel ?? PROVIDER_DEFAULT_MODEL[p];
    if (!model) continue; // 기본 모델 없는 provider 는 --model 없이 자동선택 안 함
    return { ok: true, source: `auto(${env})`, config: { provider: p, model, apiKey } };
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
  /** UC-THINKING — 추론 출력 on/off. 미지정 = 필드 미전송(모델 기본, 무회귀). */
  enableThinking?: boolean;
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
  let turnStartLen = 0; // submit 직전 history 길이 — cancel/error/빈-finish 시 이 지점으로 되돌려 턴 통째 폐기.
  let onTurnEnd: ((info: { kind: "finish" | "error" | "cancel"; text: string; error?: string }) => void) | null = null;

  const ingress: AgentIngressPort = {
    onRequest: (cb) => { routeCb = cb; return () => { routeCb = null; }; },
  };

  const submit = (line: string): boolean => {
    const text = line.trim();
    if (!text) { opts.io.prompt(); return false; }
    if (activeReqId) return false; // 턴 진행 중 입력 무시(단일 턴 직렬)
    if (!routeCb) return false;    // wireAgentUC1.start() 전
    turnStartLen = history.length; // 폐기 복원점(user push 직전)
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
      ...(opts.enableThinking !== undefined ? { enableThinking: opts.enableThinking } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    };
    routeCb(req);
    return true;
  };

  const endTurn = (kind: "finish" | "error" | "cancel", error?: string) => {
    // ⚠️ history 는 **완료된 user/assistant 쌍만** 보존(agent 기억의 finished-only 와 정합, 적대리뷰 H2/H3).
    //   finish + 비어있지 않은 응답 → assistant 추가(쌍 완성). 그 외(cancel·error·빈 finish) → 턴 통째 폐기
    //   (user 메시지까지 복원점으로 되감음) — 빈 assistant 메시지나 연속 user 가 wire transcript 를 오염시켜
    //   엄격 provider(Anthropic Messages 등)가 거부하거나 맥락이 비결정적으로 갈리는 것을 차단.
    if (kind === "finish" && acc.trim() !== "") {
      history.push({ role: "assistant", content: acc });
    } else {
      history.length = turnStartLen;
    }
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
        case "error": opts.io.write(`\n\x1b[31m[오류] ${e.message}\x1b[0m\n`); endTurn("error", e.message); break; // 폐기(endTurn)
        case "finish": opts.io.write("\n"); endTurn("finish"); break; // assistant push 는 endTurn 이 담당(빈 응답 가드)
        default: break; // usage/log/compacted 등 비-terminal — 조용
      }
    },
  };

  const cancel = (): string | null => {
    if (!activeReqId) return null;
    const id = activeReqId;
    routeCb?.({ kind: "cancel", requestId: id }); // 같은 파이프라인: handler 가 provider 스트림 abort
    opts.io.write("\n\x1b[2m[취소됨]\x1b[0m\n");
    endTurn("cancel"); // 턴 통째 폐기(부분 응답은 화면엔 남되 history 엔 안 남김 = 기억과 정합)
    return id;
  };

  return {
    ingress, egress, submit, cancel,
    isBusy: () => activeReqId !== null,
    setOnTurnEnd: (fn) => { onTurnEnd = fn; },
    history,
  };
}
