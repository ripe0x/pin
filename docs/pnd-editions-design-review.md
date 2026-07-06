# PND Editions design review

> **SUPERSEDED (2026-07-06).** The Editions contract was reworked into the
> SovereignCollection system (OZ ERC721 core, four slots, id modes); see
> docs/pnd-collection-system.md and docs/pnd-collection-contracts-plan.md.
> This document describes the pre-rework ERC721A design; payment-split,
> hook, and graph concepts carry over, token-layer specifics do not.
> Contracts now live in contracts/src/collection/ (src/editions/ was
> removed).

> A positive-sum read of the protocol against PND's own ethos (honest money, no
> mandatory protocol fee, artist sovereignty, per-token identity, anti-
> financialization, permanence), and the improvements shipped on this branch.
> Companion to `docs/pnd-editions-security-review.md`. The contract is the source
> of truth; this doc explains the "why".

## How it holds up

The core is faithful where PND draws hard lines: the collector pays exactly
`price * quantity`, there is no protocol tax on the collector, price 0 is framed
as "gas only" not "free", and there is no rewards token, AMM, rarity, or feed-as-
product. Per-token identity (ERC721A) is the structural choice that makes Mint
Marks and the Token Path possible. The surface share is the inverted, opt-out-by-
self-hosting version of Zora's mint referral.

Two gaps motivated this branch:

1. The Edition Graph and Token Path shipped inert, and the hook system had no
   reference implementations, so the continuity economy (PND's on-ethos answer
   to "weak secondary") was unused.
2. Several trust and disclosure gaps the always-upgradeable design makes
   reachable (covered in the security review).

## Decisions (with the user)

- **Surface Share stays a fixed 10%, caller-chosen.** PND earns on PND-hosted
  mints; the artist's opt-out is self-hosting (they pass their own address and
  keep 100%). This is deliberate: it is both PND's business model and a standing
  incentive for artists to move to their own sovereign page. The honest framing
  (the artist keeps at least 90%, 100% on their own surface) is now in the copy.
- **Per-wallet caps live in a hook, not the core.** Matches the design doc's
  "gate in your own mint hook" stance and keeps the core minimal.
- **Collaboration is first class** via a full 0xSplits deploy in the create flow.

## What shipped

### Continuity economy

- **Reference mint-hook library** (`contracts/src/editions/hooks/`), public goods
  any edition can point at, configured per-edition by its owner:
  - `PNDPerWalletCapHook` - fair capped drops (no single-tx buyout).
  - `PNDAllowlistHook` - Merkle presale (OpenZeppelin standard-tree leaves).
  - `PNDHoldsEditionHook` - the conviction primitive: gate edition B on holding
    edition A, so early collectors of a body of work get access to the next
    chapter. No financialization, just continuity.
- **Bilateral Edition Graph handshake** - `acknowledgeEdge` / `isEdgeAcknowledged`
  let edition B confirm an inbound edge that A claims, so a reader can show
  "verified mutual" instead of an unauthenticated one-sided claim, with no
  central registry. Turns the graph into a trustworthy public good.

### Collaboration

- The create flow deploys an immutable 0xSplits split (controller 0) from the
  artist's collaborator list and points the edition's payout at it. Combined with
  the settle-before-upgrade gate (below), collaborator funds leave the artist's
  upgradeable edition and land in the immutable split before any upgrade can run.

### Trust and permanence (from the security review)

- **Settle-before-upgrade** keeps pull payments but makes an upgrade impossible
  while any payee is owed, so the host surface share and collaborator shares can
  never be swept by an upgrade.
- **Honest permanence**: `isPermanent()` is sealed && frozen; the UI only claims
  "Permanent" when both hold.
- Renounce disabled, `setMintHook` locked once sealed, two-step ownership,
  royalty cap, stray-ETH rescue, RFC-8259 metadata escaping.

## Still open (good future work, not on this branch)

- **Token Path execution.** v1 is still pointer-only. The hooks above are the
  bridge (a hook can read the graph / a prior edition); a later version can make
  the Path itself actionable (claim, continuation, migration) while staying anti-
  financialization.
- **Time-phased pricing** is not expressible against the fixed-price core (the
  core validates `msg.value == price*quantity`); only gating is. A phased-price
  primitive would need a small core change and is deliberately out of scope.
- **Multi-party surface split.** The surface is a single address today; a split
  address already works as the surface, and a native multi-surface split is a
  possible later refinement.
