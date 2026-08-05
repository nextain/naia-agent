import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Pi 0.83's extension loader aliases static pi-ai package imports to its broad
// compatibility entrypoint. Resolve the installed sibling package from Pi's
// pinned CLI entrypoint, then let native ESM load only the narrow API module.
// Keep the exported subpath visible so the trusted-runtime contract can audit
// the intended dependency: @earendil-works/pi-ai/api/openai-completions.lazy
const piEntrypoint = realpathSync(process.argv[1]);
const piAiApiPath = realpathSync(join(
  dirname(dirname(piEntrypoint)),
  "..",
  "pi-ai",
  "dist",
  "api",
  "openai-completions.lazy.js",
));
const { openAICompletionsApi } = await import(pathToFileURL(piAiApiPath).href);
import { makeNaiaVersionedBillingFetch } from "../../dist/main/adapters/naia-pi-versioned-billing.js";
import { WORKSPACE_PATH_TOOLS, workspaceToolPathViolation } from "./workspace-tool-boundary.mjs";

export default function registerNaiaVersionedBilling(pi) {
  const executionId = process.env.NAIA_PI_EXECUTION_ID;
  const journalPath = process.env.NAIA_PI_RECEIPT_PATH;
  if (!executionId || !journalPath) throw new Error("Naia Pi billing bindings are missing");
  const gatewayBudgetPath = process.env.NAIA_PI_GATEWAY_BUDGET_PATH;
  const gatewayBudgetPolicy = process.env.NAIA_PI_GATEWAY_BUDGET_POLICY;
  if (!gatewayBudgetPath || !gatewayBudgetPolicy) throw new Error("Naia Pi gateway budget binding is missing");
  const gatewayBudget = { path: gatewayBudgetPath, policy: JSON.parse(gatewayBudgetPolicy) };
  const billedFetch = makeNaiaVersionedBillingFetch({ executionId, journalPath, gatewayBudget });
  const api = openAICompletionsApi();
  pi.on("tool_call", (event, ctx) => {
    if (!WORKSPACE_PATH_TOOLS.has(event.toolName)) return undefined;
    try {
      const violation = workspaceToolPathViolation(ctx.cwd, event.input);
      return violation ? { block: true, reason: violation } : undefined;
    } catch (error) {
      return { block: true, reason: `workspace boundary check failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  });
  pi.registerProvider("naia", {
    api: "openai-completions",
    streamSimple(model, context, options) {
      if (model.provider !== "naia") throw new Error("Naia billing extension received a foreign provider");
      return api.streamSimple(model, context, { ...options, fetch: billedFetch });
    },
  });
}
