import type { Counter, Histogram, Meter } from "@nextain/agent-types";

/** In-memory counter. Sums per unique label set. */
export class InMemoryCounter implements Counter {
  readonly #values = new Map<string, number>();

  add(value: number, labels?: Record<string, string>): void {
    const key = labelsKey(labels);
    this.#values.set(key, (this.#values.get(key) ?? 0) + value);
  }

  /** Snapshot of all label-keyed totals. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.#values);
  }
}

/** In-memory histogram. Records raw values per unique label set. */
export class InMemoryHistogram implements Histogram {
  readonly #values = new Map<string, number[]>();

  record(value: number, labels?: Record<string, string>): void {
    const key = labelsKey(labels);
    const arr = this.#values.get(key) ?? [];
    arr.push(value);
    this.#values.set(key, arr);
  }

  snapshot(): Record<string, number[]> {
    return Object.fromEntries(this.#values);
  }
}

/** In-memory Meter — counters/histograms accumulate in memory and can be
 *  retrieved via `snapshot()`. No external reporting. Useful for tests and
 *  as a baseline before wiring up OTel/Prometheus. */
export class InMemoryMeter implements Meter {
  readonly #counters = new Map<string, InMemoryCounter>();
  readonly #histograms = new Map<string, InMemoryHistogram>();

  counter(name: string): Counter {
    let c = this.#counters.get(name);
    if (!c) {
      c = new InMemoryCounter();
      this.#counters.set(name, c);
    }
    return c;
  }

  histogram(name: string): Histogram {
    let h = this.#histograms.get(name);
    if (!h) {
      h = new InMemoryHistogram();
      this.#histograms.set(name, h);
    }
    return h;
  }

  /** Snapshot of all recorded metrics. */
  snapshot(): { counters: Record<string, Record<string, number>>; histograms: Record<string, Record<string, number[]>> } {
    const counters: Record<string, Record<string, number>> = {};
    for (const [name, c] of this.#counters) counters[name] = c.snapshot();
    const histograms: Record<string, Record<string, number[]>> = {};
    for (const [name, h] of this.#histograms) histograms[name] = h.snapshot();
    return { counters, histograms };
  }
}

function labelsKey(labels?: Record<string, string>): string {
  if (!labels) return "";
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(",");
}
