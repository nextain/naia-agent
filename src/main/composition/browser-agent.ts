// composition/browser-agent — 브라우저 환경용 경량 Agent 조립 루트 (계약 FE-05).
import { wireAgentUC1 } from "./uc1-wiring.js";
import { makePortLineIO, type LinePortLike } from "../adapters/port-line-io.js";
import { makeStdioIngress, makeStdioEgress, type LineIO } from "../adapters/stdio.js";
import type { ProviderPort, DiagnosticLog, Unsub } from "../ports/uc1.js";

export function startBrowserAgent(opts: {
  port: LinePortLike;
  provider?: ProviderPort;
  diag: DiagnosticLog;
}): { stop(): void } {
  let stopped = false;
  const unsubs: Unsub[] = [];

  const baseIo = makePortLineIO(opts.port);

  const wrappedIo: LineIO = {
    writeLine(line: string): void {
      if (stopped) return;
      baseIo.writeLine(line);
    },
    onLine(cb: (line: string) => void): Unsub {
      if (stopped) return () => {};
      const unsub = baseIo.onLine((line) => {
        if (stopped) return;
        cb(line);
      });
      unsubs.push(unsub);
      return () => {
        const idx = unsubs.indexOf(unsub);
        if (idx >= 0) unsubs.splice(idx, 1);
        unsub();
      };
    },
  };

  const ingress = makeStdioIngress(wrappedIo);
  const egress = makeStdioEgress(wrappedIo);

  const { start } = wireAgentUC1({
    ingress,
    egress,
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    diag: opts.diag,
  });

  start?.();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const unsub of unsubs) {
      unsub();
    }
    unsubs.length = 0;
  };

  return { stop };
}

export { makeWebLLMProvider } from "../adapters/webllm-provider.js";
export type { WebLLMEngineLike, WebLLMChatRequest, WebLLMChatChunk, WebLLMChatMessage } from "../adapters/webllm-provider.js";
