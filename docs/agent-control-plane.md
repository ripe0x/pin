# PND agent control plane

> **Status: canonical operating model**
> **Updated: 2026-08-31**
> **Applies to: repository contributors, coding agents, reviewers, and release operators**

This document defines how work moves through PND. It exists to minimize
context reconstruction, prevent parallel work from silently diverging, and
make each completed task improve the environment for the next task.

The control plane is deliberately small. Product truth, system truth, program
state, execution contracts, and evidence are separate artifacts with explicit
authority. No session transcript or pull request body is allowed to become the
only place an important fact lives.

## The abstraction tower

Each layer answers one kind of question. Read only as far down the tower as the
task requires.

| Layer | Question | Canonical artifact |
| --- | --- | --- |
| L0 Constitution | Why does PND exist, and what must never be compromised? | Issue #284 plus `docs/artist-independence-program.md` |
| L1 Domain model | What do artist, collector, release, availability, declaration, and independence mean? | `docs/artist-independence-program.md` |
| L2 Architecture | Which program owns each read, write, and cost? | `ARCHITECTURE.md` and `AGENTS.md` |
| L3 Program graph | What outcomes are active, dependent, ready, or deferred? | `docs/program-state.json` |
| L4 Work contract | What exactly may this task change, and how is it accepted? | Program issue #302, owning GitHub issue, and `docs/work-packet-template.md` |
| L5 Implementation | What does the system currently do? | Source, migrations, generated ABIs, and tests |
| L6 Evidence | What proves the change works on representative data? | PR verification receipt, CI, and preview |
| L7 Operations | What is deployed, observed, reversible, and within budget? | Deployment runbooks and production telemetry |

The tower is directional. A lower layer implements a higher layer. It may not
quietly redefine it. If implementation evidence contradicts a design claim,
either fix the implementation or record a deliberate decision that changes the
higher layer.

## Authority and conflict rules

Use this precedence when two artifacts disagree:

1. Deployed contract bytecode, committed migrations, generated ABI output, and
   current source determine what the system can do now.
2. `AGENTS.md` and `ARCHITECTURE.md` determine current ownership, cost, and
   operational boundaries.
3. Active program specifications and accepted decision records determine the
   intended next state.
4. `docs/program-state.json` determines dependency order and planned delivery.
5. GitHub issues and PRs determine live execution status and coordination.
6. Runbooks determine an operation only when their preconditions still match.
7. Documents marked historical provide rationale only.

Do not silently choose a convenient source. When a conflict changes a safe
implementation decision, stop that branch of work, identify the conflicting
artifacts, and repair the nearest canonical source before proceeding.

## The agent loop

Every task follows the same six-state control loop.

### 1. Orient

Run:

```sh
pnpm agent:context
```

For work involving open issues, PRs, or other worktrees, run:

```sh
pnpm agent:context -- --online
```

Before opening, rebasing, or restacking a program PR, run:

```sh
pnpm agent:overlap
```

The overlap probe compares the current branch with referenced open PRs and
prints exact shared files. An overlap is coordination evidence, not an
automatic failure. Resolve ownership and merge order in the work packet.

Then read, in order:

1. `AGENTS.md`
2. `docs/program-state.json`
3. The active program spec named by that state file
4. Only the relevant architecture and subsystem documents
5. The linked issue, PR, and changed source

Program-wide accepted decisions are indexed in `docs/decisions/README.md`.

Do not begin with repository-wide archaeology. The control plane should narrow
the search surface before source inspection begins.

### 2. Bound

Translate the request into a work contract using
`docs/work-packet-template.md`. Establish:

- one observable outcome;
- the invariants that constrain it;
- dependencies and conflicting work;
- owned and excluded paths;
- data read and write ownership;
- cost, migration, and deployment effects;
- acceptance scenarios and evidence required.

If the task cannot be described this way, it is not ready to implement.

### 3. Plan

Plan in dependency order, not page order. Prefer contracts and pure domain
logic before assemblies, assemblies before navigation, and hidden integration
before activation.

Parallel work is safe only when work packets have disjoint ownership or share
an already-merged contract. Two agents must not independently invent the shape
of the same release object, availability state, provider interface, or route.

### 4. Execute

Make the smallest coherent change that satisfies the work contract. Preserve
the writer and reader boundaries in `ARCHITECTURE.md`. New reusable behavior
belongs at the lowest layer that can own it without depending on an upper
assembly.

Do not add request-time chain reads for storable data. Do not make independent
interfaces require PND services for core release behavior. Do not represent an
artist declaration as independently verified fact.

### 5. Prove

Evidence must be proportional to the failure mode. Typechecks do not prove a
database migration, real media rendering, wallet transaction, responsive
layout, or deployment cutover.

Every user-facing PR needs a verification receipt containing:

- exact commands and results;
- representative live-data routes;
- desktop and mobile browser results;
- degraded and empty-state results;
- preview URL and commit SHA;
- RPC, database, storage, and recurring-cost effects;
- production writes performed, normally none during review;
- known limitations and rollback path.

Dummy data is permitted only in isolated unit tests and fixtures. It may not be
used as evidence for performance, media, indexing, availability, or preview
acceptance.

### 6. Accrete

Before handing off, move every reusable discovery into the correct durable
layer:

- changed invariant or system boundary: update `AGENTS.md` or
  `ARCHITECTURE.md`;
- changed product decision: add or update a decision record;
- changed program dependency or status: update `docs/program-state.json`;
- new execution lesson: improve the work packet or verification gate;
- new operational procedure: update the relevant runbook;
- obsolete claim: correct it or mark the document historical.

The next agent should not need the previous agent's transcript to understand
why the repository looks the way it does.

## Work-item states

Program work uses these states:

```text
proposed
  -> ready
  -> in_progress
  -> integrated_hidden
  -> verified_preview
  -> activated
  -> observed
  -> complete
```

- `proposed`: outcome exists but dependencies or decisions are incomplete.
- `ready`: work contract and dependencies are resolved.
- `in_progress`: one branch or worktree owns the implementation.
- `integrated_hidden`: code may be on the integration branch or main but is not
  yet the public experience.
- `verified_preview`: connected behavior passed the required live-data review.
- `activated`: public routing or flags expose the behavior.
- `observed`: production telemetry and cost were checked for the required
  window.
- `complete`: acceptance evidence and documentation are durable.

`blocked` is an annotation, not a substitute for a state. It must name the
missing decision, authority, dependency, or external condition.

## Program graph rules

`docs/program-state.json` is a machine-readable dependency graph, not a second
issue tracker.

- Stable workstream and milestone IDs never change after work begins.
- Milestones are executable graph nodes. Their dependencies point only to
  milestone IDs, so design work can proceed without falsely waiting for an
  entire workstream to deploy and close.
- Workstream delivery dependencies describe release composition, not a blanket
  prohibition on earlier design work.
- GitHub issues and PRs hold discussion and live collaboration.
- The state file records how those units compose into a release.
- Only the program coordinator changes cross-workstream state or activation
  order. Leaf PRs may add their own evidence and propose state changes.
- A workstream cannot be `ready` until all architectural decisions required by
  its acceptance gates are recorded.

Run `pnpm agent:check` after changing the program graph or canonical docs.

## Integration model

PND uses stacked delivery with hidden integration:

1. Stable schemas, packages, tests, and optional fields merge first.
2. Public assemblies remain hidden behind non-default routes, configuration,
   or an integration branch.
3. The connected experience is reviewed on one Netlify preview using real,
   read-only production data.
4. One activation PR changes the public hierarchy after all cross-page gates
   pass.
5. Production cost and error behavior are observed before the program is
   marked complete.

This avoids both failure modes: one enormous unreviewable PR and a series of
public fragments that never form a coherent product.

## Resource discipline

Agents should optimize for total system cost, including human attention,
runtime spend, and repeated investigation.

- Prefer one bounded query over many page-level or per-token queries.
- Prefer typed read models over local interpretation of raw rows.
- Prefer generated artifacts over copied constants.
- Prefer pure packages over duplicated app-specific behavior.
- Prefer one live-data preview over many temporary tunnels.
- Prefer deterministic checks over prose assurances.
- Cache only derived or disposable data. Store durable facts with one writer.
- Any projected recurring increase above $0 requires a written estimate. Any
  projected increase above $10 per month requires explicit approval.

## Failure conditions

A task is not complete when any of these remain:

- a strategic decision exists only in chat;
- a page and template implement the same capability differently;
- a public claim is stronger than the underlying evidence;
- a preview uses dummy content for a live-data concern;
- a new read path has no identified owner or cost bound;
- a migration, activation, or rollback order is implicit;
- another open PR owns overlapping files and the resolution is undocumented;
- the next task cannot be identified from durable state.
