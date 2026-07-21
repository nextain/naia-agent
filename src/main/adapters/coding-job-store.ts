import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodingJob } from "../domain/coding-job.js";
import type { CodingJobStore } from "../ports/coding-job.js";
import { replaceOwnerOnlyAtomic } from "./owner-only-atomic-file.js";

interface PersistedJobs { readonly version: 1; readonly jobs: readonly CodingJob[]; }

export function makeOwnerOnlyCodingJobStore(path: string): CodingJobStore {
  const read = (): CodingJob[] => {
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedJobs>;
      // Version 1 records predate executionMode.  Treat them as the established
      // isolated-worktree behavior rather than rejecting a user's job history.
      return Array.isArray(parsed.jobs)
        ? parsed.jobs.map((job) => ({ ...job, executionMode: job.executionMode ?? "isolated_worktree" }))
        : [];
    } catch {
      // A corrupted durable state must not be silently overwritten by an empty list.
      throw new Error("coding job state is unreadable");
    }
  };
  const write = (jobs: readonly CodingJob[]) => replaceOwnerOnlyAtomic(path, JSON.stringify({ version: 1, jobs }, null, 2));
  return {
    get(jobId) { return read().find((job) => job.jobId === jobId); },
    list(workspacePath) {
      const jobs = read();
      return workspacePath ? jobs.filter((job) => job.workspacePath === workspacePath) : jobs;
    },
    save(job) {
      const jobs = read();
      const index = jobs.findIndex((candidate) => candidate.jobId === job.jobId);
      if (index < 0) jobs.push(job); else jobs[index] = job;
      write(jobs);
    },
  };
}

export function defaultCodingJobStatePath(adkPath: string): string {
  return join(adkPath, "data-private", "coding-jobs", "jobs.json");
}
