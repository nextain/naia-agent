import { describe, expect, it } from "vitest";
import { normalizeGroundingRecords } from "../main/domain/grounding-normalization.js";

describe("PROPOSED-REQ-GR-05 partial", () => {
	it("record 4,000·합계 16,000 scalar budget과 동일 handle 순서를 지킨다", () => {
		const result = normalizeGroundingRecords(Array.from({ length: 10 }, (_, i) => ({
			text: "😀".repeat(5_000), sourceUri: `file:///doc-${i}.md`, label: `문서 ${i}`,
		})));
		expect(result.evidence).toHaveLength(4);
		expect(result.evidence.reduce((sum, item) => sum + Array.from(item.text).length, 0)).toBe(16_000);
		expect(result.evidence.map((item) => item.sourceHandle))
			.toEqual(result.sources.map((item) => item.sourceHandle));
	});
	it("짧은 record는 첫 8개만 보존한다", () => {
		const result = normalizeGroundingRecords(Array.from({ length: 10 }, (_, i) => ({
			text: `근거-${i}`, sourceUri: `file:///doc-${i}.md`, label: `문서 ${i}`,
		})));
		expect(result.evidence.map((item) => item.sourceHandle))
			.toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]);
	});
	it("20,000 scalar evidence도 4,000으로 잘라 뒤 record를 보존한다", () => {
		const result = normalizeGroundingRecords([
			{ text: "가".repeat(20_000), sourceUri: "file:///first.md", label: "첫 자료" },
			{ text: "뒤 근거", sourceUri: "file:///second.md", label: "둘째 자료" },
		]);
		expect(Array.from(result.evidence[0]!.text)).toHaveLength(4_000);
		expect(result.evidence[1]!.text).toBe("뒤 근거");
	});
	it("canonical URI는 evidence에 노출하지 않는다", () => {
		const result = normalizeGroundingRecords([
			{ text: "근거", sourceUri: "file:///private/secret.md", label: "개인 문서" },
		]);
		expect(JSON.stringify(result.evidence)).not.toContain("file:");
		expect(result.sources[0]!.canonicalUri).toBe("file:///private/secret.md");
	});
	it("빈 값·과대 URI·64개 밖 후보를 제거한다", () => {
		expect(normalizeGroundingRecords([
			{ text: " ", sourceUri: "file:///empty", label: "" },
			{ text: "근거", sourceUri: "", label: "없음" },
			{ text: "근거", sourceUri: "x".repeat(4_097), label: "과대" },
		])).toEqual({ evidence: [], sources: [] });
		expect(normalizeGroundingRecords([
			...Array.from({ length: 64 }, () => null),
			{ text: "밖", sourceUri: "file:///outside", label: "밖" },
		])).toEqual({ evidence: [], sources: [] });
	});
	it("선행 공백을 제거하고 긴 label은 80 scalar로 자른다", () => {
		const result = normalizeGroundingRecords([{
			text: `${" ".repeat(4_000)}근거`, sourceUri: "u".repeat(4_096), label: "라".repeat(1_000),
		}]);
		expect(result.evidence[0]!.text).toBe("근거");
		expect(Array.from(result.sources[0]!.label)).toHaveLength(80);
	});
});
