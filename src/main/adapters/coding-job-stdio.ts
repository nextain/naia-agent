import { CodingJobNotFoundError, CodingJobResumeUnavailableError } from "../domain/coding-job.js";
import type { CodingJobControlPort } from "../ports/coding-job.js";

export type CodingJobStdioCommand =
  | { readonly command: "coding_job.start"; readonly workspacePath: string; readonly task: string; readonly model?: string }
  | { readonly command: "coding_job.get"; readonly jobId: string }
  | { readonly command: "coding_job.list"; readonly workspacePath?: string }
  | { readonly command: "coding_job.cancel"; readonly jobId: string }
  | { readonly command: "coding_job.resume"; readonly jobId: string };

export function decodeCodingJobStdio(line: string): CodingJobStdioCommand | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const command = typeof value.command === "string" ? value.command : "";
    if (command === "coding_job.start" && typeof value.workspacePath === "string" && typeof value.task === "string")
      return { command, workspacePath: value.workspacePath, task: value.task, ...(typeof value.model === "string" ? { model: value.model } : {}) };
    if ((command === "coding_job.get" || command === "coding_job.cancel" || command === "coding_job.resume") && typeof value.jobId === "string")
      return { command, jobId: value.jobId } as CodingJobStdioCommand;
    if (command === "coding_job.list") return { command, ...(typeof value.workspacePath === "string" ? { workspacePath: value.workspacePath } : {}) };
  } catch { /* invalid command is an explicit error response */ }
  return null;
}

export async function dispatchCodingJobStdio(service: CodingJobControlPort, command: CodingJobStdioCommand): Promise<Record<string, unknown>> {
  try {
    switch (command.command) {
      case "coding_job.start": return { ok: true, job: service.start(command) };
      case "coding_job.get": return { ok: true, job: service.get(command.jobId) };
      case "coding_job.list": return { ok: true, jobs: service.list(command.workspacePath) };
      case "coding_job.cancel": return { ok: true, job: await service.cancel(command.jobId) };
      case "coding_job.resume": return { ok: true, job: service.resume(command.jobId) };
    }
  } catch (error) {
    const code = error instanceof CodingJobNotFoundError ? "NOT_FOUND"
      : error instanceof CodingJobResumeUnavailableError ? "FAILED_PRECONDITION" : "INVALID_ARGUMENT";
    return { ok: false, code, error: error instanceof Error ? error.message : String(error) };
  }
}
