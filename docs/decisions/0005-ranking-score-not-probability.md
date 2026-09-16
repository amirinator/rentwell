# 5. The match score is a ranking, not a probability

Status: accepted

## Context

The reconciliation engine scores candidate matches. The obvious presentation is
a confidence percentage: "92% match".

## Decision

The score is a bounded ranking value, documented and presented as such
everywhere: in the GraphQL schema description, in the UI beside every
suggestion, and in the assistant's system prompt and tool output.

It is never rendered as a percentage, a confidence, or a probability.

## Rationale

The engine has no calibrated basis for a probability. Its weights were chosen so
that stronger evidence outranks weaker evidence, not so that a score of 0.92
corresponds to being right 92% of the time. Presenting it as a probability would
be a claim the system cannot support.

It also changes behaviour. A percentage invites an accountant to approve a
high-scoring match without reading the evidence — precisely the failure mode
that turns an automation aid into a source of misallocated cash. A ranking
invites them to compare candidates, which is what the evidence panel is for.

## Consequences

- The evidence panel sits above the approve button rather than behind a
  disclosure, and its contributions sum to the score.
- A genuine tie at the top produces `MULTIPLE_EQUAL_CANDIDATES` and an
  `AMBIGUOUS_MATCH` exception rather than an arbitrary winner.
- `packages/graphql/test/schema.test.ts` asserts the schema description still
  contains "not a probability", so the wording cannot be quietly dropped in a
  later refactor.
