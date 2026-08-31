# Decision records

> **Status: canonical decision index**

Decision records capture choices that constrain more than one workstream or
would be expensive to rediscover. They explain the decision and its
consequences. They do not track implementation status.

## Rules

- Use a stable four-digit sequence.
- Record the context, decision, consequences, and evidence required.
- Never rewrite a consequential accepted decision without adding a superseding
  record.
- Link implementation issues and PRs from the decision when they exist.
- Keep local component choices in code or subsystem docs. Reserve this index
  for program-wide boundaries.

## Accepted decisions

- `0001-agent-control-plane.md`: layered sources of truth and the
  orient-bound-plan-execute-prove-accrete loop.
- `0002-independence-is-capability.md`: independence is available but not
  automatically observed or publicly scored.
- `0003-portable-core.md`: independent core release behavior cannot require PND
  runtime services.

