import { randomUUID } from "node:crypto";
import type {
  ActorBinding,
  ActorReceipt,
  IssueClassification,
  IssueReport,
  ModeratorPlan,
} from "../domain/issue-orchestration.js";
import { groundedIssueCommentary } from "../domain/issue-orchestration.js";
import {
  IssueActorResultError,
  type DevelopmentModeratorPort,
  type IssueVerifierPort,
  type NaiaFacingPort,
  type NaiaIssueReporterPort,
} from "../ports/issue-orchestration.js";
import type { SubAgentPort, VerifierPort } from "../ports/orchestration.js";
import type { DiagnosticLog } from "../ports/uc1.js";

interface JsonActorOptions {
  readonly subAgent: SubAgentPort;
  readonly binding: ActorBinding;
  readonly workdir: string;
  readonly diag: DiagnosticLog;
  readonly nowMs?: () => number;
  readonly allowedWorkerProfiles?: readonly string[];
  readonly allowedAcceptanceChecks?: readonly string[];
  readonly timeoutMs?: number;
}

export function makeSubAgentNaiaFacing(options: JsonActorOptions): NaiaFacingPort {
  return {
    async classify(input) {
      const prompt = [
        "You are Naia's low-cost conversational front layer, not a coding planner.",
        "Classify the input as chat or work and preserve every explicit work obligation verbatim, in source order.",
        `For work, return this exact ordered obligation array: ${JSON.stringify(input.requiredObligations)}. Chat is valid only when this array is empty.`,
        "Return JSON only: {\"kind\":\"chat|work\",\"obligations\":[\"...\"],\"chatReply\":\"... optional for chat\"}.",
        `Input: ${JSON.stringify(input.text)}`,
      ].join("\n");
      const result = await runJson(options, "naia", input.idempotencyKey, prompt, input.signal);
      return withReceipt(result.receipt, () => {
        const kind = result.value.kind === "chat" ? "chat" : result.value.kind === "work" ? "work" : undefined;
        if (!kind || !Array.isArray(result.value.obligations) || result.value.obligations.some((item) => typeof item !== "string")) throw new Error("Naia classification schema mismatch");
        const obligations = result.value.obligations as string[];
        if ((kind === "work" && input.requiredObligations.length === 0)
          || (kind === "chat" && input.requiredObligations.length !== 0)
          || !sameStrings(obligations, input.requiredObligations)) {
          throw new Error("Naia obligation binding mismatch");
        }
        const classification: IssueClassification = {
          kind, obligations,
          ...(typeof result.value.chatReply === "string" ? { chatReply: result.value.chatReply } : {}),
        };
        return { classification, receipt: result.receipt };
      });
    },
  };
}

export function makeSubAgentDevelopmentModerator(options: JsonActorOptions): DevelopmentModeratorPort {
  return {
    async plan(input) {
      const allowedProfiles = options.allowedWorkerProfiles ?? ["control", "balanced", "economy"];
      if (allowedProfiles.length === 0 || allowedProfiles.some((profile) => !profile.trim())) throw new Error("moderator worker profile policy missing");
      const allowedChecks = options.allowedAcceptanceChecks;
      if (!allowedChecks || allowedChecks.length === 0 || allowedChecks.some((check) => !check.trim())
        || new Set(allowedChecks).size !== allowedChecks.length) throw new Error("moderator acceptance check policy missing");
      const prompt = [
        "You are the separate senior development moderator. Do not implement.",
        "Produce one bounded worker task, a stable role profile, exact acceptance checks, and only truly blocking questions.",
        `Allowed worker profiles (choose exactly one): ${JSON.stringify(allowedProfiles)}.`,
        `Required acceptance checks (return these exact strings once each): ${JSON.stringify(allowedChecks)}.`,
        "Return JSON only: {\"workerTask\":\"...\",\"workerProfile\":\"...\",\"acceptanceChecks\":[\"...\"],\"questions\":[{\"questionId\":\"q-...\",\"text\":\"...\"}]}.",
        `Original request: ${JSON.stringify(input.originalText)}`,
        `Obligations: ${JSON.stringify(input.obligations)}`,
        `Bound answers: ${JSON.stringify(input.answers)}`,
      ].join("\n");
      const result = await runJson(options, "moderator", input.idempotencyKey, prompt, input.signal);
      return withReceipt(result.receipt, () => {
        const value = result.value;
        if (typeof value.workerTask !== "string" || !allowedProfiles.includes(String(value.workerProfile))
          || !Array.isArray(value.acceptanceChecks) || value.acceptanceChecks.length === 0
          || value.acceptanceChecks.some((item) => typeof item !== "string" || !item.trim())
          || !Array.isArray(value.questions)) throw new Error("moderator plan schema mismatch");
        if (new Set(value.acceptanceChecks as string[]).size !== allowedChecks.length
          || allowedChecks.some((check) => !(value.acceptanceChecks as string[]).includes(check))) {
          throw new Error("moderator acceptance check binding mismatch");
        }
        const questions = value.questions.map((question) => {
          if (!question || typeof question !== "object") throw new Error("moderator question schema mismatch");
          const candidate = question as Record<string, unknown>;
          if (typeof candidate.questionId !== "string" || typeof candidate.text !== "string") throw new Error("moderator question schema mismatch");
          return { questionId: candidate.questionId, text: candidate.text };
        });
        const plan: ModeratorPlan = {
          workerTask: value.workerTask,
          workerProfile: String(value.workerProfile),
          acceptanceChecks: value.acceptanceChecks as string[],
          questions,
        };
        return { plan, receipt: result.receipt };
      });
    },
  };
}

export function makeSubAgentNaiaReporter(options: JsonActorOptions): NaiaIssueReporterPort {
  return {
    async report(input) {
      if (input.issue.state !== "completed" && input.issue.state !== "failed") {
        throw new Error("Naia reporter requires a completed or failed issue");
      }
      const terminal = input.issue.state;
      const expectedSummary = groundedIssueCommentary(input.issue, terminal);
      const evidence = {
        state: input.issue.state,
        changedFiles: input.issue.worker?.changedFiles ?? [],
        workerSummary: input.issue.worker?.summary ?? null,
        verification: input.issue.verification?.checks ?? [],
        eventTypes: input.events.map((event) => event.type),
      };
      const prompt = [
        "You are Naia's user-facing reporter. Summarize only the supplied durable evidence. Do not upgrade unknown, failed, or cancelled state.",
        `Return this exact JSON value without changing any text: ${JSON.stringify({ summary: expectedSummary })}.`,
        `Evidence: ${JSON.stringify(evidence)}`,
      ].join("\n");
      const result = await runJson(options, "reporter", input.idempotencyKey, prompt, input.signal);
      return withReceipt(result.receipt, () => {
        if (result.value.summary !== expectedSummary) throw new Error("Naia report evidence binding mismatch");
        const report: Omit<IssueReport, "totalCost"> = {
          state: terminal,
          summary: expectedSummary,
          issueId: input.issue.issueId,
          changedFiles: input.issue.worker?.changedFiles ?? [],
          verificationPassed: input.issue.verification?.ok ?? null,
        };
        return { report, receipt: result.receipt };
      });
    },
  };
}

export function makeIssueVerifierAdapter(verifier: VerifierPort, nowMs: () => number = Date.now): IssueVerifierPort {
  return {
    async verify(input) {
      const startedAt = nowMs();
      const verification = await verifier.verify(input.worktreePath);
      const checks = input.acceptanceChecks.map((name) => {
        const actual = verification.checks.find((check) => check.name === name);
        return actual ?? { name, pass: false, details: "declared acceptance check was not executed" };
      });
      const ok = input.acceptanceChecks.length > 0 && verification.ok && checks.every((check) => check.pass);
      return {
        ok,
        checks,
        receipt: {
          role: "verifier", provider: "deterministic", model: "command-verifier",
          sessionId: randomUUID(), executionId: randomUUID(), idempotencyKey: input.idempotencyKey,
          tokenCountsAvailable: true,
          inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
          latencyMs: Math.max(0, nowMs() - startedAt),
          cost: { state: "measured", usd: 0, source: "local_deterministic_verifier" },
        },
      };
    },
  };
}

async function runJson(options: JsonActorOptions, role: ActorReceipt["role"], idempotencyKey: string, prompt: string, signal: AbortSignal): Promise<{
  readonly value: Record<string, unknown>;
  readonly receipt: ActorReceipt;
}> {
  const now = options.nowMs ?? Date.now;
  const startedAt = now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`${role} actor timeout policy invalid`);
  options.diag.debug?.("[SubAgentIssueActor] start", { at: startedAt, role, idempotencyKey, model: options.binding.model });
  const session = options.subAgent.spawn({ prompt, workdir: options.workdir, model: options.binding.model, filesystemAccess: "read_only" });
  let text = "";
  let evidence: import("../domain/orchestration.js").SubAgentModelEvidence | undefined;
  let ok = false;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void session.cancel(`${role} actor timeout`); }, timeoutMs);
  const abort = () => { void session.cancel(`${role} actor cancelled`); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    for await (const event of session.events) {
      if (event.kind === "text_delta") text += event.text;
      if (event.kind === "model_evidence") evidence = event.evidence;
      if (event.kind === "session_end") { ok = event.ok; evidence = event.evidence ?? evidence; break; }
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
  if (timedOut) throw new Error(`${role} actor timed out`);
  if (signal.aborted && !ok) throw new Error(`${role} actor cancelled`);
  if (!ok) throw new Error(`${role} actor did not complete`);
  if (!evidence?.sessionId || !evidence.executionId) throw new Error(`${role} actor receipt identity unavailable`);
  if (evidence.provider !== options.binding.provider || evidence.selectedModel !== options.binding.model) {
    throw new Error(`${role} actor binding mismatch`);
  }
  const completedAt = now();
  const usageAvailable = evidence.usageAvailable === true;
  const receipt: ActorReceipt = {
    role,
    provider: evidence.provider,
    model: evidence.selectedModel,
    ...(evidence.reasoningEffort ? { reasoningEffort: evidence.reasoningEffort } : {}),
    sessionId: evidence.sessionId,
    executionId: evidence.executionId,
    idempotencyKey,
    tokenCountsAvailable: usageAvailable,
    inputTokens: usageAvailable ? evidence.inputTokens : 0,
    cachedInputTokens: usageAvailable ? evidence.cachedInputTokens ?? 0 : 0,
    outputTokens: usageAvailable ? evidence.outputTokens : 0,
    latencyMs: Math.max(0, completedAt - startedAt),
    ...(evidence.modelEvidenceSource ? { modelEvidenceSource: evidence.modelEvidenceSource } : {}),
    cost: usageAvailable && evidence.measuredCostUsd !== undefined
      ? { state: "measured", usd: evidence.measuredCostUsd, source: "subagent_usage_and_pinned_price" }
      : { state: "unavailable", reason: "actor adapter did not receive priced usage" },
  };
  return withReceipt(receipt, () => ({ value: parseJsonObject(text), receipt }));
}

function withReceipt<T>(receipt: ActorReceipt, operation: () => T): T {
  try { return operation(); } catch (error) {
    if (error instanceof IssueActorResultError) throw error;
    throw new IssueActorResultError(error instanceof Error ? error.message : "actor result rejected", receipt);
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]?.trim();
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const value = JSON.parse(candidate) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("actor JSON object required");
  return value as Record<string, unknown>;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
