import type { ActorReceipt } from "../domain/issue-orchestration.js";

export interface PiCostAttestation {
  readonly schemaVersion: 1;
  readonly algorithm: "hmac-sha256";
  readonly keyId: string;
  readonly evidenceDigest: string;
  readonly mac: string;
}

export type PiCostAttestationVerifier = (evidence: Readonly<Record<string, unknown>>,
  attestation: unknown) => readonly string[];

export interface PiActorAttempt {
  readonly executionId: string;
  readonly role: string;
  readonly provider: string;
  readonly model: string;
}

export interface PiCostCall extends PiActorAttempt {
  /** Parent actor execution that caused this request. */
  readonly actorExecutionId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface PiGatewayCostReceipt extends PiCostCall {
  readonly gatewayRequestId: string;
  readonly priceVersionId: string;
  readonly source: "gateway_versioned_customer_billing";
  readonly settlementStatus: string;
  readonly customerCostDecimal: string;
  readonly customerCostUsd: number;
}

export interface PiCostJournalReceipt extends PiGatewayCostReceipt {
  readonly journalEntryDigest: string;
  readonly ledgerReceiptDigest: string;
}

export interface PiCostSourceAudit {
  readonly journalHeads: readonly {
    readonly executionId: string; readonly headDigest: string; readonly entryCount: number;
  }[];
  readonly journalReceipts: readonly PiCostJournalReceipt[];
  readonly gatewayLedger: readonly {
    readonly requestId: string; readonly status: "active" | "settled";
    readonly actualCostDecimal?: string; readonly actualInputTokens?: number;
    readonly actualOutputTokens?: number; readonly receiptDigest?: string;
  }[];
  readonly gatewayBudget: {
    readonly gatewayCalls: number; readonly activeReservations: number;
    readonly chargedUsdDecimal: string; readonly chargedInputTokens: number; readonly chargedOutputTokens: number;
  };
}

export interface PiCostArmEvidence {
  readonly taskDigest: string;
  readonly status: string;
  readonly checkpoint: { readonly beforeCloseDigest: string; readonly afterOpenDigest: string };
  readonly scorerId: string;
  readonly checks: readonly { readonly name: string; readonly pass: boolean }[];
  readonly changedFiles: readonly string[];
  readonly actorAttempts: readonly PiActorAttempt[];
  readonly calls: readonly PiCostCall[];
  readonly receipts: readonly PiGatewayCostReceipt[];
  readonly sourceAudit: PiCostSourceAudit;
  readonly localBudget: { readonly paidCalls: number; readonly activeReservations: number };
}

export interface PiCostComparisonEvidence {
  readonly schemaVersion: 2;
  readonly benchmarkId: string;
  readonly taskDigest: string;
  readonly baselineDigest: string;
  readonly minimumSavingsBasisPoints: number;
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
    readonly maximumCombinedActorAttempts: number;
    readonly maximumCombinedGatewayCalls: number;
    readonly maximumCombinedUsdDecimal: string;
    readonly maximumInputTokens: number;
    readonly maximumOutputTokens: number;
  };
  readonly priceVersionPolicy: Readonly<Record<string, string>>;
  readonly trustedRuntimeModules: readonly string[];
  readonly trustedRuntimeDigests: Readonly<Record<string, string>>;
  readonly trustedRuntimeClosureDigest: string;
  readonly sharedGatewayLedger: {
    readonly rows: PiCostSourceAudit["gatewayLedger"];
    readonly snapshot: PiCostSourceAudit["gatewayBudget"];
  };
  readonly candidate: PiCostArmEvidence;
  readonly control: PiCostArmEvidence;
  readonly attestation: PiCostAttestation;
}

interface ArmSummary {
  readonly status: string;
  readonly qualityScore: number;
  readonly verificationPassed: boolean;
  readonly checkpointRestored: boolean;
  readonly actorAttemptCount: number;
  readonly gatewayCallCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly costUsdDecimal: string;
  readonly executionIds: readonly string[];
  readonly gatewayRequestIds: readonly string[];
}

export interface PiCostComparisonResult {
  readonly schemaVersion: 2;
  readonly benchmarkId: string;
  readonly status: "verified" | "unavailable";
  readonly structuralOutcome: "candidate_lower_cost" | "not_better" | "invalid";
  readonly scope: "frozen paired engineering case only";
  readonly costEfficiencyClaimAllowed: boolean;
  readonly qualityNonInferior: boolean;
  readonly costImproved: boolean;
  readonly minimumSavingsRatio?: number;
  readonly minimumSavingsBasisPoints?: number;
  readonly savingsUsd?: number;
  readonly savingsUsdDecimal?: string;
  readonly savingsRatio?: number;
  readonly arms?: { readonly candidate: ArmSummary; readonly control: ArmSummary };
  readonly problems: readonly string[];
}

/** Converts durable actor attempts plus their nested request receipts into the paired-benchmark rows. */
export function actorReceiptsToPiCostRows(receipts: readonly ActorReceipt[]): {
  readonly actorAttempts: readonly PiActorAttempt[];
  readonly calls: readonly PiCostCall[];
  readonly receipts: readonly PiGatewayCostReceipt[];
} {
  const actorAttempts: PiActorAttempt[] = []; const calls: PiCostCall[] = []; const gatewayReceipts: PiGatewayCostReceipt[] = [];
  for (const actor of receipts) {
    if (!actor.gatewayBillingReceipts?.length) continue;
    const role = actor.workerRole ?? (actor.role === "naia" ? "facing" : actor.role);
    actorAttempts.push({ executionId: actor.executionId, role, provider: actor.provider, model: actor.model });
    for (const row of actor.gatewayBillingReceipts) {
      const call: PiCostCall = { executionId: row.localRequestId, actorExecutionId: actor.executionId,
        role, provider: actor.provider, model: actor.model,
        inputTokens: row.inputTokens + row.cachedInputTokens, outputTokens: row.outputTokens };
      calls.push(call);
      gatewayReceipts.push({ ...call, gatewayRequestId: row.gatewayRequestId,
        priceVersionId: row.priceVersionId, source: row.source, settlementStatus: row.settlementStatus,
        customerCostDecimal: row.customerCostDecimal, customerCostUsd: row.customerCostUsd });
    }
  }
  return { actorAttempts, calls, receipts: gatewayReceipts };
}

/**
 * Checks paired evidence and only permits a scoped claim when the complete evidence is bound to
 * the frozen external HMAC authority. The gateway fields are observations from the authenticated
 * request-correlated response, not a claim of a third-party server signature.
 */
export function analyzePiCostComparison(raw: unknown, verifyAttestation?: PiCostAttestationVerifier): PiCostComparisonResult {
  if (!isRecord(raw)) return unavailable("unknown", ["comparison evidence must be an object"]);
  const input = raw as Partial<PiCostComparisonEvidence>;
  const problems: string[] = [];
  if (input.schemaVersion !== 2) problems.push("unsupported schemaVersion");
  if (typeof input.benchmarkId !== "string" || !input.benchmarkId) problems.push("benchmarkId missing");
  if (typeof input.taskDigest !== "string" || !input.taskDigest) problems.push("taskDigest missing");
  if (typeof input.baselineDigest !== "string" || !input.baselineDigest) problems.push("baselineDigest missing");
  if (!Number.isSafeInteger(input.minimumSavingsBasisPoints) || input.minimumSavingsBasisPoints! < 0
    || input.minimumSavingsBasisPoints! >= 10_000) {
    problems.push("minimumSavingsBasisPoints must be in [0,10000)");
  }
  const qualityPolicy = validQualityPolicy(input.qualityPolicy) ? input.qualityPolicy : undefined;
  if (!qualityPolicy) problems.push("quality policy invalid");
  validateTrustedRuntime(input.trustedRuntimeModules, input.trustedRuntimeDigests,
    input.trustedRuntimeClosureDigest, problems);
  const candidate = validateArm("candidate", input.candidate, input.taskDigest, input.baselineDigest,
    input.routePolicy?.candidate, qualityPolicy, input.expectedRoleCounts, input.priceVersionPolicy, problems);
  const control = validateArm("control", input.control, input.taskDigest, input.baselineDigest,
    input.routePolicy?.control, qualityPolicy, input.expectedRoleCounts, input.priceVersionPolicy, problems);
  if (candidate && control) {
    rejectSharedIds(candidate.executionIds, control.executionIds, "execution", problems);
    rejectSharedIds(candidate.gatewayRequestIds, control.gatewayRequestIds, "gateway request", problems);
    validateCombinedBudget(candidate, control, input.budgetPolicy, problems);
    validateSharedGatewayLedger(input.sharedGatewayLedger, input.candidate, input.control, problems);
  }
  const { attestation: _attestation, ...unsignedEvidence } = raw;
  if (!verifyAttestation) problems.push("benchmark attestation authority unavailable");
  else problems.push(...verifyAttestation(unsignedEvidence, input.attestation));
  if (problems.length > 0 || !candidate || !control || input.minimumSavingsBasisPoints === undefined) {
    return unavailable(input.benchmarkId, problems);
  }

  const qualityNonInferior = candidate.qualityScore >= control.qualityScore;
  const candidateUnits = moneyUnits8(candidate.costUsdDecimal)!;
  const controlUnits = moneyUnits8(control.costUsdDecimal)!;
  const savingsUnits = controlUnits - candidateUnits;
  const savingsUsdDecimal = signedMoneyDecimal8(savingsUnits);
  const savingsUsd = Number(savingsUsdDecimal);
  const savingsRatio = controlUnits === 0n ? 0 : Number(savingsUnits) / Number(controlUnits);
  const costImproved = savingsUnits > 0n
    && savingsUnits * 10_000n >= controlUnits * BigInt(input.minimumSavingsBasisPoints);
  return { schemaVersion: 2, benchmarkId: input.benchmarkId!, status: "verified",
    structuralOutcome: qualityNonInferior && costImproved ? "candidate_lower_cost" : "not_better",
    scope: "frozen paired engineering case only", costEfficiencyClaimAllowed: qualityNonInferior && costImproved,
    qualityNonInferior, costImproved, minimumSavingsBasisPoints: input.minimumSavingsBasisPoints,
    minimumSavingsRatio: input.minimumSavingsBasisPoints / 10_000,
    savingsUsd, savingsUsdDecimal, savingsRatio, arms: { candidate, control },
    problems: [] };
}

function validateTrustedRuntime(modules: unknown, digests: unknown, closureDigest: unknown, problems: string[]): void {
  const names = stringArray(modules);
  if (!names?.length || new Set(names).size !== names.length || !validStringRecord(digests)
    || !sameStrings([...Object.keys(digests)].sort(), [...(names ?? [])].sort())
    || Object.values(digests ?? {}).some((digest) => !/^sha256:[0-9a-f]{64}$/u.test(String(digest)))
    || typeof closureDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(closureDigest)) {
    problems.push("trusted runtime evidence invalid");
  }
}

function validateSharedGatewayLedger(raw: unknown, candidateRaw: unknown, controlRaw: unknown,
  problems: string[]): void {
  if (!isRecord(raw) || !Array.isArray(raw.rows) || !isRecord(raw.snapshot)
    || !isRecord(candidateRaw) || !isRecord(controlRaw)
    || !isRecord(candidateRaw.sourceAudit) || !Array.isArray(candidateRaw.sourceAudit.gatewayLedger)
    || !isRecord(controlRaw.sourceAudit) || !Array.isArray(controlRaw.sourceAudit.gatewayLedger)) {
    problems.push("shared gateway ledger evidence malformed"); return;
  }
  const requestId = (value: unknown): string => isRecord(value) ? String(value.requestId ?? "") : "";
  const expected = [...candidateRaw.sourceAudit.gatewayLedger, ...controlRaw.sourceAudit.gatewayLedger]
    .sort((left, right) => requestId(left).localeCompare(requestId(right)));
  const actual = [...raw.rows].sort((left, right) => requestId(left).localeCompare(requestId(right)));
  if (!sameJson(expected, actual)) problems.push("shared gateway ledger does not equal both arm deltas");
  let costUnits = 0n; let inputTokens = 0; let outputTokens = 0; let activeReservations = 0;
  for (const row of actual) {
    if (!isRecord(row) || row.status !== "settled") { activeReservations += 1; continue; }
    const units = moneyUnits8(row.actualCostDecimal);
    if (units !== undefined) costUnits += units;
    if (safeToken(row.actualInputTokens)) inputTokens += row.actualInputTokens;
    if (safeToken(row.actualOutputTokens)) outputTokens += row.actualOutputTokens;
  }
  if (raw.snapshot.gatewayCalls !== actual.length || raw.snapshot.activeReservations !== activeReservations
    || raw.snapshot.chargedUsdDecimal !== moneyDecimal8(costUnits)
    || raw.snapshot.chargedInputTokens !== inputTokens || raw.snapshot.chargedOutputTokens !== outputTokens) {
    problems.push("shared gateway ledger aggregate mismatch");
  }
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
  const actorAttempts = Array.isArray(arm.actorAttempts) ? arm.actorAttempts : undefined;
  const calls = Array.isArray(arm.calls) ? arm.calls : undefined;
  const receiptsInput = Array.isArray(arm.receipts) ? arm.receipts : undefined;
  if (!actorAttempts?.length) { problems.push(`${name} actor attempts missing`); return undefined; }
  if (!calls?.length) { problems.push(`${name} calls missing`); return undefined; }
  if (!receiptsInput) { problems.push(`${name} receipts missing`); return undefined; }
  const declaredRoute = routePolicy?.provider && isRecord(routePolicy.roleModels)
    && Object.keys(routePolicy.roleModels).length > 0 ? routePolicy : undefined;
  if (!declaredRoute) {
    problems.push(`${name} route policy missing`);
  }
  const roleCountPolicy = validRoleCounts(expectedRoleCounts) ? expectedRoleCounts : {};
  if (Object.keys(roleCountPolicy).length === 0) problems.push(`${name} expected role counts invalid`);
  const pinnedPrices = validStringRecord(priceVersionPolicy) ? priceVersionPolicy : {};
  if (Object.keys(pinnedPrices).length === 0) problems.push(`${name} price-version policy invalid`);

  const actors = new Map<string, PiActorAttempt>(); const roleCounts: Record<string, number> = {};
  for (const item of actorAttempts) {
    if (!isRecord(item) || !nonempty(item.executionId) || actors.has(String(item.executionId))) {
      problems.push(`${name} duplicate or missing actor identity`); continue;
    }
    const actor = item as unknown as PiActorAttempt;
    actors.set(actor.executionId, actor); roleCounts[actor.role] = (roleCounts[actor.role] ?? 0) + 1;
    if (actor.provider !== declaredRoute?.provider || declaredRoute?.roleModels[actor.role] !== actor.model) {
      problems.push(`${name} undeclared actor route ${String(actor.role)}:${String(actor.provider)}/${String(actor.model)}`);
    }
  }
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
  const callIds = new Set<string>();
  let costUnits = 0n; let inputTokens = 0; let outputTokens = 0;
  for (const item of calls) {
    if (!isRecord(item) || !nonempty(item.executionId)) { problems.push(`${name} duplicate or missing call identity`); continue; }
    const call = item as unknown as PiCostCall;
    if (callIds.has(call.executionId)) { problems.push(`${name} duplicate or missing call identity`); continue; }
    callIds.add(call.executionId);
    const actor = actors.get(call.actorExecutionId);
    if (!actor || actor.role !== call.role || actor.provider !== call.provider || actor.model !== call.model) {
      problems.push(`${name} gateway call actor binding mismatch`);
    }
    if (call.provider !== declaredRoute?.provider || declaredRoute?.roleModels[call.role] !== call.model) {
      problems.push(`${name} undeclared route ${String(call.role)}:${String(call.provider)}/${String(call.model)}`);
    }
    const receipt = receipts.get(call.executionId);
    if (!receipt) { problems.push(`${name} receipt missing for ${call.executionId}`); continue; }
    if (receipt.source !== "gateway_versioned_customer_billing") problems.push(`${name} receipt source is not authoritative`);
    if (!nonempty(receipt.priceVersionId) || receipt.priceVersionId !== pinnedPrices[call.model]) {
      problems.push(`${name} receipt price version mismatch`);
    }
    if (receipt.settlementStatus !== "settled") problems.push(`${name} receipt is not settled`);
    if (receipt.actorExecutionId !== call.actorExecutionId || receipt.role !== call.role
      || receipt.provider !== call.provider || receipt.model !== call.model) problems.push(`${name} receipt route mismatch`);
    for (const [field, value] of [["inputTokens", receipt.inputTokens], ["outputTokens", receipt.outputTokens]] as const) {
      if (!finiteNonnegative(value)) problems.push(`${name} receipt ${field} invalid`);
    }
    const receiptCostUnits = moneyUnits8(receipt.customerCostDecimal);
    if (receiptCostUnits === undefined || !finiteNonnegative(receipt.customerCostUsd)
      || receipt.customerCostUsd !== Number(receipt.customerCostDecimal)) {
      problems.push(`${name} receipt customer cost invalid`);
    } else costUnits += receiptCostUnits;
    if (!safeToken(call.inputTokens) || !safeToken(call.outputTokens)
      || receipt.inputTokens !== call.inputTokens || receipt.outputTokens !== call.outputTokens) problems.push(`${name} receipt token mismatch`);
    inputTokens += receipt.inputTokens; outputTokens += receipt.outputTokens;
  }
  const costUsdDecimal = moneyDecimal8(costUnits); const costUsd = Number(costUsdDecimal);
  if (!Number.isFinite(costUsd) || !Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) problems.push(`${name} aggregate overflow`);
  for (const [role, count] of Object.entries(roleCountPolicy)) if (roleCounts[role] !== count) problems.push(`${name} role denominator mismatch: ${role}`);
  for (const role of Object.keys(roleCounts)) if (!(role in roleCountPolicy)) problems.push(`${name} undeclared role denominator: ${role}`);
  for (const id of receipts.keys()) if (!callIds.has(id)) problems.push(`${name} unbound receipt ${id}`);
  validateSourceAudit(name, arm.sourceAudit, [...receipts.values()], problems);
  if (!isRecord(arm.localBudget) || arm.localBudget.activeReservations !== 0
    || arm.localBudget.paidCalls !== actorAttempts.length) {
    problems.push(`${name} local budget denominator mismatch`);
  }
  return { status: String(arm.status), qualityScore: verificationPassed ? 1 : 0, verificationPassed,
    checkpointRestored, actorAttemptCount: actorAttempts.length, gatewayCallCount: calls.length,
    inputTokens, outputTokens, costUsd, costUsdDecimal,
    executionIds: [...actors.keys(), ...callIds], gatewayRequestIds: [...gatewayIds] };
}

function validateCombinedBudget(candidate: ArmSummary, control: ArmSummary,
  policy: PiCostComparisonEvidence["budgetPolicy"] | undefined, problems: string[]): void {
  if (!policy || !Number.isSafeInteger(policy.maximumCombinedActorAttempts) || policy.maximumCombinedActorAttempts <= 0
    || !Number.isSafeInteger(policy.maximumCombinedGatewayCalls) || policy.maximumCombinedGatewayCalls <= 0
    || moneyUnits8(policy.maximumCombinedUsdDecimal) === undefined
    || moneyUnits8(policy.maximumCombinedUsdDecimal)! <= 0n
    || !Number.isSafeInteger(policy.maximumInputTokens) || policy.maximumInputTokens <= 0
    || !Number.isSafeInteger(policy.maximumOutputTokens) || policy.maximumOutputTokens <= 0) {
    problems.push("combined budget policy invalid"); return;
  }
  if (candidate.actorAttemptCount + control.actorAttemptCount > policy.maximumCombinedActorAttempts) problems.push("combined actor-attempt cap exceeded");
  if (candidate.gatewayCallCount + control.gatewayCallCount > policy.maximumCombinedGatewayCalls) problems.push("combined gateway-call cap exceeded");
  if (moneyUnits8(candidate.costUsdDecimal)! + moneyUnits8(control.costUsdDecimal)!
    > moneyUnits8(policy.maximumCombinedUsdDecimal)!) problems.push("combined USD cap exceeded");
  if (candidate.inputTokens + control.inputTokens > policy.maximumInputTokens) problems.push("combined input-token cap exceeded");
  if (candidate.outputTokens + control.outputTokens > policy.maximumOutputTokens) problems.push("combined output-token cap exceeded");
}

function validateSourceAudit(name: string, rawAudit: unknown, receipts: readonly PiGatewayCostReceipt[],
  problems: string[]): void {
  if (!isRecord(rawAudit)) { problems.push(`${name} source audit missing`); return; }
  const audit = rawAudit as Partial<PiCostSourceAudit>;
  if (!Array.isArray(audit.journalHeads) || !Array.isArray(audit.journalReceipts)
    || !Array.isArray(audit.gatewayLedger) || !isRecord(audit.gatewayBudget)) {
    problems.push(`${name} source audit malformed`); return;
  }
  const heads = new Map<string, { readonly headDigest: string; readonly entryCount: number }>();
  let journalEntryCount = 0;
  for (const item of audit.journalHeads) {
    if (!isRecord(item) || !nonempty(item.executionId) || !nonempty(item.headDigest)
      || !Number.isSafeInteger(item.entryCount) || item.entryCount < 0 || heads.has(item.executionId)) {
      problems.push(`${name} journal head evidence malformed`); continue;
    }
    heads.set(item.executionId, { headDigest: item.headDigest, entryCount: item.entryCount });
    journalEntryCount += item.entryCount;
  }
  const journalRows = new Map<string, PiCostJournalReceipt>();
  for (const item of audit.journalReceipts) {
    if (!isRecord(item) || !nonempty(item.executionId) || !nonempty(item.actorExecutionId)
      || !nonempty(item.gatewayRequestId) || !nonempty(item.journalEntryDigest)
      || !nonempty(item.ledgerReceiptDigest) || journalRows.has(item.executionId)) {
      problems.push(`${name} journal receipt evidence malformed`); continue;
    }
    const row = item as unknown as PiCostJournalReceipt;
    if (!heads.has(row.actorExecutionId)) problems.push(`${name} journal receipt has no journal head`);
    journalRows.set(row.executionId, row);
  }
  if (journalEntryCount !== audit.journalReceipts.length) problems.push(`${name} journal entry denominator mismatch`);
  if (journalRows.size !== receipts.length) problems.push(`${name} submitted receipt set differs from preserved journals`);
  for (const receipt of receipts) {
    const journal = journalRows.get(receipt.executionId);
    if (!journal || !sameReceipt(receipt, journal)) problems.push(`${name} submitted receipt differs from preserved journal`);
  }

  const ledger = new Map<string, PiCostSourceAudit["gatewayLedger"][number]>();
  let ledgerCostUnits = 0n; let ledgerInputTokens = 0; let ledgerOutputTokens = 0; let activeReservations = 0;
  for (const item of audit.gatewayLedger) {
    if (!isRecord(item) || !nonempty(item.requestId) || ledger.has(item.requestId)
      || (item.status !== "active" && item.status !== "settled")) {
      problems.push(`${name} gateway ledger evidence malformed`); continue;
    }
    ledger.set(item.requestId, item as PiCostSourceAudit["gatewayLedger"][number]);
    if (item.status === "active") { activeReservations += 1; continue; }
    const units = moneyUnits8(item.actualCostDecimal);
    if (units === undefined || !safeToken(item.actualInputTokens) || !safeToken(item.actualOutputTokens)
      || !nonempty(item.receiptDigest)) {
      problems.push(`${name} settled gateway ledger evidence malformed`); continue;
    }
    ledgerCostUnits += units; ledgerInputTokens += item.actualInputTokens; ledgerOutputTokens += item.actualOutputTokens;
  }
  if (activeReservations !== 0) problems.push(`${name} gateway ledger has active reservations`);
  if (ledger.size !== receipts.length) problems.push(`${name} submitted receipt set differs from gateway ledger`);
  for (const receipt of receipts) {
    const row = ledger.get(receipt.gatewayRequestId); const journal = journalRows.get(receipt.executionId);
    if (!row || row.status !== "settled" || row.actualCostDecimal !== receipt.customerCostDecimal
      || row.actualInputTokens !== receipt.inputTokens || row.actualOutputTokens !== receipt.outputTokens
      || row.receiptDigest !== journal?.ledgerReceiptDigest) {
      problems.push(`${name} submitted receipt differs from gateway ledger`);
    }
  }
  const budget = audit.gatewayBudget;
  if (!Number.isSafeInteger(budget.gatewayCalls) || budget.gatewayCalls !== ledger.size
    || budget.activeReservations !== activeReservations || budget.chargedUsdDecimal !== moneyDecimal8(ledgerCostUnits)
    || budget.chargedInputTokens !== ledgerInputTokens || budget.chargedOutputTokens !== ledgerOutputTokens) {
    problems.push(`${name} gateway budget denominator mismatch`);
  }
}

function sameReceipt(left: PiGatewayCostReceipt, right: PiGatewayCostReceipt): boolean {
  return left.executionId === right.executionId && left.actorExecutionId === right.actorExecutionId
    && left.gatewayRequestId === right.gatewayRequestId && left.priceVersionId === right.priceVersionId
    && left.source === right.source && left.settlementStatus === right.settlementStatus
    && left.role === right.role && left.provider === right.provider && left.model === right.model
    && left.inputTokens === right.inputTokens && left.outputTokens === right.outputTokens
    && left.customerCostDecimal === right.customerCostDecimal && left.customerCostUsd === right.customerCostUsd;
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
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right)); }
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  return value;
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function finiteNonnegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function safeToken(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function moneyUnits8(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/u.test(value)) return undefined;
  const [whole, fraction = ""] = value.split(".");
  const units = BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
  return units <= BigInt(Number.MAX_SAFE_INTEGER) ? units : undefined;
}
function moneyDecimal8(units: bigint): string {
  const whole = units / 100_000_000n; const fraction = String(units % 100_000_000n).padStart(8, "0");
  return `${whole}.${fraction}`;
}
function signedMoneyDecimal8(units: bigint): string {
  return units < 0n ? `-${moneyDecimal8(-units)}` : moneyDecimal8(units);
}

function unavailable(benchmarkId: unknown, problems: readonly string[]): PiCostComparisonResult {
  return { schemaVersion: 2, benchmarkId: typeof benchmarkId === "string" && benchmarkId ? benchmarkId : "unknown",
    status: "unavailable", structuralOutcome: "invalid", scope: "frozen paired engineering case only",
    costEfficiencyClaimAllowed: false, qualityNonInferior: false, costImproved: false, problems };
}
