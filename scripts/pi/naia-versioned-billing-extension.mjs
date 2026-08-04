import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { makeNaiaVersionedBillingFetch } from "../../dist/main/adapters/naia-pi-versioned-billing.js";

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
  pi.registerProvider("naia", {
    api: "openai-completions",
    streamSimple(model, context, options) {
      if (model.provider !== "naia") throw new Error("Naia billing extension received a foreign provider");
      return api.streamSimple(model, context, { ...options, fetch: billedFetch });
    },
  });
}
