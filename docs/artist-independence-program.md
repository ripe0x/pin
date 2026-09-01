# Artist independence and portable venue program

> **Status: active program specification**
> **Updated: 2026-08-31**
> **Strategy: GitHub issue #284**
> **Delivery coordination: GitHub issue #302**
> **Current foundation: GitHub issue #301 and PR #300**
> **Machine-readable graph: `docs/program-state.json`**

Accepted program-wide decisions are indexed in `docs/decisions/README.md`.

## Outcome

PND should be an excellent first-party venue for artist-owned releases while
making the venue's capabilities portable to independent artist and curator
interfaces.

The product promise is:

> Launch through PND when it is useful. Operate elsewhere whenever you choose.
> The contracts, release tools, and public record do not depend on PND remaining
> the primary interface.

Independence is a capability, not a status PND can automatically observe or
verify. PND does not infer that an artist has graduated, owns a domain, controls
a hosting account, or permanently operates an external interface. An artist
may voluntarily publish a signed site declaration. PND must label it as an
artist-provided destination, not verified independence.

## Product synthesis

The system serves three overlapping roles without splitting one person into
separate identities:

- An artist creates, releases, operates, preserves, and may self-host work.
- A collector discovers available work, understands its context, acquires it,
  and maintains a durable collected record.
- A curator explicitly authors context, ordering, and attention around work.

One address may perform all three roles. Roles are views of authored actions
and indexed evidence, not exclusive account types.

PND's distinctive system combines:

1. neutral artist-owned protocols;
2. a selective first-party venue;
3. a durable indexed record across platforms;
4. shared release capabilities that independent interfaces can reuse;
5. open referrals and portable distribution;
6. preservation and dependency transparency.

## System tower

The implementation should form a one-way tower of abstractions.

### Layer 0: protocol truth

Contracts and emitted events define ownership, authority, supply, price,
referrals, rendering pointers, and transaction behavior.

Owned by:

- `contracts/`
- `packages/abi/`
- `packages/addresses/`

Upper layers may interpret this truth but may not invent stronger guarantees.

### Layer 1: observed truth

Ponder, the worker, and Postgres turn chain events and bounded enrichment into
queryable evidence.

Owned by:

- `apps/indexer/` for fixed shared contracts and discovery;
- `apps/worker/` for known-artist long-tail scanning and enrichment;
- `db/migrations/` for durable public read models.

This layer records provenance, coverage, finality, and freshness. Unknown is a
valid state. It must not be rewritten as absent.

### Layer 2: portable release specification

A versioned, network-independent release manifest describes everything that
can be declared or derived without binding an interface to PND.

The planned `@pin/release-spec` package should contain:

- schema and TypeScript types;
- artist-authored release copy and media references;
- contract, minter, renderer, and network references;
- optional artist-provided site declarations;
- version and capability negotiation;
- serialization and signature payloads.

It contains no React, database client, RPC client, or PND route.
The accepted manifest v1 and provider boundary is
`docs/portable-release-boundary.md`.

### Layer 3: shared release kernel

The planned `@pin/surface-kit` package turns protocol truth and provider inputs
into deterministic application behavior:

- lifecycle and availability derivation;
- price and quantity quoting;
- transaction preparation;
- referral handling;
- token preview and render assembly;
- reveal and post-mint resolution;
- provider interfaces for live state, indexed history, identity, and media;
- explicit degraded states.

Core behavior accepts replaceable providers. PND Postgres may be the richest
provider, but it cannot be mandatory for independent minting and rendering.

### Layer 4: shared interaction layer

The planned `@pin/surface-react` layer owns headless hooks and accessible,
themeable interaction primitives for:

- wallet connection;
- mint state and transaction progress;
- pricing and supply;
- artwork preview and loading;
- errors and recovery;
- provenance and dependency facts.

PND and the artist template consume the same primitives. Visual composition
may differ, but behavioral parity is structural.

### Layer 5: experience assemblies

Assemblies arrange shared capabilities for different purposes:

- `apps/web`: PND venue, discovery, profiles, launch pages, and Studio;
- `templates/artist-page`: artist-controlled release and auction interface;
- future embeds: small release surfaces for artists, curators, and
  publications.

Assemblies may add context and editorial choices. They may not fork protocol
logic or redefine the portable release format.

### Layer 6: operating workflows

Studio helps an artist prepare and operate the system:

```text
Create -> Prepare -> Launch -> Operate
                    \-> Export or self-host at any time
```

Export and self-hosting are available capabilities, not a required final state.
PND does not mark an artist incomplete for staying on PND or for declining to
publish an external destination.

### Layer 7: distribution and public memory

PND's venue, release journal, feeds, embeds, launch assets, profiles, and
preservation records help work travel without making PND the sole path to it.

Distribution should create portable artifacts, not private platform-only
objects.

## Truth classes

Every public field belongs to one of four truth classes:

| Class | Example | Required presentation |
| --- | --- | --- |
| Protocol fact | contract owner, price, minted count | Source and currentness are mechanically knowable |
| Indexed observation | listing, ownership, platform mint | Coverage, freshness, and finality remain available |
| Artist declaration | biography, release statement, site URL | Clearly attributed to the artist |
| PND editorial decision | featured release, launch essay | Clearly attributable to PND's venue |

Do not collapse these classes into a generic verified state. In particular,
an artist-provided site is a declaration even when the URL resolves and the
page references the expected contract.

## Public experience

### Homepage

The homepage is the PND venue, not an infrastructure dashboard.

It should lead with one featured current or upcoming release, including the
artwork, artist, creative premise, launch state, date, price, and primary
action. Follow with upcoming releases, available work, recent releases, and a
compact reliable activity stream.

Infrastructure, profile search, Catalog, and preservation remain accessible
but secondary to the work.

The accepted editorial truth, failure, route, and performance contract is
`docs/editorial-venue-boundary.md`.

### Releases directory

The existing `/collections` route may remain technically stable while its
public label becomes Releases.

It should present:

- featured now;
- upcoming;
- currently open;
- recent and archived releases;
- the complete permissionless Surface record, clearly separated from PND
  editorial featuring.

Cards are art-led and include artist, timing, availability, price, supply, and
a concise premise. They are not contract-directory rows.

### Release pages

Release pages combine:

- artist-authored context;
- live or deterministic artwork exploration;
- mint or auction interaction;
- schedule and availability;
- provenance, preservation, and dependency facts;
- quiet contract details;
- an optional artist-provided external destination.

Technical self-host instructions belong in Studio or documentation, not inside
the collector-facing About section.

### Profiles

Profiles remain canonical person-level records with overlapping roles.

Recommended order:

1. identity, biography, links, and current or next release;
2. available work;
3. created record;
4. sold or transferred history;
5. collected work;
6. Catalog declarations and infrastructure details.

Availability is a lens over the record, not a replacement for it. Curation is
shown only when an authored exhibition or list exists.

### Studio

Studio is an operating system, not a flat toolbox. It should present the next
meaningful action while keeping all advanced controls reachable.

The private independence checkup examines:

- contract and administrative control;
- payout and referral configuration;
- renderer and metadata dependencies;
- media permanence and gateway reliance;
- RPC and PND service dependencies;
- export readiness;
- domain and deployment guidance.

Results are specific actions, never a public independence score.

### Independent artist interface

The artist template should support releases and auctions through the shared
kernel. Core pages must continue to render and transact with PND endpoints
blocked.

The template may optionally use PND for enriched history, identity, or media
delivery. Failure of optional enrichment must produce an explicit reduced
experience, not a broken site.

## Portable release package

An artist should be able to export a release bundle containing:

- versioned manifest;
- contract, minter, renderer, and network references;
- ABI identifiers and compatibility version;
- artist-authored copy and media references;
- theme and presentation configuration;
- social and Open Graph assets;
- deployment environment template;
- a dependency report;
- optional signed artist-site declaration.

The bundle is a reproducible input to the PND venue, artist template, and
future embeds. It must not contain secrets or require a PND account.

## Workstreams

### W0: trustworthy foundation

Outcome: the profile, availability, media, feed, database, indexer, and worker
foundation is correct enough that upper layers do not build on ambiguous or
expensive data.

Current coordination: issues #294 through #301 and PR #300.

Acceptance includes the guarded indexer cutover, bounded worker scanning,
correct ownership and attribution, explicit media states, durable refresh, and
real-data browser coverage.

### W1: release specification and shared kernel

Outcome: PND and independent interfaces consume one release model and one
behavioral implementation.

Deliverables:

- release manifest v1;
- provider interfaces;
- shared render, lifecycle, quote, transaction, reveal, and referral logic;
- shared interaction primitives;
- parity tests across PND and artist template;
- a CI mode that blocks PND endpoints.

The W1.1 design boundary is complete in
`docs/portable-release-boundary.md`. Implementation extraction remains gated
on W0.1 resolving the overlapping Surface UI work once.

### W2: venue and editorial release system

Outcome: PND visibly operates a selective venue on top of the neutral
protocol.

Deliverables:

- visual homepage hierarchy;
- Releases directory;
- reusable launch-page format;
- lightweight editorial metadata;
- launch calendar and release journal;
- profile and About alignment;
- complete permissionless record separated from featured programming.

Editorial metadata should begin as checked-in versioned files or an equally
simple Postgres model. A CMS is not required.

### W3: artist independence tools

Outcome: artists can understand dependencies, export a release, deploy an
independent interface, and optionally publish a destination without PND
claiming to verify independence.

Deliverables:

- Studio lifecycle and action queue;
- private independence checkup;
- portable release export;
- Surface-capable artist template;
- deployment and custom-domain guidance;
- optional signed site declaration;
- operational runbook and data export.

### W4: portable distribution network

Outcome: releases can travel through artist, curator, and publication surfaces
without being re-created as platform-specific objects.

Deliverables:

- downloadable launch pack;
- RSS, Atom, or JSON release feeds;
- Open Graph and social assets;
- portable release cards and mint embeds;
- open referral configuration;
- adapters for artist-controlled communication providers.

PND does not own subscriber lists or require creators to route distribution
through PND.

### W5: integration, activation, and observation

Outcome: the connected system ships as one coherent public experience.

Deliverables:

- one integration preview using live read-only production data;
- desktop and mobile route matrix;
- degraded-state and PND-disabled template review;
- performance and accessibility evidence;
- cost and RPC report;
- one activation PR;
- 24-hour and 7-day production observation.

## Delivery strategy

Use stacked delivery with hidden integration:

1. Merge W0 correctness and control-plane work.
2. Merge W1 packages and tests without changing the public hierarchy.
3. Build W2 and W3 against W1 in separate path-owned worktrees.
4. Integrate W2 and W3 on one preview branch.
5. Add W4 only against the stable release format.
6. Activate W2 through W4 together when all release gates pass.
7. Observe cost and reliability before closing W5.

Do not hold all implementation in one long-lived branch. Do not expose public
fragments merely because their local PR is complete.

The machine graph decomposes these workstreams into milestones. W0.1 and W1.1
are intentionally parallel: foundation integration and release-boundary design
can proceed together, while shared-code extraction waits for the overlapping
foundation files to resolve once.

## Release gates

The program cannot activate until all of these are true:

- indexing and availability claims map to durable evidence;
- no browse page adds request-time historical or per-token scanning;
- PND and artist interfaces pass shared behavioral tests;
- the artist template passes with PND endpoints blocked;
- live-data previews contain no dummy content;
- image, video, HTML, missing-media, loading, and error states are reviewed;
- desktop and 390px mobile route matrices pass;
- p75 mobile LCP is at most 2.5s, CLS is below 0.1, and INP is below 200ms on
  representative routes, or an explicit measured exception is approved;
- every recurring-cost change has a written estimate;
- projected added recurring cost remains at or below $10 per month;
- migrations, deploy order, activation, and rollback are explicit;
- open PR and worktree overlap is resolved once, not independently per branch;
- the preview commit SHA matches the reviewed activation candidate.

## Success measures

Measure only what PND can truthfully observe:

- completed PND launches;
- direct artist revenue through PND-hosted interfaces;
- unique and repeat collectors;
- release-page to transaction conversion;
- successful template deployment flows initiated through Studio;
- optional artist-published external destinations;
- portable feed and embed usage when explicitly measurable;
- RPC, database, media, and hosting cost per active release.

Do not label a template deployment as an active independent site unless the
artist explicitly publishes that destination. Do not create a graduation rate.

## Non-goals

- inferred artist, collector, or curator identity;
- public independence scores;
- PND-owned domains, hosting accounts, or subscriber lists;
- mandatory PND APIs in independent interfaces;
- algorithmic recommendation infrastructure;
- request-time wallet-wide chain scans;
- a general-purpose drag-and-drop website builder;
- curation inferred from holdings, favorites, or Catalog declarations.

## Decision rule

When a proposed feature conflicts with the program, prefer the option that:

1. preserves artist authority;
2. keeps protocol truth and declarations distinct;
3. reduces runtime and coordination cost;
4. creates a reusable lower-layer capability;
5. remains useful when PND is not the primary interface;
6. produces evidence that another agent can reproduce.
