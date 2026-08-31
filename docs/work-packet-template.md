# Program work packet template

> **Status: canonical execution template**
> **Use for: GitHub issues, implementation plans, and agent handoffs**

Copy this structure into the issue that owns a coherent implementation unit.
Delete prompts that do not apply, but do not remove a safety or evidence section
without stating why.

## Outcome

One sentence describing observable user or system behavior when complete.

## Program position

- Program:
- Workstream ID:
- Depends on:
- Unlocks:
- Strategy and decision references:

## Invariants

List the invariant IDs from `docs/program-state.json` that constrain this work.
Add a decision record before introducing a new cross-program invariant.

## Current evidence

- Current behavior:
- Source paths:
- Representative live-data examples:
- Known failure or ambiguity:
- Relevant issue, PR, branch, and worktree overlap:

## Scope

### Owned

Exact behavior and paths this work packet may change.

### Excluded

Adjacent behavior deliberately left unchanged. Name the issue or workstream
that owns it when one exists.

## Data and dependency contract

- Inputs and their truth classes:
- Read owner:
- Write owner:
- Freshness and finality requirements:
- External services:
- Request-time RPC effect:
- Worker or indexer effect:
- Database and migration effect:
- Storage and recurring-cost estimate:

## Design

Describe the lowest reusable abstraction first, then the assemblies that
consume it. Include degraded behavior and compatibility requirements.

## Acceptance scenarios

Use concrete scenarios, including:

- normal path;
- empty path;
- stale or partial indexed data;
- missing or failed media;
- mobile layout;
- provider or optional PND-service outage;
- unauthorized mutation;
- migration and rollback when applicable.

## Verification receipt

- Commit SHA:
- Preview URL:
- Live data source:
- Commands run and results:
- Routes reviewed on desktop:
- Routes reviewed at 390px:
- Degraded states reviewed:
- Performance evidence:
- RPC and recurring-cost evidence:
- Production writes performed:
- Known limitations:
- Rollback procedure:

## Handoff

- Durable docs updated:
- Program state change proposed:
- Exact next action:
- Remaining blocker, if any:

