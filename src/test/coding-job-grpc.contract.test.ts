import { afterEach, describe, expect, it } from "vitest";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { makeGrpcServer, type GrpcServer } from "../main/adapters/grpc/grpc-server.js";
import { CodingJobService } from "../main/app/coding-job-service.js";
import type { CodingJob } from "../main/domain/coding-job.js";

const PROTO = fileURLToPath(new URL("../main/adapters/grpc/naia_agent.proto", import.meta.url));
type Client = grpc.Client & Record<string, (request: object, cb: (error: grpc.ServiceError | null, response: any) => void) => grpc.ClientUnaryCall>;

function call(client: Client, method: string, request: object): Promise<any> {
  return new Promise((resolve, reject) => client[method](request, (error, response) => error ? reject(error) : resolve(response)));
}

function service(): CodingJobService {
  const jobs = new Map<string, CodingJob>(); let id = 0;
  return new CodingJobService({
    store: { get: (key) => jobs.get(key), list: () => [...jobs.values()], save: (job) => jobs.set(job.jobId, job) },
    worktrees: { allocate: ({ jobId, workspacePath }) => ({ workspacePath, worktreePath: `/work/${jobId}`, branch: `naia/coding-job/${jobId}`, leaseId: `lease-${jobId}`, release: () => {} }) },
    runner: { start: () => ({ cancel: async () => {} }) },
    ids: () => `job_grpc_${++id}`, now: () => "now",
  });
}

describe("UC-CW gRPC contract", () => {
  let server: GrpcServer | undefined;
  let client: Client | undefined;
  afterEach(async () => { client?.close(); await server?.shutdown(); });

  it("exposes Start/Get/List/Cancel and rejects no-checkpoint Resume", async () => {
    server = makeGrpcServer({
      onSetWorkspace: () => ({ loaded: false, provider: "", model: "" }), onReloadSettings: () => ({ loaded: false, provider: "", model: "" }),
      codingJobs: service(), diag: { log: () => {}, debug: () => {} },
    });
    const definition = protoLoader.loadSync(PROTO, { keepCase: false, longs: Number, defaults: true, oneofs: true });
    const Proto = grpc.loadPackageDefinition(definition) as unknown as { naia: { agent: { v1: { NaiaAgent: new (addr: string, credentials: grpc.ChannelCredentials) => Client } } } };
    client = new Proto.naia.agent.v1.NaiaAgent(await server.start(), grpc.credentials.createInsecure());
    const started = await call(client, "startCodingJob", { workspacePath: "/workspace", task: "change one" });
    expect(started).toMatchObject({ jobId: "job_grpc_1", state: 2, worktreePath: "/work/job_grpc_1" });
    await expect(call(client, "getCodingJob", { jobId: started.jobId })).resolves.toMatchObject({ jobId: started.jobId, state: 2 });
    await expect(call(client, "listCodingJobs", {})).resolves.toMatchObject({ jobs: [{ jobId: started.jobId }] });
    await expect(call(client, "cancelCodingJob", { jobId: started.jobId })).resolves.toMatchObject({ state: 4 });
    await expect(call(client, "resumeCodingJob", { jobId: started.jobId })).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
  });
});
