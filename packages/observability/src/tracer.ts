import type { Span, SpanContext, Tracer } from "@nextain/agent-types";

class NoopSpan implements Span {
  setAttribute(): void {}
  setStatus(): void {}
  end(): void {}
}

/** Tracer that does nothing. Useful for tests and for hosts that opt out
 *  of distributed tracing. */
export class NoopTracer implements Tracer {
  startSpan(_name: string, _parent?: SpanContext): Span {
    void _name;
    void _parent;
    return new NoopSpan();
  }
}
