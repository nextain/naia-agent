export interface GroundingRecord {
	readonly text: string;
	readonly sourceUri: string;
	readonly label: string;
}
export interface NormalizedGroundingRecords {
	readonly evidence: readonly { readonly sourceHandle: string; readonly text: string }[];
	readonly sources: readonly {
		readonly sourceHandle: string; readonly label: string; readonly canonicalUri: string;
	}[];
}

const MAX_RECORDS = 8;
const MAX_CANDIDATES = 64;
const MAX_RECORD_SCALARS = 4_000;
const MAX_TOTAL_SCALARS = 16_000;
const MAX_LABEL_SCALARS = 80;
const MAX_CANONICAL_URI_SCALARS = 4_096;

function truncateScalars(value: string, maximum: number): string {
	let result = "";
	let count = 0;
	for (const scalar of value) {
		if (count >= maximum) break;
		result += scalar;
		count += 1;
	}
	return result;
}
function exceedsScalarLimit(value: string, maximum: number): boolean {
	let count = 0;
	for (const _scalar of value) {
		count += 1;
		if (count > maximum) return true;
	}
	return false;
}
function isRecord(value: unknown): value is GroundingRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.text === "string" && typeof record.sourceUri === "string"
		&& typeof record.label === "string";
}

export function normalizeGroundingRecords(value: unknown): NormalizedGroundingRecords {
	if (!Array.isArray(value)) return { evidence: [], sources: [] };
	let remaining = MAX_TOTAL_SCALARS;
	const evidence: Array<{ sourceHandle: string; text: string }> = [];
	const sources: Array<{ sourceHandle: string; label: string; canonicalUri: string }> = [];
	for (const candidate of value.slice(0, MAX_CANDIDATES)) {
		if (evidence.length >= MAX_RECORDS || remaining <= 0) break;
		if (!isRecord(candidate) || exceedsScalarLimit(candidate.sourceUri, MAX_CANONICAL_URI_SCALARS)) continue;
		const canonicalUri = candidate.sourceUri.trim();
		const normalized = candidate.text.trim();
		if (!canonicalUri || !normalized) continue;
		const text = truncateScalars(normalized, Math.min(MAX_RECORD_SCALARS, remaining));
		if (!text) continue;
		const sourceHandle = `S${evidence.length + 1}`;
		const label = truncateScalars(candidate.label.trim(), MAX_LABEL_SCALARS)
			|| `자료 ${evidence.length + 1}`;
		evidence.push({ sourceHandle, text });
		sources.push({ sourceHandle, label, canonicalUri });
		remaining -= Array.from(text).length;
	}
	return { evidence, sources };
}
