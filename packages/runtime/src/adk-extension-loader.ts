import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HookRegistration, HookEvent } from "@nextain/agent-core";
import type { PromptFragment } from "@nextain/agent-core";

export interface AdkExtension {
  hooks: HookRegistration[];
  prompts: PromptFragment[];
}

export async function loadAdkExtension(
  skillsDir: string,
): Promise<AdkExtension> {
  const extension: AdkExtension = { hooks: [], prompts: [] };

  const hooksPath = join(skillsDir, "hooks.json");
  try {
    const raw = await readFile(hooksPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const hookList = parsed["hooks"];
    if (Array.isArray(hookList)) {
      for (const entry of hookList) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as Record<string, unknown>;
        const event = e["event"] as HookEvent | undefined;
        const handlerSrc = typeof e["handler"] === "string" ? e["handler"] as string : undefined;
        if (!event || !handlerSrc) continue;
        const handler = createHandlerFromSource(handlerSrc);
        extension.hooks.push({
          source: "adk",
          event,
          handler,
          priority: typeof e["priority"] === "number" ? e["priority"] : 500,
        });
      }
    }
  } catch {
    // hooks.json is optional
  }

  const promptPath = join(skillsDir, "prompt.md");
  try {
    const raw = await readFile(promptPath, "utf-8");
    if (raw.trim()) {
      extension.prompts.push({
        source: "adk",
        priority: 150,
        section: "domain",
        content: raw.trim(),
      });
    }
  } catch {
    // prompt.md is optional
  }

  return extension;
}

function createHandlerFromSource(src: string): () => void | Promise<void> {
  return () => {
    // Log-only handler — actual execution deferred to host integration
  };
}
