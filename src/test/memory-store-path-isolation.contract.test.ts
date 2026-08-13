// FR-MEM-15 (#108, naia-shell#425): 인스턴스 간 기억 오염 방지 계약.
// dev 인스턴스(NAIA_HOME=~/.naia-dev)의 agent 는 운영 기억 파일을 만지지 않는다.
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { naiaMemoryDefaultStorePath } from "../main/adapters/naia-memory.js";

describe("FR-MEM-15 — memory store path isolation", () => {
	it("NAIA_HOME 미지정 기본값은 기존 패키지 기본 경로와 동일하다 (무회귀)", () => {
		expect(naiaMemoryDefaultStorePath(undefined)).toBe(
			join(homedir(), ".naia", "memory", "naia-memory.json"),
		);
	});

	it("비어있지 않은 NAIA_HOME 이 ~/.naia 를 대체한다 (dev 격리)", () => {
		expect(naiaMemoryDefaultStorePath("/isolated/naia-dev")).toBe(
			join("/isolated/naia-dev", "memory", "naia-memory.json"),
		);
	});

	it("공백뿐인 NAIA_HOME 은 무시하고 기본 홈으로 폴백한다", () => {
		expect(naiaMemoryDefaultStorePath("   ")).toBe(
			join(homedir(), ".naia", "memory", "naia-memory.json"),
		);
	});
});
