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

2. **Two token architectures exist in parallel.** Surface is model A. Homage's
   `SovereignCollection` + `HomageMinter` is model **B** (thin token, all
   economics in the minter) and it works. Maintaining two token models for the
   same concept is the duplication the repo conventions warn against.

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

This unifies the two stacks. After the change there is one token model across
PND. A project's identity is "the platform token plus whichever minter is
plugged in." Homage stops being a separate architecture and becomes the token
plus `HomageMinter`.

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
- **Phase 4 (unify Homage).** Confirm `SovereignCollection`/`HomageMinter`
  collapse onto the unified model (the thin token plus `HomageMinter` as the
  authorized minter). Retire the parallel stack in `ripe0x/permanence` or
  document the shared base. This is the duplication-elimination payoff.
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

## 7. Open decisions (resolve in Phase 0)

1. **Gate composition.** One `FixedPriceMinter` with allowlist + per-wallet cap
   as optional config, or small composable minters (`AllowlistMinter`,
   `CappedMinter`) plus multi-minter authorization? Leaning: one configurable
   canonical minter for the common case, siblings for the rest.
2. **`IPriceStrategy` retention.** Keep the external strategy hook inside the
   canonical minter (TBAM-shaped pricing), or fixed-price-only in canonical and
   strategies as separate minters? Leaning: keep it inside, it is cheap.
3. **Multi-minter policy on sequential.** Allow N concurrent minters (Zora
   model) from launch, or single-minter everywhere for v1 simplicity and open
   multi later? Leaning: allow N on sequential, keep pooled single.
4. **Minter immutability.** Cloneable immutable minters (matching the immutable
   token clones) vs a shared singleton minter keyed by collection? Leaning:
   immutable clones, consistent with the token trust story.
5. **Homage retirement scope** (Phase 4): fully collapse `SovereignCollection`
   onto the platform token, or keep it as a thin subclass? Leaning: collapse if
   behavior is identical after the token thins out.

## 8. Non-goals

- No change to the renderer, Catalog, or lifecycle-lock designs.
- No change to the pooled single-minter safety model (`#150` M-01), which fits
  the thin token unchanged.
- No change to the owner-scoped admin-grant semantics (`#150`).
- Not a mass-launchpad pivot: this optimizes for PND's bespoke workload.
