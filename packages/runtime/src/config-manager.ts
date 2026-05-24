export interface AgentConfig {
  provider: string;
  model: string;
  contextBudget: number;
  compactionStrategy: string;
  language: string;
  [key: string]: unknown;
}

export interface ConfigManagerOptions {
  initial?: Partial<AgentConfig>;
  onChange?: (config: Readonly<AgentConfig>) => void;
}

export class ConfigManager {
  #config: AgentConfig;
  readonly #onChange?: (config: Readonly<AgentConfig>) => void;

  constructor(opts: ConfigManagerOptions = {}) {
    const defaults: AgentConfig = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      contextBudget: 80_000,
      compactionStrategy: "reactive",
      language: "en",
    };
    this.#config = { ...defaults, ...opts.initial };
    if (opts.onChange) this.#onChange = opts.onChange;
  }

  get(keyOrNothing?: keyof AgentConfig): Readonly<AgentConfig> | AgentConfig[keyof AgentConfig] {
    if (keyOrNothing !== undefined) return this.#config[keyOrNothing];
    return { ...this.#config };
  }

  set(partial: Partial<AgentConfig>): AgentConfig {
    const changed = Object.keys(partial).some(
      (k) => partial[k as keyof AgentConfig] !== this.#config[k as keyof AgentConfig],
    );
    if (changed) {
      this.#config = { ...this.#config, ...partial };
      this.#onChange?.(this.#config);
    }
    return { ...this.#config };
  }

  reset(): AgentConfig {
    this.#config = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      contextBudget: 80_000,
      compactionStrategy: "reactive",
      language: "en",
    };
    this.#onChange?.(this.#config);
    return { ...this.#config };
  }
}
