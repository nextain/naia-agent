import { createHash } from "node:crypto";
import type { ToolCall, ToolSpec } from "../domain/chat.js";
import type { ActorBinding, IssueReport, IssueStartRequest } from "../domain/issue-orchestration.js";
import type { ManagedIssueSession } from "../domain/multi-issue-session.js";
import type { WorkerProfile } from "../domain/issue-team.js";
import type { MultiIssueSessionCommands, MultiIssueSessionQueries } from "../ports/multi-issue-session.js";
import type { DiagnosticLog, ToolExecutorPort } from "../ports/uc1.js";

export interface CodingSessionTrustedContext {
  readonly workspacePath: string;
  readonly naiaBinding: ActorBinding;
  readonly moderatorBinding: ActorBinding;
  readonly workerProfiles: Readonly<Record<string, WorkerProfile>>;
  readonly actorId: string;
}

export interface CodingSessionSkillDeps {
  readonly sessions: MultiIssueSessionCommands & MultiIssueSessionQueries;
  readonly context: CodingSessionTrustedContext;
  /** The durable manager may be configured with autoPump=false. This trigger must never delay tool return. */
  readonly pump?: () => Promise<void>;
  readonly requestId?: (call: ToolCall, chatRequestId?: string) => string;
  readonly maxList?: number;
  readonly diag?: DiagnosticLog;
}

const MAX_TASK_CHARS = 32_768;
const MAX_ANSWER_CHARS = 16_384;
const MAX_OBLIGATIONS = 32;
const MAX_OBLIGATION_CHARS = 4_096;

const TOOLS: readonly ToolSpec[] = [
  {
    name: "start_coding_task",
    description: "현재 Naia 런타임에 고정된 workspace와 worker profile로 durable 코딩 작업을 시작하고 session id를 즉시 반환한다.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "사용자가 맡긴 코딩 작업 원문" },
        obligations: { type: "array", items: { type: "string" }, description: "반드시 보존할 순서 있는 요구사항" },
      },
      required: ["task"],
    },
    tier: "none",
  },
  {
    name: "list_coding_tasks",
    description: "durable 코딩 작업의 안전한 상태 목록을 조회한다.",
    parameters: { type: "object", properties: {} },
    tier: "none",
  },
  {
    name: "show_coding_task",
    description: "session id로 durable 코딩 작업의 안전한 상태와 결과를 조회한다.",
    parameters: {
      type: "object",
      properties: { session_id: { type: "string", description: "start_coding_task가 반환한 session id" } },
      required: ["session_id"],
    },
    tier: "none",
  },
  {
    name: "answer_coding_task",
    description: "대기 중인 코딩 작업의 정확한 question id에 답하고 같은 작업을 재개한다.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        question_id: { type: "string" },
        answer: { type: "string" },
      },
      required: ["session_id", "question_id", "answer"],
    },
    tier: "none",
  },
  {
    name: "cancel_coding_task",
    description: "session id에 해당하는 durable 코딩 작업의 취소를 요청한다.",
    parameters: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
    tier: "none",
  },
];

export function makeCodingSessionSkill(deps: CodingSessionSkillDeps): ToolExecutorPort {
  if (!deps.context.workspacePath.trim()) throw new Error("coding session workspace is required");
  if (!deps.context.actorId.trim()) throw new Error("coding session actor id is required");
  if (Object.keys(deps.context.workerProfiles).length === 0) throw new Error("at least one trusted worker profile is required");
  const maxList = deps.maxList ?? 50;
  if (!Number.isSafeInteger(maxList) || maxList <= 0 || maxList > 200) throw new Error("maxList must be between 1 and 200");

  return {
    specs: () => TOOLS,
    async execute(call, opts) {
      if (opts.signal?.aborted) return failure("coding session command was cancelled");
      try {
        switch (call.name) {
          case "start_coding_task": {
            const task = boundedString(call, "task", MAX_TASK_CHARS);
            if (!task.ok) return failure(task.error);
            const obligations = readObligations(call, task.value);
            if (!obligations.ok) return failure(obligations.error);
            const requestId = deps.requestId?.(call, opts.requestId) ?? defaultRequestId(call, opts.requestId);
            const request: IssueStartRequest = {
              requestId,
              text: task.value,
              requiredObligations: obligations.value,
              workspacePath: deps.context.workspacePath,
              naiaBinding: deps.context.naiaBinding,
              moderatorBinding: deps.context.moderatorBinding,
              workerProfiles: deps.context.workerProfiles,
            };
            const session = await deps.sessions.submit({
              request,
              source: { kind: "local", sourceId: requestId, actorId: deps.context.actorId },
            });
            triggerPump(deps);
            return success(safeProjection(session));
          }
          case "list_coding_tasks":
            return success(deps.sessions.list().slice(0, maxList).map(safeProjection));
          case "show_coding_task": {
            const sessionId = identifier(call, "session_id");
            if (!sessionId.ok) return failure(sessionId.error);
            return success(safeProjection(deps.sessions.get(sessionId.value)));
          }
          case "answer_coding_task": {
            const sessionId = identifier(call, "session_id");
            const questionId = identifier(call, "question_id");
            const answer = boundedString(call, "answer", MAX_ANSWER_CHARS);
            if (!sessionId.ok) return failure(sessionId.error);
            if (!questionId.ok) return failure(questionId.error);
            if (!answer.ok) return failure(answer.error);
            const session = await deps.sessions.answer(sessionId.value, questionId.value, answer.value);
            triggerPump(deps);
            return success(safeProjection(session));
          }
          case "cancel_coding_task": {
            const sessionId = identifier(call, "session_id");
            if (!sessionId.ok) return failure(sessionId.error);
            const session = await deps.sessions.cancel(sessionId.value);
            triggerPump(deps);
            return success(safeProjection(session));
          }
          default:
            return failure(`unknown coding session command: ${call.name}`);
        }
      } catch (error) {
        deps.diag?.log("coding session command failed", error instanceof Error ? error.name : "unknown");
        return failure(error instanceof Error && error.message.startsWith("unknown session:")
          ? "unknown coding session"
          : "coding session command failed");
      }
    },
  };
}

function defaultRequestId(call: ToolCall, chatRequestId?: string): string {
  const digest = createHash("sha256").update(chatRequestId ?? "local").update("\0").update(call.id).digest("hex");
  return `coding-tool-${digest}`;
}

function triggerPump(deps: CodingSessionSkillDeps): void {
  if (!deps.pump) return;
  void deps.pump().catch((error: unknown) => {
    deps.diag?.log("coding session background pump failed", error instanceof Error ? error.name : "unknown");
  });
}

function safeProjection(session: ManagedIssueSession): Readonly<Record<string, unknown>> {
  return {
    sessionId: session.sessionId,
    issueId: session.issueId,
    state: session.state,
    cancellationRequested: session.cancellationRequested,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.report?.question ? { question: session.report.question } : {}),
    ...(session.report ? { result: safeReport(session.report) } : {}),
  };
}

function safeReport(report: IssueReport): Readonly<Record<string, unknown>> {
  return {
    state: report.state,
    summary: report.summary,
    changedFiles: report.changedFiles,
    verificationPassed: report.verificationPassed,
    totalCost: report.totalCost.state === "measured"
      ? { state: "measured", usd: report.totalCost.usd }
      : { state: "unavailable" },
  };
}

function readArgs(call: ToolCall): Record<string, unknown> {
  return call.args && typeof call.args === "object" && !Array.isArray(call.args)
    ? call.args as Record<string, unknown>
    : {};
}

function boundedString(call: ToolCall, name: string, max: number): Result<string> {
  const value = readArgs(call)[name];
  if (typeof value !== "string" || !value.trim()) return { ok: false, error: `${name} is required` };
  if (value.length > max) return { ok: false, error: `${name} exceeds ${max} characters` };
  return { ok: true, value };
}

function identifier(call: ToolCall, name: string): Result<string> {
  const value = readArgs(call)[name];
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return { ok: false, error: `${name} is invalid` };
  }
  return { ok: true, value };
}

function readObligations(call: ToolCall, fallback: string): Result<readonly string[]> {
  const value = readArgs(call).obligations;
  if (value === undefined) return { ok: true, value: [fallback] };
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OBLIGATIONS) {
    return { ok: false, error: `obligations must contain 1-${MAX_OBLIGATIONS} strings` };
  }
  if (value.some((item) => typeof item !== "string" || !item.trim() || item.length > MAX_OBLIGATION_CHARS)) {
    return { ok: false, error: `each obligation must be a non-empty string up to ${MAX_OBLIGATION_CHARS} characters` };
  }
  return { ok: true, value: value as string[] };
}

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
function success(value: unknown): { output: string } { return { output: JSON.stringify(value) }; }
function failure(error: string): { output: string; isError: true } {
  return { output: JSON.stringify({ error }), isError: true };
}
