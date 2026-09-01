# PND editorial and venue boundary

> **Status: accepted W2.1 specification**
> **Updated: 2026-08-31**
> **Depends on: `docs/portable-release-boundary.md`**

## 1. Decision

PND is a selective, art-led venue built on top of a complete permissionless
record. Selection changes attention and context. It never changes protocol
truth, artist authorship, availability, or whether a release exists in the
record.

The venue has two simultaneous obligations:

1. make the work and the people around it legible, desirable, and easy to act
   on;
2. preserve a complete, honest record that does not disappear when PND stops
   featuring a release.

This is the boundary between those obligations.

## 2. Truth ownership

### Protocol and observed facts

The following fields come from contracts or indexed current-state tables:

- collection address, owner, minter, renderer, and network;
- name and symbol observed from the deployed collection;
- schedule, price, price strategy, supply, and minted count;
- lifecycle and availability derived from those facts;
- artwork media discovered through indexed token metadata;
- mints, transfers, sales, bids, and ownership history.

The editorial layer may select and arrange these facts. It may not override
them. Unknown sale state is presented as `Release record`, never guessed as
open, sold out, or closed.

### Artist declarations

Artist-authored premise, statement, credits, media, and optional external site
belong to the portable release manifest. PND may display them with clear
attribution. They do not belong in PND's editorial file.

An external site is an artist-provided destination. PND cannot infer that the
artist deployed, owns, or continuously operates that interface.

### PND editorial declarations

PND owns only:

- whether a release is featured;
- the order among featured releases;
- a concise PND-authored summary;
- an optional stable PND route slug.

These declarations use
`docs/schemas/pnd-editorial-release-v1.schema.json`. Runtime validation also
enforces unique collection addresses and unique feature orders, constraints
that JSON Schema cannot express across array entries.

## 3. Join and failure contract

Every editorial declaration joins to a real indexed Surface collection by
lowercase mainnet address. There is no dummy release, synthetic artwork,
editorial-only availability, or placeholder transaction state.

A programmed release is resolved independently of directory pagination and
recency windows. Adding newer releases or visiting an older page cannot make a
feature disappear. The read is one bounded Postgres query, accepts at most 12
validated addresses, and adds no request-time RPC.

Failure rules:

- if an editorial entry does not join to a real collection, omit it and keep
  the complete permissionless record;
- if current sale-state tables are unavailable but the collection record is
  available, show the release with unknown availability;
- if the indexer read fails, show an explicit unavailable state where the
  complete record belongs;
- if media is loading, preserve the card geometry and use the quiet loading
  state;
- if media ultimately fails, show the intentional unavailable treatment and
  retain the release link and facts;
- never replace unavailable live data with fixture or dummy content.

## 4. Venue hierarchy

### `/`

The homepage is the venue front door:

1. proposition and primary browse actions;
2. one programmed current or upcoming release, otherwise the best real recent
   release;
3. upcoming releases;
4. work available now across the wider indexed ecosystem;
5. recent Surface releases;
6. a compact, reliable activity stream;
7. profiles, infrastructure, preservation, and Studio pathways as supporting
   context.

The page speaks about art, artists, releases, ownership, and operation.
`Indexed` is implementation vocabulary reserved for explanatory help, not a
headline product category.

### `/collections`

The stable technical route is publicly named **Releases**. It contains:

1. clearly labeled PND editorial selection;
2. the complete permissionless Surface record;
3. lifecycle grouping and clamped pagination derived from real current state.

An editorial feature remains visible on every valid or clamped page. It does
not count as, reorder, or remove an entry from the paginated record.

### `/collections/[address]`

The release page is the authoritative venue page for one collection:

1. artwork and artist-authored context;
2. live or deterministic exploration;
3. current mint or auction action;
4. price, schedule, supply, and lifecycle;
5. provenance, preservation, and dependencies;
6. optional artist-provided external destination;
7. quiet contract and technical details.

Generic collection behavior must ultimately come from the shared release
kernel. Custom releases declare capabilities and adapters rather than teaching
the venue to pretend they use the generic minter.

### Supporting routes

- `/activity` is a durable event journal with explicit source and pagination.
- `/profile/[address]` is a person-level record ordered around current release,
  available work, created work, sold/transferred history, collected work, and
  Catalog declarations.
- `/about` explains the product promise and truth boundaries without turning
  the site into infrastructure documentation.
- `/studio` owns creation, operation, export, and optional self-hosting tools.
- `/landing-v2` is a temporary implementation alias. `/` is canonical.

## 5. Audience contract

One address may be artist, collector, and curator. The venue does not require
an account-type choice.

- Artists receive legible release context, availability, durable history,
  ownership of their contracts, and a path to portable operation.
- Collectors receive clear current actions, artistic premise, price and supply,
  provenance, preservation, and a durable collected record.
- Curators receive authored selection objects in future W2/W4 work. Wallet
  behavior is never silently promoted into curation.

The distinctive value is the connection between selective attention,
artist-owned protocols, cross-platform record, preservation, and portable
operation. Features that merely imitate a marketplace without strengthening
that connection are outside the program's center.

## 6. Source ownership

| Concern | Current owner | Future owner |
| --- | --- | --- |
| PND editorial declarations | `apps/web/src/content/releases.json` | PND venue assembly or editorial provider |
| Editorial validation | `apps/web/src/lib/release-editorial.ts` | PND editorial provider adapter |
| Release facts | `apps/web/src/lib/indexer-queries.ts` | core/history providers |
| Lifecycle and labels | `apps/web/src/lib/collection.ts` | `@pin/surface-kit` |
| Homepage composition | `apps/web/src/components/home/landing-v2/` | PND venue assembly |
| Release directory | `apps/web/src/app/collections/` | PND venue assembly |
| Shared media states | `AvailableArtwork` and media components | `@pin/surface-react` primitives |

Lower packages must not import the editorial file or PND routes. The portable
manifest must not contain PND feature order or PND-authored copy.

## 7. Performance and cost

- Browse and editorial reads use Postgres current-state tables only.
- Programmed releases use one bounded address query with a hard maximum of 12.
- The complete directory is paginated at 24 records per page.
- The homepage recent window is capped at 18 records.
- No venue route adds historical `eth_getLogs`, per-card RPC, or a paid CMS.
- Editorial data remains a reviewed repository artifact until its operating
  burden justifies a different system.
- Projected added recurring cost for W2.1 is $0 per month.

## 8. Acceptance matrix

- A programmed release remains visible after more than 24 newer releases.
- A programmed release remains visible when the URL requests an out-of-range
  directory page.
- An out-of-range page resolves to the final valid page before querying rows.
- Editorial copy never supplies artist attribution, sale state, supply, price,
  or artwork media.
- Missing editorial joins create no dummy cards.
- Old indexer schemas retain the real collection record and explicitly unknown
  sale state.
- Homepage, Releases, release page, Activity, profile, About, and mobile
  navigation are reviewed on one Netlify preview using live read-only data.
- Loading, successful image, cached image, unavailable media, empty, partial,
  and database-unavailable states have intentional render behavior.
- The mobile route matrix has no page-level horizontal overflow.

## 9. Handoff to W2.2

W2.2 should consume the W1 shared kernel before declaring the connected venue
complete. Its implementation order is:

1. resolve W0.1 overlaps and production indexer truth;
2. extract W1.2 lifecycle, render, quote, and transaction behavior;
3. make homepage, Releases, and release pages consume those shared contracts;
4. attach artist manifest declarations to release pages;
5. add authored curator objects only after their provenance and portability
   format is specified;
6. run the full live-data responsive, media, performance, and cost gates.

The current PR proves the venue hierarchy and fixes immediate reliability
faults. It does not claim W2.2's shared-kernel integration is complete.
