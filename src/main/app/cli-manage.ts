// app/cli-manage — UC-023 / SPEC-019 first-class CLI 관리 표면의 순수 정책.
// argv/config/credential text/model catalog/transcript를 결정론적으로 다룬다.
// fs, TTY, OS keychain, HTTP, process는 bin/naia-agent-manage.mjs host가 주입한다.
import type { ChatMessage } from "../domain/chat.js";

export const CLI_CONFIG_KEYS = [
  "workspace",
  "coding.agent",
  "coding.model",
  "coding.tools",
] as const;
export type CliConfigKey = (typeof CLI_CONFIG_KEYS)[number];

export interface CliCodingConfig {
  readonly agent?: string;
  readonly model?: string;
  readonly tools?: boolean;
}
export interface CliGlobalConfig {
  readonly adkPath?: string;
  readonly coding?: CliCodingConfig;
  readonly [key: string]: unknown;
}

export type ManageArgs =
  | { readonly command: "auth"; readonly action: "status"; readonly provider?: string; readonly json: boolean }
  | { readonly command: "auth"; readonly action: "login"; readonly provider: string; readonly key?: string }
  | { readonly command: "auth"; readonly action: "logout"; readonly provider: string }
  | { readonly command: "config"; readonly action: "list"; readonly json: boolean }
  | { readonly command: "config"; readonly action: "get"; readonly key: CliConfigKey; readonly json: boolean }
  | { readonly command: "config"; readonly action: "set"; readonly key: CliConfigKey; readonly value: string }
  | { readonly command: "config"; readonly action: "reset"; readonly key?: CliConfigKey }
  | { readonly command: "models"; readonly provider?: string; readonly json: boolean }
  | { readonly command: "doctor"; readonly json: boolean }
  | { readonly command: "session"; readonly action: "list"; readonly limit: number; readonly json: boolean }
  | { readonly command: "session"; readonly action: "show"; readonly sessionId: string; readonly json: boolean }
  | { readonly command: "session"; readonly action: "resume"; readonly sessionId: string };

export type ManageParseResult =
  | { readonly ok: true; readonly args: ManageArgs }
  | { readonly ok: false; readonly error: string; readonly help?: boolean };

export const MANAGE_USAGE = `naia-agent 관리 명령

  naia-agent auth status [--provider <p>] [--json]
  naia-agent auth login --provider <p> [--key <value>]
  naia-agent auth logout --provider <p>
  naia-agent config list [--json]
  naia-agent config get <key> [--json]
  naia-agent config set <key> <value>
  naia-agent config reset [<key>]
  naia-agent models [provider] [--json]
  naia-agent doctor [--json]
  naia-agent session list [--limit <n>] [--json]
  naia-agent session show <id> [--json]
  naia-agent session resume <id>

config key: workspace | coding.agent | coding.model | coding.tools`;

const PROVIDER_CREDENTIAL: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  glm: "GLM_API_KEY",
  zai: "GLM_API_KEY",
  gemini: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
  vertex: "GOOGLE_APPLICATION_CREDENTIALS",
  naia: "NAIA_ANYLLM_API_KEY",
  nextain: "NAIA_ANYLLM_API_KEY",
};

export function credentialNameForProvider(provider: string): string | null {
  return PROVIDER_CREDENTIAL[provider.trim().toLowerCase()] ?? null;
}

function valueAfter(argv: readonly string[], index: number, flag: string): string | ManageParseResult {
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--")
    ? { ok: false, error: `${flag} 값이 필요합니다` }
    : value;
}

function parseJsonFlag(tokens: readonly string[]): { json: boolean; rest: string[] } {
  return { json: tokens.includes("--json"), rest: tokens.filter((x) => x !== "--json") };
}

function asConfigKey(raw: string | undefined): CliConfigKey | null {
  return CLI_CONFIG_KEYS.includes(raw as CliConfigKey) ? raw as CliConfigKey : null;
}

/** management command argv parser. Legacy `login`/`workspace` alias rewriting is dispatcher-owned. */
export function parseManageArgs(argv: readonly string[]): ManageParseResult {
  if (argv.includes("-h") || argv.includes("--help") || argv[0] === "help") {
    return { ok: false, help: true, error: MANAGE_USAGE };
  }
  const command = argv[0];
  if (command === "auth") {
    const action = argv[1] ?? "status";
    const tail = argv.slice(2);
    let provider: string | undefined;
    let key: string | undefined;
    let json = false;
    for (let i = 0; i < tail.length; i++) {
      const token = tail[i];
      if (token === "--json") { json = true; continue; }
      if (token === "--provider") {
        const value = valueAfter(tail, i, token);
        if (typeof value !== "string") return value;
        provider = value.toLowerCase(); i++; continue;
      }
      if (token === "--key") {
        const value = valueAfter(tail, i, token);
        if (typeof value !== "string") return value;
        key = value; i++; continue;
      }
      return { ok: false, error: `알 수 없는 auth 인자: ${token}` };
    }
    if (!["status", "login", "logout"].includes(action)) return { ok: false, error: `알 수 없는 auth 동작: ${action}` };
    if (provider && !credentialNameForProvider(provider)) return { ok: false, error: `지원하지 않는 provider: ${provider}` };
    if (action === "status") return { ok: true, args: { command, action, ...(provider ? { provider } : {}), json } };
    if (!provider) return { ok: false, error: `auth ${action}에는 --provider <p>가 필요합니다` };
    if (action === "login") return { ok: true, args: { command, action, provider, ...(key !== undefined ? { key } : {}) } };
    return { ok: true, args: { command, action: "logout", provider } };
  }
  if (command === "config") {
    const action = argv[1] ?? "list";
    const { json, rest } = parseJsonFlag(argv.slice(2));
    if (action === "list") {
      if (rest.length) return { ok: false, error: `config list의 알 수 없는 인자: ${rest[0]}` };
      return { ok: true, args: { command, action, json } };
    }
    if (action === "get") {
      const key = asConfigKey(rest[0]);
      if (!key || rest.length !== 1) return { ok: false, error: "config get에는 유효한 key 하나가 필요합니다" };
      return { ok: true, args: { command, action, key, json } };
    }
    if (action === "set") {
      const key = asConfigKey(rest[0]);
      if (!key || rest[1] === undefined || rest.length !== 2) return { ok: false, error: "config set에는 <key> <value>가 필요합니다" };
      return { ok: true, args: { command, action, key, value: rest[1] } };
    }
    if (action === "reset") {
      const key = rest.length ? asConfigKey(rest[0]) : undefined;
      if (rest.length > 1 || (rest.length === 1 && !key)) return { ok: false, error: "config reset key가 올바르지 않습니다" };
      return { ok: true, args: { command, action, ...(key ? { key } : {}) } };
    }
    return { ok: false, error: `알 수 없는 config 동작: ${action}` };
  }
  if (command === "models") {
    const { json, rest } = parseJsonFlag(argv.slice(1));
    if (rest.length > 1 || rest.some((x) => x.startsWith("--"))) return { ok: false, error: "models [provider] [--json] 형식이 아닙니다" };
    return { ok: true, args: { command, ...(rest[0] ? { provider: rest[0].toLowerCase() } : {}), json } };
  }
  if (command === "doctor") {
    const { json, rest } = parseJsonFlag(argv.slice(1));
    if (rest.length) return { ok: false, error: `doctor의 알 수 없는 인자: ${rest[0]}` };
    return { ok: true, args: { command, json } };
  }
  if (command === "session") {
    const action = argv[1] ?? "list";
    const { json, rest } = parseJsonFlag(argv.slice(2));
    if (action === "list") {
      let limit = 20;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] !== "--limit") return { ok: false, error: `session list의 알 수 없는 인자: ${rest[i]}` };
        const raw = rest[++i];
        const n = Number(raw);
        if (!Number.isSafeInteger(n) || n < 1 || n > 200) return { ok: false, error: "--limit은 1..200 정수여야 합니다" };
        limit = n;
      }
      return { ok: true, args: { command, action, limit, json } };
    }
    if (action === "show" || action === "resume") {
      if (rest.length !== 1 || !isSafeSessionId(rest[0])) return { ok: false, error: `session ${action}에는 안전한 session id 하나가 필요합니다` };
      return { ok: true, args: { command, action, sessionId: rest[0], ...(action === "show" ? { json } : {}) } as ManageArgs };
    }
    return { ok: false, error: `알 수 없는 session 동작: ${action}` };
  }
  return { ok: false, error: `알 수 없는 관리 명령: ${command ?? "(없음)"}\n\n${MANAGE_USAGE}` };
}

export function parseCliConfig(text: string | null): CliGlobalConfig {
  if (!text) return {};
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function getCliConfigValue(config: CliGlobalConfig, key: CliConfigKey): string | boolean | undefined {
  if (key === "workspace") return typeof config.adkPath === "string" ? config.adkPath : undefined;
  const name = key.slice("coding.".length) as keyof CliCodingConfig;
  const value = config.coding?.[name];
  if (name === "tools") return typeof value === "boolean" ? value : undefined;
  return typeof value === "string" ? value : undefined;
}

function parseBoolean(raw: string): boolean | null {
  if (["true", "1", "on", "yes"].includes(raw.toLowerCase())) return true;
  if (["false", "0", "off", "no"].includes(raw.toLowerCase())) return false;
  return null;
}

export function setCliConfigValue(config: CliGlobalConfig, key: CliConfigKey, raw: string):
  | { readonly ok: true; readonly config: CliGlobalConfig }
  | { readonly ok: false; readonly error: string } {
  const value = raw.trim();
  if (!value) return { ok: false, error: `${key} 값은 비울 수 없습니다` };
  if (key === "workspace") return { ok: true, config: { ...config, adkPath: value } };
  const coding = { ...(config.coding ?? {}) };
  if (key === "coding.tools") {
    const bool = parseBoolean(value);
    if (bool === null) return { ok: false, error: "coding.tools는 true 또는 false여야 합니다" };
    coding.tools = bool;
  } else if (key === "coding.agent") {
    if (!["pi", "shell", "opencode", "claude-code", "codex", "gemini"].includes(value)) {
      return { ok: false, error: `지원하지 않는 coding.agent: ${value}` };
    }
    coding.agent = value;
  } else {
    coding.model = value;
  }
  return { ok: true, config: { ...config, coding } };
}

export function resetCliConfigValue(config: CliGlobalConfig, key?: CliConfigKey): CliGlobalConfig {
  if (!key) {
    const { adkPath: _adk, coding: _coding, ...rest } = config;
    return rest;
  }
  if (key === "workspace") {
    const { adkPath: _adk, ...rest } = config;
    return rest;
  }
  const coding = { ...(config.coding ?? {}) } as Record<string, unknown>;
  delete coding[key.slice("coding.".length)];
  const next = { ...config };
  if (Object.keys(coding).length) next.coding = coding as CliCodingConfig;
  else delete next.coding;
  return next;
}

export function serializeCliConfig(config: CliGlobalConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Explicit argv always wins over stored defaults. */
export function applyCodingDefaults(argv: readonly string[], config: CliGlobalConfig): string[] {
  const out = [...argv];
  const has = (name: string) => out.includes(name);
  const coding = config.coding;
  const explicitAgentAt = out.indexOf("--agent");
  const explicitAgent = explicitAgentAt >= 0 ? out[explicitAgentAt + 1] : undefined;
  if (coding?.agent && !has("--agent")) out.push("--agent", coding.agent);
  // Stored model belongs to the stored agent. `--agent codex` must not inherit Pi's grok model.
  if (coding?.model && !has("--model") && (!explicitAgent || explicitAgent === coding.agent)) out.push("--model", coding.model);
  if (coding?.tools === false && !has("--tools") && !has("--no-tools")) out.push("--no-tools");
  if (coding?.tools === true && !has("--tools") && !has("--no-tools")) out.push("--tools");
  return out;
}

/** Remove selected variables without disturbing comments or unrelated providers. */
export function removeEnvLines(content: string, names: readonly string[]): string {
  const remove = new Set(names);
  const lines = content.split(/\r?\n/).filter((line) => {
    const eq = line.indexOf("=");
    return eq <= 0 || !remove.has(line.slice(0, eq).trim());
  });
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export interface CliModel {
  readonly provider: string;
  readonly id: string;
  readonly label: string;
  readonly tools: boolean;
  readonly use: "coding" | "analysis" | "general";
}

export const FALLBACK_NAIA_MODELS: readonly CliModel[] = [
  { provider: "naia", id: "grok-4.3", label: "Grok 4.3 (Naia / Azure)", tools: true, use: "coding" },
  { provider: "naia", id: "deepseek-v4-pro", label: "DeepSeek V4 Pro (Naia / Azure)", tools: false, use: "analysis" },
];

export function normalizeModelCatalog(input: unknown): CliModel[] {
  const data = (input as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const models: CliModel[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const provider = typeof item.provider === "string"
      ? item.provider
      : typeof item.owned_by === "string" ? item.owned_by : "naia";
    const tools = id !== "deepseek-v4-pro"
      && (typeof item.supports_tools === "boolean" ? item.supports_tools : true);
    models.push({
      provider,
      id,
      label: typeof item.name === "string" ? item.name : id,
      tools,
      use: id === "deepseek-v4-pro" ? "analysis" : (tools ? "coding" : "general"),
    });
  }
  return models.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
}

export const SESSION_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const SESSION_MESSAGE_MAX = 400;
export function isSafeSessionId(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

export interface TranscriptParseResult {
  readonly messages: readonly ChatMessage[];
  readonly skipped: number;
  readonly truncated: boolean;
}

/** Parse only complete user→assistant turns; corrupt/incomplete records never enter resumed history. */
export function parseTranscript(text: string, maxMessages = SESSION_MESSAGE_MAX): TranscriptParseResult {
  const complete: ChatMessage[] = [];
  let pendingUser: ChatMessage | undefined;
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { role?: unknown; content?: unknown };
      if ((value.role !== "user" && value.role !== "assistant") || typeof value.content !== "string") {
        skipped++; continue;
      }
      if (value.role === "user") {
        if (pendingUser) skipped++;
        pendingUser = { role: "user", content: value.content };
      } else if (pendingUser) {
        complete.push(pendingUser, { role: "assistant", content: value.content });
        pendingUser = undefined;
      } else {
        skipped++;
      }
    } catch { skipped++; }
  }
  if (pendingUser) skipped++;
  const bounded = complete.slice(-Math.max(2, maxMessages - (maxMessages % 2)));
  return { messages: bounded, skipped, truncated: bounded.length < complete.length };
}
