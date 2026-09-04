# 0001: committed agent control plane

> **Status: accepted**
> **Date: 2026-08-31**

## Context

PND has accumulated strong architecture, protocol, audit, runbook, issue, and
PR knowledge. Those sources differ in freshness and authority. Agents spend
substantial time reconstructing which plan is live, which branch owns a path,
and which evidence is sufficient.

## Decision

Use the layered control model in `docs/agent-control-plane.md`, with
`docs/program-state.json` as a validated dependency graph and GitHub as live
collaboration state.

Every work item follows the orient, bound, plan, execute, prove, and accrete
loop. Every handoff records one exact next action and moves reusable knowledge
into a canonical repository artifact.

## Consequences

- Program changes include documentation and evidence work by definition.
- Historical plans remain available but cannot direct current execution.
- Cross-workstream status has one coordinator-controlled integration point.
- CI rejects structurally invalid program state.
- PRs must describe cost, data ownership, real-data evidence, and handoff.

