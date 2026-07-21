import { afterEach, describe, expect, it, vi } from "vitest";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { makeGrpcServer, type GrpcServer } from "../main/adapters/grpc/grpc-server.js";

const PROTO = fileURLToPath(new URL("../main/adapters/grpc/naia_agent.proto", import.meta.url));

function makeClient(addr: string): grpc.Client & {
  shutdown(
    request: { nonce: string },
    callback: (error: grpc.ServiceError | null, response: { ok: boolean }) => void,
  ): grpc.ClientUnaryCall;
} {
  const pkgDef = protoLoader.loadSync(PROTO, {
    keepCase: false,
    longs: Number,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as unknown as {
    naia: { agent: { v1: { NaiaAgent: new (
      addr: string,
      credentials: grpc.ChannelCredentials,
    ) => ReturnType<typeof makeClient> } } };
  };
  return new proto.naia.agent.v1.NaiaAgent(addr, grpc.credentials.createInsecure());
}

function shutdown(
  client: ReturnType<typeof makeClient>,
  nonce: string,
): Promise<{ ok: boolean }> {
  return new Promise((resolve, reject) => {
    client.shutdown({ nonce }, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

describe("authenticated graceful Shutdown RPC", () => {
  let server: GrpcServer | undefined;
  let client: ReturnType<typeof makeClient> | undefined;

  afterEach(async () => {
    client?.close();
    await server?.shutdown();
  });

  it("rejects a wrong opaque nonce and ACKs before scheduling onShutdown once", async () => {
    const onShutdown = vi.fn();
    server = makeGrpcServer({
      shutdownNonce: "correct-opaque-nonce",
      onShutdown,
      onSetWorkspace: () => ({ loaded: false, provider: "", model: "" }),
      onReloadSettings: () => ({ loaded: false, provider: "", model: "" }),
      diag: { log: () => {}, debug: () => {} },
    });
    const addr = await server.start();
    client = makeClient(addr);

    await expect(shutdown(client, "wrong-opaque-nonce"))
      .rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
    expect(onShutdown).not.toHaveBeenCalled();

    const first = shutdown(client, "correct-opaque-nonce");
    const second = shutdown(client, "correct-opaque-nonce");
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onShutdown).toHaveBeenCalledOnce();
  });
});
