export type PromptFragmentSource = "core" | "host" | "adk";

export type PromptSection =
  | "identity"
  | "tools"
  | "persona"
  | "domain"
  | "safety"
  | "memory"
  | "handoff";

export interface PromptFragment {
  source: PromptFragmentSource;
  priority: number;
  section: PromptSection;
  content: string;
}

export class SystemPromptBuilder {
  readonly #fragments: PromptFragment[] = [];

  add(fragment: PromptFragment): void {
    this.#fragments.push(fragment);
  }

  build(): string {
    if (this.#fragments.length === 0) return "";
    const sorted = [...this.#fragments].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.section.localeCompare(b.section);
    });
    return sorted.map((f) => f.content).join("\n\n");
  }

  get fragments(): readonly PromptFragment[] {
    return this.#fragments;
  }
}
