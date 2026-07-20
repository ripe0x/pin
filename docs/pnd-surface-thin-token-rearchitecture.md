# PND Surface: thin-token + modular-minter rearchitecture

> **Status: design locked (2026-07-19), pre-implementation.** This document
> moves Surface from a **fat token** (the ERC721 owns sale economics) to a
> **thin token + modular minter** architecture (the ERC721 holds no value and
> no sale logic; every mint goes through an authorized minter). The section 7
> decisions were reviewed and signed off 2026-07-19; the ABI targets in
> section 3 reflect them. It **supersedes** two locked decisions in
> `docs/pnd-surface-contracts-plan.md` Phase 0: decision #2 ("FixedPrice:
> built-in field vs strategy contract", which chose the built-in field) and
> decision #3 ("hooks run on all mint paths"; the token-level hook axis is
> deleted, see 7.1 and section 6). It reframes the deferred "Phase 5 minters"
> as the primary mint surface rather than an optional extension. Section 9
> records the relationship to prior decisions. No code changes land from this
> doc; it is the plan the implementation branch builds against.
>
> Companion reading: `docs/pnd-surface-system.md` (current design overview;
> its sections 3.1 and 8.5 describe model A and get revised at implementation
> time), `docs/pnd-surface-contracts-plan.md` (the model-A build plan this
> revises), `docs/surface-glossary.md`.

## 1. Why revisit a working, audited design

Surface today is model **A**: `SurfaceCore` carries value custody
(`_pending`/`_settle`/refund), a fixed `price` plus optional `IPriceStrategy`,
the referral split, the mint window, and a single `mintHook` slot. The
sequential final (`Surface`) exposes the built-in paid mint paths (`mint`,
`mintWithReferral`, `mintFor`) alongside the extension path (`mintTo`). The
pooled final (`PooledSurface`) exposes **no paid path at all**, only
`mintToId`, yet inherits the full value apparatus (pull-payment balances,
`withdraw`, the price fields, the window, the hook slot) as permanently
unreachable surface: nothing in the pooled form ever calls `_settle`. So the
sequential token is simultaneously a self-contained sale contract and a
delegatable mint target, and the pooled token is already thin at the
entrypoint while fat in inherited weight.

That split role is the source of the complexity. Three observations drive
this change:

1. **The workload is bespoke-first, not mass-market.** PND ships a small
   number of carefully built, concept-driven projects (Homage, the-average,
   permanent-collection), each with custom economics (a $111 escrow, a pooled
   backing, an acquisition protocol). This is exactly the workload where a
   dedicated minter earns its keep. The preset workload (Editions, studio
   generative drops for no-Solidity artists) still needs a paid path, but it
   needs *one audited paid path*, not one welded into every permanent token;
   the canonical minter carries it.

2. **The flagship project already ignores the fat-token machinery.** Homage
   drives a **stock `PooledSurface`** purely through the extension path:
   `HomageMinter` is the collection's authorized minter and calls
   `mintToId`/`burn`, while all economics (the per-wallet fee escalator, the
   Uniswap v4 ETH-to-$111 swap, the $111 escrow, and redeem) live in
   `HomageMinter`. It touches exactly four things on the token: `mintToId`,
   `burn`, `renderer()`, and `ownerOf`. It does not use the token's referral
   (it passes `referrer = address(0)`). So the thin-token model is already how
   PND's real project works; model A is carrying a paid-mint apparatus the
   flagship proves unnecessary. (`HomageMinter` uses the model-B shape today;
   there is no Homage-specific token subclass, it uses `PooledSurface` as-is.)

3. **A permanent art token should not custody money or run third-party
   code.** Value custody, refunds, and price curves are sale-time concerns
   with a finite life. The token is the permanent artifact and should outlive
   any sale mechanic. Welding mutable economics onto it enlarges the
   permanent object's audit surface for no lasting benefit. And with the hook
   slot deleted and `_mint` (not `_safeMint`) in `_mintOne`, the thin token's
   mint path executes **no external code at all**: a pure internal state
   transition, which is a real security simplification, not just a size one.

The wider field agrees: modern platform design (Zora 1155 sale strategies,
Manifold extensions, Thirdweb) is thin token plus swappable sale modules. The
`mint()`-baked-in token is the older PFP pattern.

## 2. Decision

Adopt **thin token + modular minters**, with **one canonical, audited
fixed-price/referral minter** shipped as the default and wired automatically
by the factory. Custom minters (`HomageMinter`, auction houses, backed pools)
are the deliberate opt-in for bespoke economics.

The canonical minter is what makes this best-practice rather than a foot-gun:
naive thin-token ("every artist brings their own minter") produces N unaudited
value-handling contracts. A single audited default covers the common case
while custom minters stay the exception.

The product wires **exactly one minter per collection** (7.3): the factory
clones and grants one canonical minter (or the project's custom one), the
studio shows one, the docs describe one. The token's minter set stays a set
(unchanged code), but multiple grants are a manual, advanced action, not a
product surface.

This makes the platform token match how Homage already uses it. A project's
identity is "the platform token plus the minter that drives it", which is
exactly Homage today (stock `PooledSurface` + `HomageMinter`). The change is
that the token stops shipping the paid-mint, price, and hook code the
extension path never calls, so the permanent object is smaller and the one
mint surface is the minter for every project.

## 3. Target architecture

### 3.1 Responsibility split

| Concern | Model A (today) | Target (thin token) |
| --- | --- | --- |
| ERC721 ownership, transfer, burn | token | token |
| Renderer / tokenURI | token | token |
| Catalog attribution | token | token |
| EIP-2981 royalty | token | token |
| Supply cap | token | **token** (structural invariant of the artifact) |
| Lifecycle locks (renderer, supply, minter) | token | token |
| Admin / minter authorization | token | token |
| Derived lifecycle status (Scheduled/Open/Closed) | token | **deleted** (7.6; cap state stays readable) |
| Price (fixed or strategy) | token | **minter** |
| Mint window (start/end) | token | **minter** |
| Payment, overpayment refund | token | **minter** |
| Referral split | token | **minter** (canonical minter implements it) |
| Artist payout address | token `payoutAddress` | **minter** config (0 = live `owner()` of the collection) |
| Gating (allowlist, per-wallet cap, holds) | token `mintHook` | **minter** |
| Value custody (ETH held anywhere) | token `_pending` | **minter** |

The token keeps only what is a property of the permanent collection.
Everything tied to a *sale* moves to the minter.

### 3.2 The token after the change

`SurfaceCore` loses value custody, the paid-mint entrypoints, the price
fields, the mint-window fields, the payout address, the derived lifecycle
status, and the `mintHook` slot. It retains:

- ERC721 (OZ upgradeable base, cloned via EIP-1167 as today)
- admin/minter authorization (owner-scoped grants, `#150` semantics unchanged)
- supply cap accounting (sequential `mintedEver`-bounded; pooled live-supply),
  `setSupplyCap` + `lockSupply`
- lifecycle locks: `lockRenderer`, `lockSupply`, `lockMinter`. `lockMinter`
  exists on **both** forms today and stays on both: pooled keeps the `#150`
  M-01 single-minter safety story unchanged; on sequential it freezes the set
  of sale mechanics, which matters more once the minter *is* the sale.
- renderer wiring, `notifyMetadataUpdate`, Catalog attribution
- `tokenSeed` (formula unchanged, `docs/injection-convention.md`)
- EIP-2981 royalty (a token concern: `royaltyReceiver` is the marketplace
  payment address and stays)
- `burn`, gated as today (sequential: owner/approved; pooled: minter)
- `rescueStrayETH` (forced ETH via `selfdestruct` remains possible; with
  `_totalPending` gone the whole balance is sweepable, which simplifies it)
- the mint entrypoints, minter-gated and non-payable (7.7):
  - sequential, batch-native:
    `mintTo(address to, uint256 quantity) external returns (uint256 firstTokenId)`
    (one call, one event, ids `firstTokenId .. firstTokenId + quantity - 1`)
  - pooled, single-id: `mintToId(address to, uint256 tokenId) external`
    (pooled issuance is inherently per-id; batching loops in the minter)
- the per-mint event (7.7):
  `Minted(address indexed minter, address indexed to, uint256 firstTokenId,
  uint256 quantity, uint256 firstMintIndex)`. The calling minter is added
  (which minter issued a token is a property of the artifact's history, and
  gives the indexer cross-minter attribution without trace lookups);
  `referrer` and `statusAtMint` are dropped (referral is the canonical
  minter's event, status no longer exists on the token).

No `mint`/`mintWithReferral`/`mintFor`, no `_pending`/`_settle`/`withdraw`/
`pendingWithdrawal`, no `price`/`priceStrategy`/`currentPrice`, no
`mintStart`/`mintEnd`/`setMintWindow`, no `SurfaceStatus`, no
`payoutAddress`/`setPayoutAddress`, no `IMintHook`, no `REFERRAL_SHARE_BPS`
(the constant re-homes in the canonical minter). `SurfaceConfig` shrinks to
`supplyCap`, `royaltyBps`, `royaltyReceiver`, `renderer`, `rendererLocked`,
`supplyLocked`. The token has **no payable function** and never receives ETH.

With hooks gone the mint path makes no external calls, so the `nonReentrant`
guards on `mintTo`/`mintToId`/`burn` are reviewed in Phase 1 (likely
droppable; keep only if the audit prefers belt-and-suspenders).

Renderer consequence (7.6): `MetadataJson`'s "Final mint of the collection"
trait derives from cap state alone (`cap != 0 && minted == cap && tokenId ==
cap`). Today a reopened window can retract the trait; that disappears. The
raise-the-cap-until-locked retraction is unchanged from today.

### 3.3 The minter interface

A minter is a **per-collection EIP-1167 clone** (7.4), bound to its
collection at `initialize()` (a storage variable with no setter; clones
cannot carry per-clone immutables). Its config authority is **borrowed from
the collection**: `ISurfaceAuth.owner()`/`isAdmin`, the same pattern
`HookBase` uses today. No separate `Ownable` on the minter, so one keyring
governs both contracts and `#150`'s transfer-invalidates-grants semantics
apply to minter config for free.

The token trusts a minter only for "may call `mintTo`/`mintToId`"; it does
not prescribe minter internals. The canonical minter's value-facing shape,
which sibling stock minters share so frontends see one mint ABI:

```
mint(address to, uint256 quantity, address referrer, bytes data) payable
priceOf(address to, uint256 quantity, bytes data) view returns (uint256)
```

- `to` is the recipient **and** the address gates evaluate (an allowlist
  gates the collector, not the payer), carrying today's `mintFor` gift /
  vault-purchase capability. Refunds accrue to the payer (`msg.sender`) by
  pull payment, exactly the current rule.
- `data` carries genuinely caller-supplied input (a Merkle proof, a
  signature), consumed inside the minter. Gates that read only chain state
  (per-wallet cap, holds-a-token) need no `data`.
- Referral lives here: `REFERRAL_SHARE_BPS`, the split, and the
  `ReferralPaid`/`Withdrawn` events move into the canonical minter.
- The canonical minter's event ABI is identical across all its clones, so the
  indexer binds **one** handler for every canonical-minter sale. Custom
  minters document their own events, as Homage already does
  (`apps/indexer/src/Homage.ts`).

### 3.4 The canonical minter

`FixedPriceMinter` (working name), cloned per collection by the factory:

- stores sale config: `price`, `mintStart`, `mintEnd`, `payoutRecipient` (a
  concrete stored address, enforced nonzero at `initialize` and
  `setPayoutRecipient`; the factory defaults an unset value to the
  deploy-time `owner` argument, a snapshot, never a live `owner()` read), and
  optional `maxMints` (the minter's own sale ceiling; also the allocation
  tool if a second minter is ever granted manually, see 7.3)
- `mint(...)` payable: checks window, computes required (fixed, or an
  optional `IPriceStrategy` for TBAM-shaped pricing), enforces exact-on-fixed
  / accept-over-on-strategy with overpayment refunded via pull payment; the
  strategy price is read once and reused for the settle (the audited
  read-once safety, ported unchanged)
- pays the permissionless referral split exactly as the current `_settle`,
  then the artist payout
- optional built-in gates, AND-composed (7.1): Merkle **allowlist** (the
  `AllowlistHook` logic and leaf format) and **per-wallet cap** (the
  `PerWalletCapHook` counter, counted after success as today).
  `HoldsSurfaceHook`-style checks ship as a sibling minter or composed gate.
- calls `collection.mintTo(to, quantity)` / `mintToId(to, id)` (non-payable,
  minter-gated) to actually mint
- **every mint through it is paid** (7.8): there is no free-mint config.
  `price = 0` is legal but is a deliberate, visible sale setting, not an
  owner side-door. Owner airdrops go around the minter, not through it.

Value conservation (no caller withdraws more than deposited, no funds
stranded) becomes a minter invariant, tested with the same rigor the audit
applied to `SurfaceCore._settle`.

### 3.5 Factory: preserve the one-transaction ergonomic

The strongest argument *against* thin-token is per-collection wiring overhead
(two deploys, a grant, an approval). The factory neutralizes it for the
common case. `createSurface(...)` clones the thin token, clones a
`FixedPriceMinter`, grants it minter rights, optionally `lockMinter`s
(pooled), and returns both, all in one transaction. An artist doing a plain
priced drop still calls one factory function and gets a working, selling
collection. Custom-minter projects pass their own minter (or grant it
post-deploy) instead of the canonical clone.

**Discovery:** `SurfaceCreated` gains the minter address:
`SurfaceCreated(address indexed owner, address indexed collection, address
minter, IdMode idMode)`, with `minter = address(0)` when the caller skipped
the canonical clone. This event is the collection-to-minter binding the
indexer reads; no heuristics.

Pause/deprecate gating and the `#148` address-validation checks carry over to
both the token-impl and minter-impl wiring.

## 4. What moves, concretely

| Current location | Moves to |
| --- | --- |
| `SurfaceCore._settle`, `_pending`, refund | `FixedPriceMinter` |
| `Surface.mint/mintWithReferral/mintFor` | `FixedPriceMinter.mint` |
| `_cfg.price`, `_cfg.priceStrategy`, `currentPrice` | `FixedPriceMinter` config |
| `_cfg.mintStart`, `_cfg.mintEnd`, `setMintWindow` | `FixedPriceMinter` config |
| `_cfg.payoutAddress`, `setPayoutAddress` | `FixedPriceMinter` config |
| `REFERRAL_SHARE_BPS`, `ReferralPaid`, `Withdrawn` | `FixedPriceMinter` |
| `SurfaceStatus`, `statusAtMint`, `config()`'s status | **deleted** (7.6) |
| `Minted.referrer` | the canonical minter's sale event |
| `_cfg.mintHook` + `_runBeforeHook`/`_runAfterHook` | `FixedPriceMinter` gates |
| `AllowlistHook` Merkle verify | `FixedPriceMinter` (or `AllowlistMinter`) |
| `PerWalletCapHook` counter | `FixedPriceMinter` per-wallet accounting |
| `HoldsSurfaceHook` | sibling minter or composed gate |
| `GateHook` (bundling, only needed because of one hook slot) | **deleted**; multi-gate is native to a minter |

`mintTo`/`mintToId` stay on the token and become the *only* mint path (with
the 7.7 signatures). The cap, lifecycle locks, renderer, royalty, and Catalog
stay put.

## 5. Phasing

Implementation starts from a fresh branch off updated `main` (repo
squash-merges; do not build on this design branch). Each phase is a
reviewable PR with tests as a first-class deliverable, not a trailing phase.

- **Phase 0 (decisions).** Done: section 7 locked 2026-07-19.
- **Phase 1 (thin token).** Strip value custody, paid-mint, price/window/
  payout fields, `SurfaceStatus`, and hooks from
  `SurfaceCore`/`Surface`/`PooledSurface`. Implement the 7.7 entrypoints and
  `Minted` shape; shrink `SurfaceConfig`. Keep cap, locks, renderer, royalty,
  Catalog, seed, burn, `rescueStrayETH`. Review the now-unneeded
  `nonReentrant` guards. Port the token tests; the value-custody tests move
  to Phase 2. Delete `IMintHook`, the hook contracts, `GateHook`. Update
  `MetadataJson`'s final-mint derivation to cap-only.
- **Phase 2 (canonical minter).** Build `FixedPriceMinter`: borrowed auth,
  price/strategy, window, payout, `maxMints`, payment/refund, referral,
  optional Merkle allowlist + per-wallet cap. Port
  `AllowlistHook`/`PerWalletCapHook` logic. Value-conservation invariant
  suite covering both price branches. Optional `HoldsSurfaceMinter` sibling.
- **Phase 3 (factory).** Rework `SurfaceFactory` to clone token + canonical
  minter and wire them in one transaction; emit the minter in
  `SurfaceCreated`; carry pause/deprecate and `#148` validation to both
  impls. Add the bring-your-own-minter path.
- **Phase 4 (revalidate Homage).** Homage already drives a stock
  `PooledSurface` through the extension path, so there is no token to
  collapse. The work: (a) the **one callsite edit** in `HomageMinter`, whose
  `mintToId(to, punkId, address(0), "")` call drops the referrer/hookData
  args under the 7.7 signature (Homage is not deployed, so this is a source
  edit, not a migration); (b) re-vendor the thinned Surface into
  `ripe0x/permanence`'s `contracts/src/vendor/surface/`. Note the vendored
  copy is **already functionally stale** against pin independent of this
  rearchitecture: it still blocks `renounceOwnership` (pin enabled it,
  `3e43c99`) and still requires a nonzero factory `defaultRenderer` (pin made
  it optional), so the re-vendor is due regardless. Run Homage's suite
  against the thinned vendored copy.
- **Phase 5 (web + indexer).** Web: repoint mint call sites from the token to
  the minter ABI (grep `mintWithReferral` and the token-mint calls);
  `WithdrawPanel` reads the minter's pull balances; refresh the hand-synced
  ABI snapshots (`apps/web/public/abis/`, `apps/indexer/abis/`). Indexer:
  handle the new `Minted` shape (minter added; referrer/statusAtMint gone);
  add the canonical-minter sale handler, bound per collection via
  `SurfaceCreated`'s minter field; and fix the pre-existing drift where
  `apps/indexer/src/Collections.ts` destructures a `mintBlock` field the
  current event no longer carries.
- **Phase 6 (audit + deploy).** Reset the audit baseline over the thin token
  + canonical minter + factory, re-audit, then deploy per the existing
  runbook.

## 6. Downsides and mitigations (honest)

1. **Complexity is relocated, not deleted.** Token + canonical minter has
   comparable total moving parts to the fat token, plus an inter-contract
   call. *Accepted:* the win is a money-free, external-code-free permanent
   token and one unified stack, not fewer lines.
2. **N-minter risk.** Custom minters are unaudited value handlers.
   *Mitigated:* the canonical audited minter is the default; custom minters
   are the deliberate exception PND already writes carefully (HomageMinter).
3. **The token can no longer enforce economic invariants** (that price was
   paid, referral taken) because it no longer sees value. *Accepted:* those
   become minter invariants; the token still structurally enforces the supply
   cap.
4. **Platform economic primitives become escapable** (a custom minter can
   skip the referral share). *Accepted:* referral is already
   permissionless-by-design with self-referral an accepted tradeoff; PND does
   not force it structurally.
5. **A composition axis is deleted.** Token-level hooks were the one
   mechanism that applied policy across *all* mint paths (contracts-plan
   Phase 0 decision #3). Under this design, cross-minter policy has no home:
   per-wallet counting is per-minter, and an artist cannot attach a gate to a
   minter they did not write; the only cross-minter invariant is the token's
   supply cap. *Accepted:* the product wires one minter per collection (7.3),
   so the axis has no v1 user, and bespoke minters carry their own gates.
6. **Per-mint external call + two deploys.** *Mitigated:* the factory does
   the two-contract wiring in one transaction; batch-native `mintTo` (7.7)
   keeps a quantity-N sale at one token call and one event, so the extra hop
   is once per sale call, not once per token.
7. **ABI uniformity risk.** *Mitigated:* the standardized minter shape plus
   the canonical minter keep "how do I mint this?" a single answer for every
   canonical-minter collection. Custom-minter projects (Homage) have custom
   frontends by nature; the uniformity claim is scoped to the canonical path.

## 7. Phase 0 decisions (locked 2026-07-19)

> Format: decision, rationale, consequence. Each is one-way once deployed.

### 7.1 Gate composition

**Decision:** the canonical `FixedPriceMinter` carries the two common gates,
**Merkle allowlist** and **per-wallet cap**, as optional config, AND-composed
in the one contract. Rarer gates (`holds-a-token`, signature) ship as sibling
minters. There is no token-level gate.

**Rationale:** gate composition has two distinct axes and they need different
mechanisms. **AND** ("allowlisted *and* under the per-wallet cap") only works
if both checks run in the *same* mint call, i.e. the same contract. This is
exactly why `GateHook` had to exist under model A (one hook slot forced
bundling). **OR** ("a public sale *or* a separate allowlist presale") is
config-phasing within the canonical minter (set the root, later clear it),
not a second minter (see 7.3). Carried semantics: the OZ standard-merkle-tree
leaf format, count-after-success for the wallet cap, and gates evaluate the
**recipient** (`to`), not the payer.

**Consequence:** `GateHook` is deleted (its reason to exist was the single
hook slot). `AllowlistHook` + `PerWalletCapHook` logic is absorbed into the
canonical minter. `HoldsSurfaceHook` becomes `HoldsSurfaceMinter` (or a
composed gate). Per-wallet counting is per-minter arithmetic; a cross-minter
wallet cap does not exist (accepted, section 6 item 5).

### 7.2 IPriceStrategy retention

**Decision:** keep the external `IPriceStrategy` inside the canonical minter.
Fixed `price` when the strategy slot is unset; a set strategy overrides it,
read once and reused for the settle (the current read-once safety).

**Rationale:** it is one optional slot and a single view call, and it
preserves TBAM-shaped / time-based pricing the platform may want without a
separate minter lineage. The read-once-reuse pattern that protects value
conservation is already audited; it ports unchanged into the minter.
Fragmenting dynamic pricing into separate minters buys nothing here.

**Consequence:** `IPriceStrategy` survives as a minter-level interface. The
value-conservation invariant suite covers both the fixed and strategy
branches inside the minter.

### 7.3 Minter topology: the token permits a set; the product wires one

**Decision:** the token's minter authorization stays exactly as it is
(sequential permits N grants; pooled enforces one, `#150` M-01, owner-only
`setMinter`/`lockMinter`). The **product wires exactly one minter per
collection**: the factory clones and grants one canonical minter (or the
project's custom one). Multiple concurrent grants on sequential remain
possible as a manual, advanced action; no product surface is built for them
in v1 (no minter-enumeration UI, no per-minter allocation machinery).

**Rationale:** once 7.1 absorbs allowlist + cap into the canonical minter as
config, presale-then-public is one minter with config changes, not two
minters, and the honest concurrent-minter cases that remain are exactly PND's
bespoke workload: a companion contract that mints as a mechanic
(burn-to-mint, reward mints) and the temporary self-grant airdrop (7.8). Both
are *grants*, not product features. Enforcing single-minter on sequential
would add code to close a door with no threat behind it: the pooled
restriction exists for a concrete hazard (minter-wide burn stranding backed
escrow) that sequential does not have.

**Consequence:** zero token-code change either way (the `_minters` mapping
and pooled-only `TooManyMinters` already exist). The token guarantees only
the **global supply cap** across minters; any per-minter allocation is that
minter's own config (the canonical minter's optional `maxMints`). Frontends
and the indexer bind the wired minter from `SurfaceCreated` (3.5) and derive
any additional grants from `MinterSet` events if ever needed.

### 7.4 Minter immutability

**Decision:** immutable **EIP-1167 clones per collection**, matching the
immutable token clones. No shared singleton minter. The clone's collection
binding is set at `initialize()` (storage, no setter; clones cannot carry
per-clone immutables). Minter config authority is **borrowed from the
collection** (`ISurfaceAuth.owner()`/`isAdmin`, the `HookBase` pattern); the
minter has no `Ownable` of its own.

**Rationale:** value isolation. A per-collection clone holds only that
collection's transient balance (unclaimed refunds and payouts under the pull
payment), so a bug or drain is scoped to one collection, not the whole
platform. A shared singleton keyed by collection pools every collection's ETH
in one contract: a larger honeypot and a per-collection-keyed accounting
surface that is easier to get wrong. Borrowed auth means one keyring governs
token and minter, and `#150`'s owner-scoped-grant semantics (an ownership
transfer invalidates delegated admins) cover minter config for free instead
of drifting in a second admin system. The factory already deploys a clone per
collection in its one-transaction wiring (3.5).

**Consequence:** each collection has its own minter address, discoverable
from `SurfaceCreated`. Minter evolution is by factory-offered new
implementations, never by mutating a deployed minter. Swapping minters (grant
new, revoke old) strands nothing: pull balances on the old clone remain
claimable forever; this is a documented invariant, not an accident.

### 7.5 Homage impact

**Decision:** no token-collapse work. Homage already uses a **stock
`PooledSurface`** (no Homage-specific subclass exists) and drives it purely
through the extension path. Phase 4 is: the one `HomageMinter` callsite edit
for the 7.7 `mintToId` signature, a re-vendor of the thinned Surface into
`ripe0x/permanence`, and a full run of Homage's suite against it.

**Rationale:** Homage is already the model-B shape this design generalizes.
Its minter holds all economics; the token is a mint/burn/render target it
authorizes, touched through exactly `mintToId`, `burn`, `renderer()`, and
`ownerOf`, all of which the thin token retains. Homage is not deployed, so
the signature change is a source edit, not a migration. The vendored copy in
`permanence/contracts/src/vendor/surface/` must track the thinned pin source;
it is already functionally stale today (`renounceOwnership` blocking, factory
`defaultRenderer` requirement), so the re-vendor is due regardless.

**Consequence:** Phase 4 spans both repos but stays a verification, one-line
edit, and re-vendor pass. The risk is vendored-copy drift, caught by running
Homage's suite against the thinned token.

### 7.6 Lifecycle status removed from the token

**Decision:** `SurfaceStatus` (Scheduled/Open/Closed), the `statusAtMint`
event field, the mint-window fields, and `setMintWindow` are removed from the
token entirely. `config()` returns config and minted count only. Minters own
and report their own schedules.

**Rationale:** the status was derived from the window plus the cap; with the
window on the minter, token-side `Scheduled` and window-`Closed` are
underivable, and a token-side status that ignored the actual sale schedule
would be misleading. Cap state (the only permanent-artifact input) stays
directly readable.

**Consequence:** `MetadataJson`'s "Final mint of the collection" trait
derives from cap state alone; a reopened window can no longer retract it
(an improvement in determinism). The indexer drops `statusAtMint`. Anything
wanting sale-phase display reads the minter.

### 7.7 Token mint ABI and Minted event

**Decision:**

- sequential:
  `mintTo(address to, uint256 quantity) external returns (uint256 firstTokenId)`
- pooled: `mintToId(address to, uint256 tokenId) external`
- event: `Minted(address indexed minter, address indexed to,
  uint256 firstTokenId, uint256 quantity, uint256 firstMintIndex)`

`referrer` and `hookData` are dropped from the entrypoints; `referrer` and
`statusAtMint` are dropped from the event; the calling `minter` is added to
the event.

**Rationale:** `hookData` has no consumer once `IMintHook` is deleted, and a
"just in case" bytes param on a contract that is immutable forever is exactly
the dead weight this design removes. Referral is sale economics, not a
property of the artifact: with per-collection canonical clones plus the
factory binding (3.5), the indexer gets uniform referral data from the
canonical minter's own event ABI, and custom minters need custom handlers
regardless (Homage's already exists, and it passes `referrer = 0`). What *is*
a property of the artifact's history is which minter issued the token;
putting `minter` in the event gives cross-minter attribution without trace
lookups. Batch-native sequential `mintTo` keeps a quantity-N sale at one
external call and one event, avoiding the per-token call/event regression a
single-mint entrypoint would reintroduce. Pooled stays single-id because
issuance is inherently per-id (Homage's per-token swap dominates its loop
anyway).

**Consequence:** the `Minted` event shape changes for the indexer (Phase 5).
`HomageMinter` needs the one callsite edit (7.5). The token's interfaces
(`ISurface`, `IPooledSurface`, `ISurfaceCore`) shrink accordingly and the
vendored copies follow at re-vendor.

### 7.8 Free mints and owner airdrops

**Decision:** the canonical minter has **no free-mint or owner-mint path**;
every mint through it is paid at the configured price (`price = 0` is legal
config but a deliberate, visible sale setting). Owner airdrops and artist
proofs go around the minter: the owner grants a minter (their own EOA, or a
one-off airdrop contract), calls `mintTo` directly, and revokes.

**Rationale:** an owner-mint prohibition cannot actually be enforced (the
owner controls the minter set and `setMinter` accepts EOAs), so a prohibition
would be theater and a special free path would be redundant. Keeping the
canonical minter all-paid keeps its value-conservation invariant clean, and
the `Minted` event's `minter` field makes self-mints legible onchain instead
of laundered through a price-0 sale.

**Consequence:** the supply cap still binds every path. The self-grant
airdrop pattern is documented as the supported route; the studio does not
grow a free-mint feature.

### 7.9 Minter discovery (`primaryMinter`)

**Decision:** each collection stores `primaryMinter`, a frontend-discovery
pointer at one of its granted minters, with no new value-facing surface on
the token. A generic client that only has a collection address reads
`collection.primaryMinter()`, then reads/calls that minter's own ABI
directly (the canonical `FixedPriceMinter`'s `mint(uint256)` ergonomic
overload for the common paid-mint case, or the full
`mint(address,uint256,address,bytes)` for a recipient/referrer/gate-data
mint). `primaryMinter` is the frontend default, not an authority record:
every address in `isMinter` is equally callable, and a client that already
knows which minter it wants should call that minter directly rather than
resolve through `primaryMinter`.

**Lifecycle, by form:**
- **Sequential:** owner/admin-set via `setPrimaryMinter(minter)` (must be a
  currently granted minter, or the zero address to clear it); automatically
  cleared to zero if the pointed-to minter is later revoked via `setMinter`.
  `createSurface` sets it to the canonical `FixedPriceMinter` clone it wires;
  `createSurfaceCustom` takes a caller-supplied `primaryMinter` (validated
  against `initialMinters`). Stable once `lockMinter()` freezes the minter
  set: `setPrimaryMinter` reverts `MinterIsLocked` after that point, matching
  the rest of the frozen minter surface.
- **Pooled:** no separate setter. The pointer tracks the pool's sole minter
  automatically: granting a minter via `setMinter` sets it as primary,
  revoking the current primary clears it, and replacing the minter (revoke
  old, grant new) moves the pointer to the new one. `createPooledSurface`
  can pass a caller-supplied `primaryMinter`, which the core validates is
  both a granted minter and the pool's sole one. `setPrimaryMinter` on a
  pooled collection reverts `OnlySequential`.

**Rationale:** the audit-driven reduction (2026-07) stripped every mint path
off the token; the only way a generic client resolves "how do I mint this"
today is an indexer heuristic over `MinterSet`/`Minted` history, which is
fragile for a collection an indexer has not seen yet. `primaryMinter` gives
a direct onchain answer with no new custody, payability, or authority: it is
a pointer, validated against the existing `_minters` set at every write, not
a second grant mechanism.

**Consequence:** `SurfaceFactory.SurfaceCreated`'s `primaryMinter` field (renamed
from `minter`, a name-only change: the event topic and the field's position
in the log's non-indexed data are unchanged, so positional ABI decoding is
unaffected) now carries the chosen primary on every creation path, not just
the canonical one, so an indexer backfills the pointer without a special case
for `createSurfaceCustom`/`createPooledSurface`.

## 8. Non-goals

- No change to the renderer, Catalog, or lifecycle-lock designs.
- No change to the pooled single-minter safety model (`#150` M-01), which
  fits the thin token unchanged.
- No change to the owner-scoped admin-grant semantics (`#150`).
- No change to the seed formula or `docs/injection-convention.md`.
- Not a mass-launchpad pivot: this optimizes for PND's bespoke workload.

## 9. Relationship to prior decisions

- **Supersedes `docs/pnd-surface-contracts-plan.md` Phase 0 decision #2**
  (FixedPrice as a stored field on the collection): the price moves to the
  canonical minter, with `IPriceStrategy` retained there (7.2).
- **Supersedes contracts-plan Phase 0 decision #3** ("hooks run on all mint
  paths", also stated as a principle in `docs/pnd-surface-system.md` 3.3):
  the token-level hook axis is deleted, and with it the ability to apply one
  policy across every mint path. Accepted explicitly in section 6 item 5.
- **Consistent with the "no SeaDrop-style singleton mint engine" decision**
  (`docs/pnd-surface-system.md` 8.5, decided 2026-07-13). The rejected shape,
  one shared contract holding every collection's mint state and money with a
  structural fee position, stays rejected. The canonical minter is a
  per-collection clone with no fee position and no shared custody; primary-
  sale money now passes through a steward-authored but artist-authorized,
  clone-isolated contract instead of the token itself. The 8.5 principle
  "the artist authorizes mint engines, not the platform" is exactly the
  mechanism this design standardizes on.
- `docs/pnd-surface-system.md` sections 3.1/3.3 and `docs/surface-glossary.md`
  describe model A (built-in paid path, hook slot, derived status) and are
  revised when the implementation lands, per the header note.
