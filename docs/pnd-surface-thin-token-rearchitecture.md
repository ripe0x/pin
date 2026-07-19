# PND Surface: thin-token + modular-minter rearchitecture

> **Status: design proposal, pre-implementation (2026-07-19).** This document
> proposes moving Surface from a **fat token** (the ERC721 owns sale economics)
> to a **thin token + modular minter** architecture (the ERC721 holds no value
> and no sale logic; every mint goes through an authorized minter). It
> **supersedes** `docs/pnd-surface-contracts-plan.md` Phase 0 decision #2
> ("FixedPrice: built-in field vs strategy contract", which chose the built-in
> field) and reframes the deferred "Phase 5 minters" as the primary mint
> surface rather than an optional extension. No code changes land from this doc;
> it is the plan the implementation branch builds against.
>
> Companion reading: `docs/pnd-surface-system.md` (current design overview),
> `docs/pnd-surface-contracts-plan.md` (the model-A build plan this revises),
> `docs/surface-glossary.md`.

## 1. Why revisit a working, audited design

Surface today is model **A**: `SurfaceCore` carries value custody
(`_pending`/`_settle`/refund), a fixed `price` plus optional `IPriceStrategy`,
the referral split, the mint window, and a single `mintHook` slot. `Surface`
and `PooledSurface` expose built-in paid mint paths (`mint`,
`mintWithReferral`, `mintFor`) alongside an "extension path" (`mintTo`,
`mintToId`) for authorized external minters. The token is simultaneously a
self-contained sale contract and a delegatable mint target.

That dual role is the source of the complexity. Three observations drive this
proposal:

1. **The workload is bespoke, not mass-market.** PND ships a small number of
   carefully built, concept-driven projects (Homage, the-average,
   permanent-collection), each with custom economics (a $111 escrow, a pooled
   backing, an acquisition protocol). This is exactly the workload where a
   dedicated minter earns its keep and the fat-token machinery is unused weight.
   Model A optimizes for the high-volume simple-drop case PND does not run.

2. **The flagship project already ignores the fat-token machinery.** Homage
   drives a **stock `PooledSurface`** purely through the extension path:
   `HomageMinter` is the collection's authorized minter and calls
   `mintToId`/`burn`, while all economics (the per-wallet fee escalator, the
   Uniswap v4 ETH-to-$111 swap, the $111 escrow, and redeem) live in
   `HomageMinter`. It never touches the token's built-in paid mint, price fields,
   or `mintHook`, and it does not even use the token's referral (it passes
   `referrer = address(0)`). So the thin-token model is already how PND's real
   project works; model A is carrying a paid-mint apparatus the flagship proves
   unnecessary. (`HomageMinter` uses the model-B shape today; there is no
   Homage-specific token subclass, it uses `PooledSurface` as-is.)

3. **A permanent art token should not custody money.** Value custody, refunds,
   and price curves are sale-time concerns with a finite life. The token is the
   permanent artifact and should outlive any sale mechanic. Welding mutable
   economics onto it enlarges the permanent object's audit surface for no
   lasting benefit.

The wider field agrees: modern platform design (Zora 1155 sale strategies,
Manifold extensions, Thirdweb) is thin token plus swappable sale modules. The
`mint()`-baked-in token is the older PFP pattern.

## 2. Decision

Adopt **thin token + modular minters**, with **one canonical, audited
fixed-price/referral minter** shipped as the default and wired automatically by
the factory. Custom minters (`HomageMinter`, auction houses, backed pools) are
the deliberate opt-in for bespoke economics.

The canonical minter is what makes this best-practice rather than a foot-gun:
naive thin-token ("every artist brings their own minter") produces N unaudited
value-handling contracts. A single audited default covers the common case while
custom minters stay the exception.

This makes the platform token match how Homage already uses it. A project's
identity is "the platform token plus whichever minter is plugged in", which is
exactly Homage today (stock `PooledSurface` + `HomageMinter`). The change is that
the token stops shipping the paid-mint, price, and hook code the extension path
never calls, so the permanent object is smaller and the one mint surface is the
minter for every project.

## 3. Target architecture

### 3.1 Responsibility split

| Concern | Model A (today) | Target (thin token) |
| --- | --- | --- |
| ERC721 ownership, transfer, burn | token | token |
| Renderer / tokenURI | token | token |
| Catalog attribution | token | token |
| Supply cap | token | **token** (structural invariant of the artifact) |
| Lifecycle locks (renderer, supply, minter) | token | token |
| Admin / minter authorization | token | token |
| Price (fixed or strategy) | token | **minter** |
| Mint window (start/end) | token | **minter** |
| Payment, overpayment refund | token | **minter** |
| Referral split | token | **minter** (canonical minter implements it) |
| Gating (allowlist, per-wallet cap, holds) | token `mintHook` | **minter** |
| Value custody (ETH held anywhere) | token `_pending` | **minter** |

The token keeps only what is a property of the permanent collection. Everything
tied to a *sale* moves to the minter.

### 3.2 The token after the change

`SurfaceCore` loses value custody, the paid-mint entrypoints, the price
fields, the mint-window fields, and the `mintHook` slot. It retains:

- ERC721 (OZ upgradeable base, cloned via EIP-1167 as today)
- admin/minter authorization (owner-scoped grants, `#150` semantics unchanged)
- supply cap accounting (sequential `mintedEver`-bounded; pooled live-supply)
- lifecycle locks: `lockRenderer`, `lockSupply`, and pooled `lockMinter`
- renderer wiring + Catalog attribution
- the single mint entrypoint per form, minter-gated and non-payable:
  - sequential: `mintTo(address to, ...) returns (uint256 tokenId)`
  - pooled: `mintToId(address to, uint256 tokenId, ...)`
- burn, gated as today (sequential: owner/approved; pooled: minter)

No `mint`/`mintWithReferral`/`mintFor`, no `_pending`/`_settle`/refund, no
`price`/`priceStrategy`/`mintStart`/`mintEnd`, no `IMintHook`. The token never
receives ETH.

**Multi-minter.** Sequential collections may authorize several minters (a
public-sale minter, an allowlist minter, an auction minter) each with its own
economics, matching the Zora multi-strategy model. Pooled collections keep the
**single-minter** safety model unchanged (`#150` M-01): one minter at a time,
owner-only `setMinter`/`lockMinter`, since the pooled minter can hold real
backing value.

### 3.3 The minter interface

A minimal `IMinter` the token trusts only for "may call `mintTo`/`mintToId`".
The token authorizes minters; it does not prescribe their internals. The
canonical minter and every custom minter share the value-facing shape so
frontends and indexers see a uniform mint surface:

```
mint(address collection, uint256 quantity, address referrer, bytes hookData) payable
priceOf(address collection, address to, uint256 quantity, bytes hookData) view returns (uint256)
```

`hookData` survives only as the channel for genuinely caller-supplied input
(a Merkle proof, a signature), now consumed inside the minter rather than
forwarded through the token. Gating that reads only on-chain state (per-wallet
cap, holds-a-token) needs no `hookData` and is minter-internal.

### 3.4 The canonical minter

`FixedPriceMinter` (working name), cloneable per collection:

- stores sale config: `price`, `mintStart`, `mintEnd`, `payout`
- `mint(...)` payable: checks window, computes required (fixed, or an optional
  `IPriceStrategy` for TBAM-shaped pricing), enforces exact-on-fixed /
  accept-over-on-strategy with overpayment refunded via pull-payment
- pays the permissionless referral split (`REFERRAL_SHARE_BPS`) exactly as the
  current `_settle`, then the artist payout
- optional built-in gates, absorbing today's hooks: Merkle **allowlist** (the
  `AllowlistHook` logic) and **per-wallet cap** (the `PerWalletCapHook`
  counter). `HoldsSurfaceHook`-style checks either compose in or ship as a
  sibling minter.
- calls `collection.mintTo(to)` / `mintToId(to, id)` (non-payable,
  minter-gated) to actually mint

Value conservation (no caller withdraws more than deposited, no funds
stranded) becomes a minter invariant, tested with the same rigor the audit
applied to `SurfaceCore._settle`.

### 3.5 Factory: preserve the one-transaction ergonomic

The strongest argument *against* thin-token is per-collection wiring overhead
(two deploys, a grant, an approval). The factory neutralizes it for the common
case. `createSurface(...)` clones the thin token, clones a `FixedPriceMinter`,
grants it minter rights, optionally `lockMinter`s (pooled), and returns both,
all in one transaction. An artist doing a plain priced drop still calls one
factory function and gets a working, selling collection. Custom-minter projects
pass their own minter (or grant it post-deploy) instead of the canonical clone.

Pause/deprecate gating and the `#148` address-validation checks carry over to
both the token-impl and minter-impl wiring.

## 4. What moves, concretely

| Current location | Moves to |
| --- | --- |
| `SurfaceCore._settle`, `_pending`, refund | `FixedPriceMinter` |
| `Surface.mint/mintWithReferral/mintFor` | `FixedPriceMinter.mint` |
| `_cfg.price`, `_cfg.priceStrategy` | `FixedPriceMinter` config |
| `_cfg.mintStart`, `_cfg.mintEnd` | `FixedPriceMinter` config |
| `_cfg.mintHook` + `_runBeforeHook`/`_runAfterHook` | `FixedPriceMinter` gates |
| `AllowlistHook` Merkle verify | `FixedPriceMinter` (or `AllowlistMinter`) |
| `PerWalletCapHook` counter | `FixedPriceMinter` per-wallet accounting |
| `HoldsSurfaceHook` | sibling minter or composed gate |
| `GateHook` (bundling, only needed because of one hook slot) | **deleted**; multi-gate is native to a minter |

`mintTo`/`mintToId` stay on the token and become the *only* mint path. The cap,
lifecycle locks, renderer, and Catalog stay put.

## 5. Phasing

Implementation starts from a fresh branch off updated `main` (repo
squash-merges; do not build on this design branch). Each phase is a reviewable
PR with tests as a first-class deliverable, not a trailing phase.

- **Phase 0 (decisions).** Lock the open questions in section 7 as short
  decision notes appended here before any code. All are one-way once deployed.
- **Phase 1 (thin token).** Strip value custody, paid-mint, price/window
  fields, and hooks from `SurfaceCore`/`Surface`/`PooledSurface`. Keep cap,
  locks, renderer, Catalog, `mintTo`/`mintToId`. Port the token tests; delete
  the value-custody tests that no longer apply to the token (they move to
  Phase 2). Delete `IMintHook`, the hook contracts, `GateHook`.
- **Phase 2 (canonical minter).** Build `FixedPriceMinter`: price/strategy,
  window, payment/refund, referral, optional Merkle allowlist + per-wallet cap.
  Port `AllowlistHook`/`PerWalletCapHook` logic. Value-conservation invariant
  suite. Optional `HoldsSurfaceMinter` sibling.
- **Phase 3 (factory).** Rework `SurfaceFactory` to clone token + canonical
  minter and wire them in one transaction; carry pause/deprecate and `#148`
  validation to both impls. Add the bring-your-own-minter path.
- **Phase 4 (revalidate Homage).** Homage already drives a stock `PooledSurface`
  through the extension path (`mintToId`/`burn`), so there is no token to
  collapse. The work is: confirm `HomageMinter` is unaffected when the built-in
  paid mint, price fields, and hooks are stripped from `PooledSurface` (it only
  uses `mintToId` + `burn`, so it should be), and re-vendor the thinned Surface
  into `ripe0x/permanence`'s `contracts/src/vendor/surface/` to keep the pin
  copy authoritative. This phase spans both repos but is a verification and
  re-vendor pass, not a rewrite.
- **Phase 5 (web).** Rewire mint call sites to target the minter. The uniform
  `IMinter` ABI means the frontend reads one mint interface regardless of
  collection. Grep for `mintWithReferral` and the token-mint calls; repoint.
- **Phase 6 (audit + deploy).** Reset the audit baseline over the thin token +
  canonical minter + factory, re-audit, then deploy per the existing runbook.

## 6. Downsides and mitigations (honest)

1. **Complexity is relocated, not deleted.** Token + canonical minter has
   comparable total moving parts to the fat token, plus an inter-contract call.
   *Accepted:* the win is a money-free permanent token and one unified stack,
   not fewer lines.
2. **N-minter risk.** Custom minters are unaudited value handlers. *Mitigated:*
   the canonical audited minter is the default; custom minters are the
   deliberate exception PND already writes carefully (HomageMinter).
3. **The token can no longer enforce economic invariants** (that price was paid,
   referral taken) because it no longer sees value. *Accepted:* those become
   minter invariants; the token still structurally enforces the supply cap.
4. **Platform economic primitives become escapable** (a custom minter can skip
   the referral share). *Accepted:* referral is already permissionless-by-design
   with self-referral an accepted tradeoff; PND does not force it structurally.
5. **Per-mint external call + two deploys.** *Mitigated:* the factory does the
   two-contract wiring in one transaction; the extra `mintTo` call is a small
   gas cost noted, not a UX change.
6. **ABI uniformity risk.** *Mitigated:* the standardized `IMinter` shape plus
   the canonical minter keep "how do I mint this?" a single answer.

## 7. Phase 0 decisions

> Recommendations below await owner sign-off before Phase 1 opens. Each is
> one-way once deployed. Format: decision, rationale, consequence.

### 7.1 Gate composition

**Decision:** the canonical `FixedPriceMinter` carries the two common gates,
**Merkle allowlist** and **per-wallet cap**, as optional config, AND-composed in
the one contract. Rarer gates (`holds-a-token`, signature) ship as sibling
minters. Multi-minter authorization (7.3) is the separate OR axis.

**Rationale:** gate composition has two distinct axes and they need different
mechanisms. **AND** ("allowlisted *and* under the per-wallet cap") only works if
both checks run in the *same* mint call, i.e. the same contract. This is exactly
why `GateHook` had to exist under model A (one hook slot forced bundling). Two
separately authorized minters cannot AND a single sale; each is its own
entrypoint, so authorizing `AllowlistMinter` and `CappedMinter` side by side
gives a buyer an ungated path through whichever is looser. **OR** ("a public
sale *or* a separate allowlist presale") is the multi-minter case: two distinct
sales on one collection, each its own minter. So the common AND-pair belongs
inside one minter; the OR axis is multi-minter.

**Consequence:** `GateHook` is deleted (its reason to exist was the single hook
slot). `AllowlistHook` + `PerWalletCapHook` logic is absorbed into the canonical
minter. `HoldsSurfaceHook` becomes `HoldsSurfaceMinter` (or a composed gate).

### 7.2 IPriceStrategy retention

**Decision:** keep the external `IPriceStrategy` inside the canonical minter.
Fixed `price` when the strategy slot is unset; a set strategy overrides it,
read once and reused for the settle (the current read-once safety).

**Rationale:** it is one optional slot and a single view call, and it preserves
TBAM-shaped / time-based pricing the platform may want without a separate minter
lineage. The read-once-reuse pattern that protects value conservation is already
audited; it ports unchanged into the minter. Fragmenting dynamic pricing into
separate minters buys nothing here.

**Consequence:** `IPriceStrategy` survives as a minter-level interface. The
value-conservation invariant suite (7.4-independent) covers both the fixed and
strategy branches inside the minter.

### 7.3 Multi-minter on sequential

**Decision:** sequential collections may authorize **N concurrent minters** from
launch. Pooled collections stay **single-minter** (owner-only
`setMinter`/`lockMinter`, `#150` M-01), unchanged.

**Rationale:** composing sale mechanics is the point of going modular;
restricting sequential to one minter for a "simpler v1" discards the core
benefit and forces a later widening. Sequential id assignment is append-only and
the token hands out the next id, so concurrent minters cannot collide on ids,
and the token enforces the supply cap across all of them centrally. The token
already models a minter *set* (`_minters` mapping), so this is the natural shape,
not an addition. Pooled must stay single because its minter can custody real
backing value, where a second minter is a burn/backing hazard.

**Consequence:** "who can mint this collection" is a set, not a scalar, for
sequential. Frontends enumerate authorized minters. Cap accounting stays on the
token precisely so it holds across all minters.

### 7.4 Minter immutability

**Decision:** immutable **EIP-1167 clones per collection**, matching the
immutable token clones. No shared singleton minter.

**Rationale:** value isolation. A per-collection clone holds only that
collection's transient balance (unclaimed refunds and payouts under the
pull-payment), so a bug or drain is scoped to one collection, not the whole
platform. A shared singleton keyed by collection pools every collection's ETH in
one contract: a larger honeypot and a per-collection-keyed accounting surface
that is easier to get wrong. The factory already deploys a clone per collection
in its one-transaction wiring (3.5), so the per-collection deploy cost is already
budgeted and the singleton's only advantage (skip the clone) is the cost PND is
willing to pay for isolation. It also keeps the same immutable-clone trust story
as the token.

**Consequence:** each collection has its own minter address. Minter evolution is
by factory-offered new implementations, never by mutating a deployed minter,
mirroring the token.

### 7.5 Homage impact

**Decision:** no token-collapse work. Homage already uses a **stock
`PooledSurface`** (no Homage-specific subclass exists) and drives it purely
through the extension path, `HomageMinter` calling `mintToId`/`burn`. Phase 4 is
a verification-and-re-vendor pass: confirm `HomageMinter` is unaffected by
thinning `PooledSurface` (it never calls the built-in paid mint, price, or hook
code being removed), then re-vendor the thinned Surface into
`ripe0x/permanence`.

**Rationale:** Homage is already the model-B shape this proposal generalizes.
Its minter holds all economics; the token is already just a mint/burn/render
target it authorizes. So the flagship both validates the thin-token target and
has nothing to migrate. The only coupling is the vendored Surface copy in
`permanence/contracts/src/vendor/surface/`, which must track the thinned pin
source.

**Consequence:** Phase 4 is verification plus a re-vendor, spanning both repos,
not a rewrite. The risk is limited to a vendored-copy drift, caught by running
Homage's suite against the thinned token.

## 8. Non-goals

- No change to the renderer, Catalog, or lifecycle-lock designs.
- No change to the pooled single-minter safety model (`#150` M-01), which fits
  the thin token unchanged.
- No change to the owner-scoped admin-grant semantics (`#150`).
- Not a mass-launchpad pivot: this optimizes for PND's bespoke workload.
