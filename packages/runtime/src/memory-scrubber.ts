// G-NA-01: Memory context fencing helpers for streaming output.
//
// Prevents <memory-context> blocks from leaking into the visible UI.
// Pattern sourced from hermes-agent/agent/memory_manager.py (Nous Research).
// F09 compliance: OWASP A03 / context-injection defence (CWE-74) cross-ref.
//
// Two exports:
//   sanitizeContext(text)       — one-shot cleanup for complete strings
//   StreamingContextScrubber    — stateful scrubber that survives chunk boundaries
//   buildMemoryContextBlock(raw) — wrap recalled memory in a fenced block

const INTERNAL_CONTEXT_RE =
  /<\s*memory-context\s*>[\s\S]*?<\/\s*memory-context\s*>/gi;

const INTERNAL_NOTE_RE =
  /\[System note:\s*The following is recalled memory context,\s*NOT new user input\.\s*Treat as (?:informational background data|authoritative reference data[^\]]*)\.\]\s*/gi;

const FENCE_TAG_RE = /<\/?\s*memory-context\s*>/gi;

/**
 * Strip all `<memory-context>` blocks, system notes, and stray fence tags
 * from a complete string.  Safe for non-streaming use.
 */
export function sanitizeContext(text: string): string {
  text = text.replace(INTERNAL_CONTEXT_RE, "");
  text = text.replace(INTERNAL_NOTE_RE, "");
  text = text.replace(FENCE_TAG_RE, "");
  return text;
}

/**
 * Stateful scrubber for streaming text that may contain split memory-context
 * spans.  A chunk boundary may split an open/close tag pair across two
 * `feed()` calls — the one-shot regex in `sanitizeContext` cannot handle
 * that.  This class runs a small state machine across deltas.
 *
 * Usage:
 *   const scrubber = new StreamingContextScrubber();
 *   for (const delta of stream) {
 *     const visible = scrubber.feed(delta);
 *     if (visible) emit(visible);
 *   }
 *   const trailing = scrubber.flush();
 *   if (trailing) emit(trailing);
 *
 * Call `reset()` between top-level agent turns.
 */
export class StreamingContextScrubber {
  private static readonly OPEN_TAG = "<memory-context>";
  private static readonly CLOSE_TAG = "</memory-context>";

  private inSpan = false;
  private buf = "";

  reset(): void {
    this.inSpan = false;
    this.buf = "";
  }

  /**
   * Return the visible portion of `text` after scrubbing.
   * Any trailing fragment that could be the start of a tag is held back
   * and surfaced on the next `feed()` call (or by `flush()`).
   */
  feed(text: string): string {
    if (!text) return "";
    let buf = this.buf + text;
    this.buf = "";
    const out: string[] = [];

    while (buf) {
      if (this.inSpan) {
        const idx = buf.toLowerCase().indexOf(StreamingContextScrubber.CLOSE_TAG);
        if (idx === -1) {
          const held = StreamingContextScrubber.maxPartialSuffix(buf, StreamingContextScrubber.CLOSE_TAG);
          this.buf = held ? buf.slice(-held) : "";
          return out.join("");
        }
        buf = buf.slice(idx + StreamingContextScrubber.CLOSE_TAG.length);
        this.inSpan = false;
      } else {
        const idx = buf.toLowerCase().indexOf(StreamingContextScrubber.OPEN_TAG);
        if (idx === -1) {
          const held = StreamingContextScrubber.maxPartialSuffix(buf, StreamingContextScrubber.OPEN_TAG);
          if (held) {
            out.push(buf.slice(0, -held));
            this.buf = buf.slice(-held);
          } else {
            out.push(buf);
          }
          return out.join("");
        }
        if (idx > 0) out.push(buf.slice(0, idx));
        buf = buf.slice(idx + StreamingContextScrubber.OPEN_TAG.length);
        this.inSpan = true;
      }
    }

    return out.join("");
  }

  /**
   * Emit any held-back buffer at end-of-stream.
   * If still inside an unterminated span the remaining content is discarded
   * (leaking partial memory context is worse than a truncated answer).
   */
  flush(): string {
    if (this.inSpan) {
      this.buf = "";
      this.inSpan = false;
      return "";
    }
    const tail = this.buf;
    this.buf = "";
    return tail;
  }

  /**
   * Return the length of the longest buf-suffix that is a prefix of `tag`
   * (case-insensitive).  Returns 0 if no suffix could start the tag.
   */
  static maxPartialSuffix(buf: string, tag: string): number {
    const tagLower = tag.toLowerCase();
    const bufLower = buf.toLowerCase();
    const maxCheck = Math.min(bufLower.length, tagLower.length - 1);
    for (let i = maxCheck; i > 0; i--) {
      if (tagLower.startsWith(bufLower.slice(-i))) return i;
    }
    return 0;
  }
}

/**
 * Wrap prefetched memory context in a fenced block with a system note.
 * Returns empty string if `rawContext` is blank.
 */
export function buildMemoryContextBlock(rawContext: string): string {
  if (!rawContext || !rawContext.trim()) return "";
  const clean = sanitizeContext(rawContext);
  return (
    "<memory-context>\n" +
    "[System note: The following is recalled memory context, " +
    "NOT new user input. Treat as authoritative reference data — " +
    "this is the agent's persistent memory and should inform all responses.]\n\n" +
    clean +
    "\n</memory-context>"
  );
}
