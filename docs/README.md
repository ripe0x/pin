# PND documentation map

> **Status: canonical document registry**
> **Updated: 2026-08-31**

## Start here

1. `AGENTS.md`: fast contributor orientation and non-negotiable traps.
2. `docs/agent-control-plane.md`: how work is planned, proven, coordinated,
   and handed off.
3. `docs/program-state.json`: active program graph and exact next actions.
4. `docs/artist-independence-program.md`: active product and system plan.
5. `ARCHITECTURE.md`: current data ownership and runtime boundaries.

Run `pnpm agent:context` for the local summary and
`pnpm agent:context -- --online` when GitHub coordination matters.

## Document classes

### Canonical

These describe current rules or current system shape:

- `AGENTS.md`
- `ARCHITECTURE.md`
- `docs/agent-control-plane.md`
- `docs/artist-independence-program.md`
- `docs/portable-release-boundary.md`
- `docs/editorial-venue-boundary.md`
- `docs/schemas/`
- `docs/program-state.json`
- `docs/work-packet-template.md`
- `docs/decisions/`
- `docs/profile-indexing-contract.md`
- `docs/media-delivery.md`
- `docs/injection-convention.md`

### Operational runbooks

These are executable only when their stated preconditions match:

- `docs/indexer-cutover.md`
- `docs/pnd-surface-prelaunch.md`
- `docs/pnd-surface-post-deploy.md`
- `docs/pnd-surface-second-launch.md`
- `DEPLOYMENT.md`

### Protocol design and reference

- `docs/pnd-surface-system.md`
- `docs/pnd-surface-contracts-plan.md`
- `docs/pnd-surface-thin-token-rearchitecture.md`
- `docs/surface-getting-started.md`
- `docs/surface-glossary.md`
- `docs/reference/`

Generated files under `docs/reference/` say so in their first line. Edit their
source under `docs/reference/_pages/` or `docs/reference/_prose/`, then run
`pnpm generate:docs`.

### Historical rationale

These must not be used as current execution plans:

- `PLAN.md`
- `CONTINUATION.md`
- `CUTOVER.md`
- `docs/pnd-surface-web-plan.md`
- `docs/pnd-editions.md`
- `docs/pnd-editions-spec.md`
- `docs/pnd-editions-design-review.md`
- `docs/pnd-editions-security-review.md`
- `docs/pnd-surface-reaudit-notes.md`

Historical documents remain useful for rationale. If one conflicts with a
canonical document or current source, the canonical document and source win.

## Maintenance rule

Every durable discovery belongs in exactly one canonical layer. Other
documents should link to it rather than copy it. When a plan completes, mark it
historical and point its banner to the artifact that describes the shipped
system.
