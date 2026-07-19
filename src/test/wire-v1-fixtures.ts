// UC-WIRE-V1 test-only fixtures.
// Opaque refs are synthetic and deliberately contain no path, credential, raw provider thread id, or source body.

export const MiB = 1024 * 1024;

export const LEGACY_STDIO_CHAT = {
  type: "chat_request",
  requestId: "legacy-r1",
  messages: [{ role: "user", content: "hello" }],
} as const;

export const LEGACY_DOMAIN_CHAT = {
  kind: "chat",
  requestId: "legacy-r1",
  messages: [{ role: "user", content: "hello" }],
} as const;

export const ATTACHMENT = {
  id: "att-001",
  kind: "image",
  mimeType: "image/png",
  sizeBytes: 1024,
  localRef: "imgref001",
} as const;

export const DISCORD_CHANNEL = {
  kind: "discord",
  bindingId: "binding001",
  guildId: "123456789012345678",
  channelId: "223456789012345678",
  userId: "323456789012345678",
} as const;

export const GROUNDING_REQUIRED = {
  policy: "required",
  knowledgeScope: "workshop",
} as const;

export const PROVIDER_SESSION_NEW = { mode: "new" } as const;
export const PROVIDER_SESSION_RESUME = {
  mode: "resume",
  providerSessionRef: "sessionref001",
} as const;
export const PROCESSING_REQUEST = { processingProfileRef: "profile001" } as const;

export const EFFECTIVE_LLM_CONFIGS = [
  {
    role: "main",
    provider: { value: "codex", provenance: "explicit" },
    model: { value: "gpt-5", provenance: "explicit" },
    credentialRef: { value: "credref001", provenance: "explicit" },
  },
  {
    role: "sub",
    provider: { value: "codex", provenance: "inherit", inheritedFromRole: "main" },
    model: { value: "gpt-5", provenance: "inherit", inheritedFromRole: "main" },
  },
  {
    role: "memory",
    provider: { value: "local", provenance: "explicit" },
    model: { value: "memory-small", provenance: "explicit" },
  },
] as const;

export const TRUSTED_DISCORD_BINDING = {
  bindingId: DISCORD_CHANNEL.bindingId,
  guildId: DISCORD_CHANNEL.guildId,
  channelId: DISCORD_CHANNEL.channelId,
  allowedUserIds: [DISCORD_CHANNEL.userId],
  knowledgeScope: GROUNDING_REQUIRED.knowledgeScope,
  processingProfileRef: PROCESSING_REQUEST.processingProfileRef,
} as const;

export const GROUNDING_EVENT = {
  kind: "grounding",
  status: "grounded",
  sources: [{ title: "Workshop notes", sourceUris: ["kb://workshop/intro"] }],
} as const;

export const ARTIFACT_EVENT = {
  kind: "artifact",
  artifact: {
    id: "artifact001",
    kind: "image",
    mimeType: "image/webp",
    sizeBytes: 2048,
    localRef: "artifactref001",
    name: "diagram.webp",
  },
} as const;

export const PROVIDER_SESSION_EVENT = {
  kind: "providerSession",
  sessionId: "session001",
  providerSessionRef: PROVIDER_SESSION_RESUME.providerSessionRef,
  state: "resumed",
} as const;
export const PROCESSING_DISCLOSURE_EVENT = {
  kind: "processingDisclosure",
  workload: "main_llm",
  destination: "external_cloud",
  decision: "allowed",
  processingProfileRef: PROCESSING_REQUEST.processingProfileRef,
  provider: "codex",
  model: "gpt-5",
} as const;

export const CODED_ERROR_EVENT = {
  kind: "error",
  message: "Request could not be processed.",
  code: "WIRE_INVALID_ARGUMENT",
} as const;

export const EXISTING_PROTO_SNAPSHOT = {
  SetWorkspaceResult: {
    loaded: { number: 1, type: "bool" },
    provider: { number: 2, type: "string" },
    model: { number: 3, type: "string" },
  },
  ChatRequest: {
    request_id: { number: 1, type: "string" },
    messages: { number: 2, type: "Message" },
    system_prompt: { number: 3, type: "string" },
    enable_tools: { number: 4, type: "bool" },
    enable_thinking: { number: 5, type: "bool" },
    gateway_url: { number: 6, type: "string" },
    disabled_skills: { number: 7, type: "string" },
    session_id: { number: 8, type: "string" },
    environment_segments_json: { number: 9, type: "string" },
    activity_resume: { number: 10, type: "ActivityResume" },
  },
  AgentEvent: {
    request_id: { number: 1, type: "string" },
    text: { number: 2, type: "TextEvent" },
    thinking: { number: 3, type: "TextEvent" },
    tool_use: { number: 4, type: "ToolUseEvent" },
    tool_result: { number: 5, type: "ToolResultEvent" },
    approval_request: { number: 6, type: "ApprovalRequestEvent" },
    gateway_approval_request: { number: 7, type: "GatewayApprovalRequestEvent" },
    usage: { number: 8, type: "UsageEvent" },
    log_entry: { number: 9, type: "LogEntryEvent" },
    token_warning: { number: 10, type: "TokenWarningEvent" },
    finish: { number: 11, type: "FinishEvent" },
    error: { number: 12, type: "ErrorEvent" },
    compacted: { number: 13, type: "CompactedEvent" },
    panel_tool_call: { number: 14, type: "PanelToolCallEvent" },
    activity_id: { number: 15, type: "string" },
    profile_generation: { number: 16, type: "int64" },
  },
} as const;
