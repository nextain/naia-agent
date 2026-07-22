import { describe, expect, it } from "vitest";
import { parseJeonjuCoursePatch } from "../main/domain/jeonju-course.js";

describe("UC-JEONJU provider-neutral course proposal", () => {
  it("accepts a complete replacement proposal without binding it to a model provider", () => {
    expect(parseJeonjuCoursePatch(JSON.stringify({
      version: 1,
      files: [
        { path: "index.html", content: '<img src="./hero.svg">' },
        { path: "hero.svg", content: "<svg/>" },
      ],
    }))).toEqual({
      ok: true,
      patch: {
        version: 1,
        files: [
          { path: "index.html", content: '<img src="./hero.svg">' },
          { path: "hero.svg", content: "<svg/>" },
        ],
      },
    });
  });

  it("rejects non-contract output, duplicate paths, and a file outside Naia's boundary", () => {
    expect(parseJeonjuCoursePatch("```json {} ```")).toMatchObject({ ok: false, reason: "invalid_json" });
    expect(parseJeonjuCoursePatch(JSON.stringify({ version: 1, files: [
      { path: "index.html", content: "a" }, { path: "index.html", content: "b" },
    ] }))).toMatchObject({ ok: false, reason: "duplicate_file" });
    expect(parseJeonjuCoursePatch(JSON.stringify({ version: 1, files: [
      { path: "package.json", content: "{}" },
    ] }))).toMatchObject({ ok: false, reason: "invalid_file" });
  });
});
