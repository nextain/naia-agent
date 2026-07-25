import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error build-time ESM helper is intentionally exercised without a declaration file.
import { loadJeonjuCourseTargetRaw } from "../../scripts/builds/jeonju-course-target-config.mjs";
import { parseJeonjuDiscordCourseConfig } from "../main/app/jeonju-discord-course.js";

describe("T-JEONJU-03 Shell-owned course target loading", () => {
  it("loads and strictly parses the persisted Shell target when no environment override exists", () => {
    const root = mkdtempSync(join(tmpdir(), "naia-jeonju-target-"));
    try {
      const settings = join(root, "naia-settings");
      mkdirSync(settings);
      writeFileSync(join(settings, "jeonju-discord-course.json"), JSON.stringify({
        version: 1,
        workspacePath: "D:/student/course-page",
        allowedFiles: ["index.html", "hero.svg"],
      }));

      const loaded = loadJeonjuCourseTargetRaw({
        environment: {},
        adkPath: root,
        readFile: (path: string, encoding: BufferEncoding) => readFileSync(path, encoding),
      });
      expect(loaded.provided).toBe(true);
      expect(parseJeonjuDiscordCourseConfig(JSON.parse(loaded.raw!))).toEqual({
        workspacePath: "D:/student/course-page",
        allowedFiles: ["index.html", "hero.svg"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses an explicit override before the persisted file and does not treat a missing file as configured", () => {
    const loaded = loadJeonjuCourseTargetRaw({
      environment: { NAIA_JEONJU_COURSE_TARGET_JSON: '{"version":1}' },
      adkPath: "D:/ignored",
      readFile: () => { throw new Error("must not read fallback"); },
    });
    expect(loaded).toEqual({ raw: '{"version":1}', provided: true });
    expect(parseJeonjuDiscordCourseConfig(JSON.parse(loaded.raw!))).toBeUndefined();
    expect(loadJeonjuCourseTargetRaw({ environment: {}, adkPath: "D:/missing", readFile: () => { throw new Error("ENOENT"); } }))
      .toEqual({ raw: undefined, provided: false });
  });
});
