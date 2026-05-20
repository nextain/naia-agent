# Compaction Benchmark Fixtures

P1 skeleton — this directory is empty by design. P6 (Slice 3-XR-Compact final phase) will populate it with 10 seed fixtures.

## Schema

See `../fixture.ts` for the authoritative TypeScript types. Files in this directory must:

- be named `*.fixture.json`
- validate against `validateFixture()`
- have a unique `id`

Example skeleton:

```json
{
  "id": "F001-customer-support-50turn",
  "domain": "customer-support",
  "turns": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "probes": [
    {
      "afterTurn": 30,
      "type": "fact-recall",
      "question": "What was the customer's order number?",
      "expectedKeywords": ["#A-7421"]
    },
    {
      "afterTurn": 50,
      "type": "task-accuracy",
      "criterion": "Assistant correctly summarized refund eligibility"
    }
  ],
  "compactionPoints": [25, 45]
}
```

## Planned seed set (P6)

| ID | Domain | Turns | Probes | Notes |
|---|---|---:|---:|---|
| F001 | customer-support | 50 | 4 | Multi-fact recall — order #, name, address, refund rule. |
| F002 | coding-pair | 60 | 5 | File path / variable name preservation across compactions. |
| F003 | research-synthesis | 80 | 4 | Long quotation preservation. |
| F004 | persona-roleplay | 50 | 4 | Persona consistency post-compaction. |
| F005 | tool-heavy | 50 | 4 | bash/read_file/edit_file 30+ calls — tool_use ID preservation. |
| F006 | mixed-language | 50 | 3 | KO/EN alternating, recap fidelity. |
| F007 | calculation-chain | 60 | 5 | Intermediate result preservation. |
| F008 | story-continuation | 70 | 3 | Narrative continuity. |
| F009 | preference-tracking | 50 | 5 | User preference drift detection. |
| F010 | websearch-heavy | 50 | 4 | Anthropic-documented sampling-loop limitation reproduction. |

License audit pending for any LongMemEval cross-reference.
