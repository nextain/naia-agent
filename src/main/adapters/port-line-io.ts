// adapters/port-line-io — MessagePort 기반 LineIO 어댑터 (계약 FE-06).
import type { LineIO } from "./stdio.js";
import type { Unsub } from "../ports/uc1.js";

export interface LinePortLike {
  postMessage(data: string): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
  removeEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
  start(): void;
}

export function makePortLineIO(port: LinePortLike): LineIO {
  let started = false;

  return {
    writeLine(line: string): void {
      port.postMessage(line);
    },
    onLine(cb: (line: string) => void): Unsub {
      const listener = (ev: { data: unknown }): void => {
        if (typeof ev.data === "string") {
          cb(ev.data);
        }
      };

      port.addEventListener("message", listener);
      if (!started) {
        started = true;
        port.start();
      }

      return () => {
        port.removeEventListener("message", listener);
      };
    },
  };
}
