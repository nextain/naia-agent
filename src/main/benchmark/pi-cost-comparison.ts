export interface PiCostCall {
  readonly executionId: string;
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface PiGatewayCostReceipt extends PiCostCall {
  readonly gatewayRequestId: string;
  readonly priceVersionId: string;
  readonly source: "gateway_versioned_customer_billing";
  readonly settlementStatus: string;
  readonly customerCostUsd: number;
}

export interface PiCostArmEvidence {
  readonly taskDigest: string;
  readonly status: string;
  readonly checkpoint: { readonly beforeCloseDigest: string; readonly afterOpenDigest: string };
  readonly scorerId: string;
  readonly checks: readonly { readonly name: string; readonly pass: boolean }[];
  readonly changedFiles: readonly string[];
  readonly calls: readonly PiCostCall[];
  readonly receipts: readonly PiGatewayCostReceipt[];
  readonly localBudget: { readonly paidCalls: number; readonly activeReservations: number };
}

export interface PiCostComparisonEvidence {
  readonly schemaVersion: 1;
  readonly benchmarkId: string;
  readonly taskDigest: string;
  readonly baselineDigest: string;
  readonly minimumSavingsRatio: number;
  readonly routePolicy: {
    readonly candidate: { readonly provider: string; readonly roleModels: Readonly<Record<string, string>> };
    readonly control: { readonly provider: string; readonly roleModels: Readonly<Record<string, string>> };
  };
  readonly expectedRoleCounts: Readonly<Record<string, number>>;
  readonly qualityPolicy: {
    readonly scorerId: string;
    readonly requiredChecks: readonly string[];
    readonly allowedChangedFiles: readonly string[];
  };
  readonly budgetPolicy: {
    readonly maximumCombinedPaidCalls: number;
    readonly maximumCombinedUsd: number;
    readonly maximumInputTokens: number;
    readonly maximumOutputTokens: number;
  };
  readonly priceVersionPolicy: Readonly<Record<string, string>>;
  readonly candidate: PiCostArmEvidence;
  readonly control: PiCostArmEvidence;
}

interface ArmSummary {
  readonly status: string;
  readonly qualityScore: number;
  readonly verificationPassed: boolean;
  readonly checkpointRestored: boolean;
  readonly callCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly executionIds: readonly string[];
  readonly gatewayRequestIds: readonly string[];
}

export interface PiCostComparisonResult {
  readonly schemaVersion: 1;
  readonly benchmarkId: string;
  readonly status: "unavailable";
  readonly structuralOutcome: "candidate_lower_cost" | "not_better" | "invalid";
  readonly scope: "frozen paired engineering case only";
  readonly costEfficiencyClaimAllowed: false;
  readonly qualityNonInferior: boolean;
  readonly costImproved: boolean;
  readonly minimumSavingsRatio?: number;
  readonly savingsUsd?: number;
  readonly savingsRatio?: number;
  readonly arms?: { readonly candidate: ArmSummary; readonly control: ArmSummary };
  readonly problems: readonly string[];
}

/**
 * Structurally checks paired evidence. It cannot issue a savings proof until a future adapter
 * cryptographically verifies both the gateway billing export and the harness journal.
 */
export function analyzePiCostComparison(raw: unknown): PiCostComparisonResult {
  if (!isRecord(raw)) return unavailable("unknown", ["comparison evidence must be an object"]);
  const input = raw as Partial<PiCostComparisonEvidence>;
  const problems: string[] = [];
  if (input.schemaVersion !== 1) problems.push("unsupported schemaVersion");
  if (typeof input.benchmarkId !== "string" || !input.benchmarkId) problems.push("benchmarkId missing");
  if (typeof input.taskDigest !== "string" || !input.taskDigest) problems.push("taskDigest missing");
  if (typeof input.baselineDigest !== "string" || !input.baselineDigest) problems.push("baselineDigest missing");
  if (!Number.isFinite(input.minimumSavingsRatio) || input.minimumSavingsRatio! < 0 || input.minimumSavingsRatio! >= 1) {
    problems.push("minimumSavingsRatio must be in [0,1)");
  }
  const qualityPolicy = validQualityPolicy(input.qualityPolicy) ? input.qualityPolicy : undefined;
  if (!qualityPolicy) problems.push("quality policy invalid");
  const candidate = validateArm("candidate", input.candidate, input.taskDigest, input.baselineDigest,
    input.routePolicy?.candidate, qualityPolicy, input.expectedRoleCounts, input.priceVersionPolicy, problems);
  const control = validateArm("control", input.control, input.taskDigest, input.baselineDigest,
    input.routePolicy?.control, qualityPolicy, input.expectedRoleCounts, input.priceVersionPolicy, problems);
  if (candidate && control) {
    if (candidate.callCount !== control.callCount) problems.push("paired arms have different paid-call denominators");
    rejectSharedIds(candidate.executionIds, control.executionIds, "execution", problems);
    rejectSharedIds(candidate.gatewayRequestIds, control.gatewayRequestIds, "gateway request", problems);
    validateCombinedBudget(candidate, control, input.budgetPolicy, problems);
  }
  if (problems.length > 0 || !candidate || !control || input.minimumSavingsRatio === undefined) {
    return unavailable(input.benchmarkId, problems);
  }

  const qualityNonInferior = candidate.qualityScore >= control.qualityScore;
  const savingsUsd = control.costUsd - candidate.costUsd;
  const savingsRatio = control.costUsd === 0 ? 0 : savingsUsd / control.costUsd;
  const costImproved = savingsUsd > 0 && savingsRatio >= input.minimumSavingsRatio;
  return { schemaVersion: 1, benchmarkId: input.benchmarkId!, status: "unavailable",
    structuralOutcome: qualityNonInferior && costImproved ? "candidate_lower_cost" : "not_better",
    scope: "frozen paired engineering case only", costEfficiencyClaimAllowed: false,
    qualityNonInferior, costImproved, minimumSavingsRatio: input.minimumSavingsRatio,
    savingsUsd, savingsRatio, arms: { candidate, control },
    problems: ["cryptographic gateway billing and harness-journal attestations are not implemented"] };
}

function validateArm(name: string, rawArm: unknown, taskDigest: string | undefined, baselineDigest: string | undefined,
  routePolicy: { readonly provider: string; readonly roleModels: Readonly<Record<string, string>> } | undefined,
  qualityPolicy: PiCostComparisonEvidence["qualityPolicy"] | undefined,
  expectedRoleCounts: Readonly<Record<string, number>> | undefined,
  priceVersionPolicy: Readonly<Record<string, string>> | undefined, problems: string[]): ArmSummary | undefined {
  if (!isRecord(rawArm)) { problems.push(`${name} arm missing`); return undefined; }
  const arm = rawArm as Partial<PiCostArmEvidence>;
  if (arm.taskDigest !== taskDigest) problems.push(`${name} task digest mismatch`);
  if (arm.status !== "completed" && arm.status !== "failed") problems.push(`${name} terminal status missing`);
  if (arm.status !== "completed") problems.push(`${name} did not complete`);
  const checkpointRestored = isRecord(arm.checkpoint) && nonempty(baselineDigest)
    && arm.checkpoint.beforeCloseDigest === baselineDigest && arm.checkpoint.afterOpenDigest === baselineDigest;
  if (!checkpointRestored) problems.push(`${name} checkpoint was not restored before execution`);
  if (!qualityPolicy || arm.scorerId !== qualityPolicy.scorerId) problems.push(`${name} scorer identity mismatch`);
  const checks = Array.isArray(arm.checks) && arm.checks.every((check) => isRecord(check)
    && typeof check.name === "string" && typeof check.pass === "boolean") ? arm.checks : undefined;
  if (!checks) problems.push(`${name} deterministic checks malformed`);
  const checkNames = checks?.map((check) => check.name) ?? [];
  const verificationPassed = qualityPolicy !== undefined && checks !== undefined
    && sameStrings(checkNames, qualityPolicy.requiredChecks) && checks.every((check) => check.pass === true);
  if (!verificationPassed) problems.push(`${name} deterministic verification failed`);
  const changedFiles = stringArray(arm.changedFiles);
  if (!qualityPolicy || !changedFiles || !sameStrings(changedFiles, qualityPolicy.allowedChangedFiles)) {
    problems.push(`${name} changed-file boundary mismatch`);
  }
  const calls = Array.isArray(arm.calls) ? arm.calls : undefined;
  const receiptsInput = Array.isArray(arm.receipts) ? arm.receipts : undefined;
  if (!calls?.length) { problems.push(`${name} calls missing`); return undefined; }
  if (!receiptsInput) { problems.push(`${name} receipts missing`); return undefined; }
  if (!routePolicy?.provider || !isRecord(routePolicy.roleModels) || Object.keys(routePolicy.roleModels).length === 0) {
    problems.push(`${name} route policy missing`);
  }
  const roleCountPolicy = validRoleCounts(expectedRoleCounts) ? expectedRoleCounts : {};
  if (Object.keys(roleCountPolicy).length === 0) problems.push(`${name} expected role counts invalid`);
  const pinnedPrices = validStringRecord(priceVersionPolicy) ? priceVersionPolicy : {};
  if (Object.keys(pinnedPrices).length === 0) problems.push(`${name} price-version policy invalid`);

  const receipts = new Map<string, PiGatewayCostReceipt>();
  const gatewayIds = new Set<string>();
  for (const item of receiptsInput) {
    if (!isRecord(item) || !nonempty(item.executionId)) { problems.push(`${name} receipt identity missing`); continue; }
    const receipt = item as unknown as PiGatewayCostReceipt;
    if (receipts.has(receipt.executionId)) { problems.push(`${name} duplicate receipt ${receipt.executionId}`); continue; }
    if (!nonempty(receipt.gatewayRequestId) || gatewayIds.has(receipt.gatewayRequestId)) {
      problems.push(`${name} duplicate or missing gateway request identity`);
    } else gatewayIds.add(receipt.gatewayRequestId);
    receipts.set(receipt.executionId, receipt);
  }
  const callIds = new Set<string>(); const roleCounts: Record<string, number> = {};
  let costUsd = 0; let inputTokens = 0; let outputTokens = 0;
  for (const item of calls) {
    if (!isRecord(item) || !nonempty(item.executionId)) { problems.push(`${name} duplicate or missing call identity`); continue; }
    const call = item as unknown as PiCostCall;
    if (callIds.has(call.executionId)) { problems.push(`${name} duplicate or missing call identity`); continue; }
    callIds.add(call.executionId); roleCounts[call.role] = (roleCounts[call.role] ?? 0) + 1;
    if (call.provider !== routePolicy?.provider || routePolicy?.roleModels[call.role] !== call.model) {
      problems.push(`${name} undeclared route ${String(call.role)}:${String(call.provider)}/${String(call.model)}`);
    }
    const receipt = receipts.get(call.executionId);
    if (!receipt) { problems.push(`${name} receipt missing for ${call.executionId}`); continue; }
    if (receipt.source !== "gateway_versioned_customer_billing") problems.push(`${name} receipt source is not authoritative`);
    if (!nonempty(receipt.priceVersionId) || receipt.priceVersionId !== pinnedPrices[call.model]) {
      problems.push(`${name} receipt price version mismatch`);
    }
    if (receipt.settlementStatus !== "settled") problems.push(`${name} receipt is not settled`);
    if (receipt.role !== call.role || receipt.provider !== call.provider || receipt.model !== call.model) problems.push(`${name} receipt route mismatch`);
    for (const [field, value] of [["inputTokens", receipt.inputTokens], ["outputTokens", receipt.outputTokens],
      ["customerCostUsd", receipt.customerCostUsd]] as const) if (!finiteNonnegative(value)) problems.push(`${name} receipt ${field} invalid`);
    if (!safeToken(call.inputTokens) || !safeToken(call.outputTokens)
      || receipt.inputTokens !== call.inputTokens || receipt.outputTokens !== call.outputTokens) problems.push(`${name} receipt token mismatch`);
    costUsd += receipt.customerCostUsd; inputTokens += receipt.inputTokens; outputTokens += receipt.outputTokens;
  }
  if (!Number.isFinite(costUsd) || !Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) problems.push(`${name} aggregate overflow`);
  for (const [role, count] of Object.entries(roleCountPolicy)) if (roleCounts[role] !== count) problems.push(`${name} role denominator mismatch: ${role}`);
  for (const role of Object.keys(roleCounts)) if (!(role in roleCountPolicy)) problems.push(`${name} undeclared role denominator: ${role}`);
  for (const id of receipts.keys()) if (!callIds.has(id)) problems.push(`${name} unbound receipt ${id}`);
  if (!isRecord(arm.localBudget) || arm.localBudget.activeReservations !== 0 || arm.localBudget.paidCalls !== calls.length) {
    problems.push(`${name} local budget denominator mismatch`);
  }
  return { status: String(arm.status), qualityScore: verificationPassed ? 1 : 0, verificationPassed,
    checkpointRestored, callCount: calls.length, inputTokens, outputTokens, costUsd,
    executionIds: [...callIds], gatewayRequestIds: [...gatewayIds] };
}

function validateCombinedBudget(candidate: ArmSummary, control: ArmSummary,
  policy: PiCostComparisonEvidence["budgetPolicy"] | undefined, problems: string[]): void {
  if (!policy || !Number.isSafeInteger(policy.maximumCombinedPaidCalls) || policy.maximumCombinedPaidCalls <= 0
    || !finitePositive(policy.maximumCombinedUsd) || !Number.isSafeInteger(policy.maximumInputTokens) || policy.maximumInputTokens <= 0
    || !Number.isSafeInteger(policy.maximumOutputTokens) || policy.maximumOutputTokens <= 0) {
    problems.push("combined budget policy invalid"); return;
  }
  if (candidate.callCount + control.callCount > policy.maximumCombinedPaidCalls) problems.push("combined paid-call cap exceeded");
  if (candidate.costUsd + control.costUsd > policy.maximumCombinedUsd) problems.push("combined USD cap exceeded");
  if (candidate.inputTokens + control.inputTokens > policy.maximumInputTokens) problems.push("combined input-token cap exceeded");
  if (candidate.outputTokens + control.outputTokens > policy.maximumOutputTokens) problems.push("combined output-token cap exceeded");
}

function rejectSharedIds(left: readonly string[], right: readonly string[], label: string, problems: string[]): void {
  const seen = new Set(left); if (right.some((id) => seen.has(id))) problems.push(`paired arms share ${label} identity`);
}
function validRoleCounts(value: unknown): value is Readonly<Record<string, number>> {
  return isRecord(value) && Object.keys(value).length > 0 && Object.values(value).every((count) => Number.isSafeInteger(count) && count > 0);
}
function validStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.keys(value).length > 0 && Object.values(value).every(nonempty);
}
function validQualityPolicy(value: unknown): value is PiCostComparisonEvidence["qualityPolicy"] {
  return isRecord(value) && nonempty(value.scorerId) && stringArray(value.requiredChecks) !== undefined
    && value.requiredChecks.length > 0 && stringArray(value.allowedChangedFiles) !== undefined
    && value.allowedChangedFiles.length > 0;
}
function stringArray(value: unknown): readonly string[] | undefined { return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined; }
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function finiteNonnegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function finitePositive(value: unknown): value is number { return finiteNonnegative(value) && value > 0; }
function safeToken(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

function unavailable(benchmarkId: unknown, problems: readonly string[]): PiCostComparisonResult {
  return { schemaVersion: 1, benchmarkId: typeof benchmarkId === "string" && benchmarkId ? benchmarkId : "unknown",
    status: "unavailable", structuralOutcome: "invalid", scope: "frozen paired engineering case only",
    costEfficiencyClaimAllowed: false, qualityNonInferior: false, costImproved: false, problems };
}
