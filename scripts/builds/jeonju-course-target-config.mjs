import { join } from "node:path";

/**
 * Reads the host-owned course target before the Agent runtime is composed.
 * The environment value is an explicit test/launcher override; normal Shell
 * startup uses the persisted target selected in the desktop UI.
 */
export function loadJeonjuCourseTargetRaw({ environment = process.env, adkPath, readFile = undefined }) {
  const override = environment.NAIA_JEONJU_COURSE_TARGET_JSON;
  if (override !== undefined) return { raw: override, provided: Boolean(override) };
  if (!adkPath || !readFile) return { raw: undefined, provided: false };
  try {
    const raw = readFile(join(adkPath, "naia-settings", "jeonju-discord-course.json"), "utf8");
    return { raw, provided: Boolean(raw) };
  } catch {
    return { raw: undefined, provided: false };
  }
}
