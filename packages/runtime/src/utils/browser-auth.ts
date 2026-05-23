/**
 * Browser-based login for naia-agent CLI.
 *
 * Flow:
 *   1. Start a temporary localhost HTTP server on a random port
 *   2. Open the system browser to naia.nextain.io/login with redirect=localhost
 *   3. User authenticates on the web
 *   4. Server redirects to localhost with ?key=gw-xxx&user_id=yyy
 *   5. CLI receives the gw-key and stores it
 *
 * Design: Node.js `http` only — zero new dependencies. The server listens
 * for one request then shuts down. CSRF state token is generated with
 * crypto.randomUUID() and validated on callback.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

export const NAIA_WEB_BASE_URL =
  process.env.NAIA_WEB_BASE_URL || "https://naia.nextain.io";

export interface BrowserAuthResult {
  key: string;
  userId?: string;
}

/**
 * Open a URL in the system's default browser. Cross-platform.
 */
function openBrowser(url: string): void {
  const escaped = url.replace(/"/g, "%22");
  const cmd =
    process.platform === "win32"
      ? `start "" "${escaped}"`
      : process.platform === "darwin"
        ? `open "${escaped}"`
        : `xdg-open "${escaped}"`;
  try {
    execSync(cmd, { stdio: "ignore", timeout: 5000 });
  } catch {
    process.stderr.write(
      `  Could not open browser. Open manually:\n  ${url}\n`,
    );
  }
}

/**
 * Perform browser-based login. Returns the gw-key on success.
 *
 * @param timeoutMs How long to wait for the browser callback (default 3 min)
 */
export async function browserLogin(
  timeoutMs = 180_000,
): Promise<BrowserAuthResult> {
  const state = randomUUID();
  let port = 0;

  return new Promise<BrowserAuthResult>((resolve, reject) => {
    let settled = false;
    let server: ReturnType<typeof createServer> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (server) {
        server.close();
        server = null;
      }
    };

    const finish = (result: BrowserAuthResult | Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!req.url) {
        res.writeHead(400);
        res.end("Missing URL");
        return;
      }

      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const pathname = url.pathname;

      if (pathname === "/callback") {
        const key = url.searchParams.get("key") || url.searchParams.get("code");
        const userId = url.searchParams.get("user_id") ?? undefined;
        const incomingState = url.searchParams.get("state");

        if (incomingState !== state) {
          res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h1>CSRF state mismatch — login rejected</h1>");
          finish(new Error("CSRF state mismatch"));
          return;
        }

        if (!key) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h1>Missing key parameter</h1>");
          finish(new Error("No key in callback"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<h1>Login successful!</h1><p>You can close this tab and return to the terminal.</p>",
        );
        finish({ key, userId });
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as { port: number };
      port = addr.port;

      const params = new URLSearchParams({
        redirect: "cli",
        source: "cli",
        callback: `http://127.0.0.1:${port}/callback`,
        state,
      });

      const loginUrl = `${NAIA_WEB_BASE_URL}/ko/login?${params.toString()}`;

      process.stdout.write(`\n  Opening browser for Naia login...\n`);
      process.stdout.write(`  Waiting for authentication (timeout: ${Math.round(timeoutMs / 1000)}s)...\n\n`);

      openBrowser(loginUrl);

      timer = setTimeout(() => {
        finish(new Error("Login timed out — no response from browser"));
      }, timeoutMs);
    });

    server.on("error", (err) => {
      finish(new Error(`Server error: ${err.message}`));
    });
  });
}
