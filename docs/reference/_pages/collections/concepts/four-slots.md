---
title: Slots and modules
description: The renderer slot and the minter set on the token, plus the price-strategy slot inside the canonical minter.
---

# Slots and modules

`Surface` is one thin ERC721 core for every form of work: an edition, a
long-form generative drop, an onchain SVG piece, a participatory work, a
backed and pooled work. The core holds ownership, one seed per token, the
renderer wiring, the royalty, the supply cap, and the minter authorization,
and nothing about a sale. What changes between works is which modules attach
to it and what the minter does. The core never grows a line for a specific
work; it only ever calls its renderer and trusts its minters.

The token has two attachment points, and the canonical minter adds a third:

- the **renderer slot** on the token: one address, swappable by the owner or
  an admin (`setRenderer`) and pinnable one-way (`lockRenderer`)
- the **minter set** on the token: addresses the owner grants and revokes
  individually (`setMinter`), freezable one-way (`lockMinter`). A minter is
  the mint engine; every mint enters through one
- the **price-strategy slot** inside the canonical minter: one optional
  address on the [FixedPriceMinter](/docs/collections/contracts/fixed-price-minter)
  clone (`setPriceStrategy`), which quotes the price when set and falls back
  to the minter's fixed `price` when unset

Price, mint window, payment, referral, and gating are not token slots. They
live in the minter, because they are sale-time concerns and the token holds
no value.

## Renderer (`IRenderer`)

```solidity
function tokenURI(address collection, uint256 tokenId) external view returns (string memory);
function contractURI(address collection) external view returns (string memory);
```

- **Type**: `IRenderer`, stored in the collection's `SurfaceConfig.renderer`
- **Set by**: `setRenderer(address)`, owner or admin, only while the renderer
  is not locked (`lockRenderer` pins it permanently, optional and off by
  default)
- **Fallback**: the slot always holds a nonzero address. When the artist sets
  none at init, the collection uses the factory's `defaultRenderer`; a slot
  left at zero with no factory default reverts `RendererRequired` at creation
- **What it does**: `tokenURI` delegates entirely to
  `IRenderer(renderer()).tokenURI(address(this), tokenId)`. The collection
  address is passed explicitly rather than read from `msg.sender`, so one
  renderer instance can serve every collection that points at it, and it can
  be called offchain for any collection directly
- **What it can do**: full EVM read access. A renderer can read the token's
  seed, the current owner, sibling tokens, companion contract state, foreign
  contracts, and block state. It is a view function, so it cannot alter state
- **Reference implementations**: `DefaultRenderer` (the init-time fallback)
  and `ScriptyRenderer`, a bring-your-own generative template for
  algorithm-driven (Art Blocks-style) work: the artist deploys their own
  instance (immutable by construction) and points the slot at it, following
  the injection convention. A hand-written Solidity SVG work implements
  `IRenderer` directly, with the shared `MetadataJson` library handling the
  JSON envelope

See [IRenderer](/docs/collections/contracts/i-renderer),
[DefaultRenderer](/docs/collections/contracts/default-renderer),
[ScriptyRenderer](/docs/collections/contracts/scripty-renderer),
[Write a renderer](/docs/collections/guides/write-a-renderer).

## Minter (the mint engine)

- **Type**: an address the owner authorizes, tracked in
  `mapping(address => bool)`. The token trusts a minter for one thing:
  permission to call its non-payable mint entrypoint. The value-facing shape
  a minter presents to frontends is [IMinter](/docs/collections/guides/write-a-minter),
  but the token does not enforce it
- **Set by**: `setMinter(address minter, bool allowed)`, owner or admin (owner
  only on the pooled form). Not a single-slot swap like the renderer: any
  number of minters can be authorized at once, granted and revoked
  individually. Revoking a grant is the artist's lever over that minter's
  schedule and behavior once it is live. `lockMinter` freezes the set
  permanently, one-way
- **What it does**: an authorized minter calls `mintTo(to, quantity)` (the
  sequential form) or `mintToId(to, tokenId)` (the pooled form) on the
  collection. Both are non-payable: the minter carries all economics itself,
  and the token just assigns the id and stamps the seed
- **What it can and cannot do**: a minter fully owns its own economics (its
  own price, payment token, window, referral, gates, escrow) and its own
  schedule. It cannot bypass the id-mode rule (each form exposes only its own
  entrypoint) or the supply cap (`ExceedsCap`). The
  [FixedPriceMinter](/docs/collections/contracts/fixed-price-minter) clone the
  factory wires is the canonical mint engine; bespoke projects grant their own

See [Surface](/docs/collections/contracts/surface),
[FixedPriceMinter](/docs/collections/contracts/fixed-price-minter),
[Write a minter](/docs/collections/guides/write-a-minter).

## Price strategy (`IPriceStrategy`)

```solidity
function priceOf(address collection, address minter, uint256 quantity, bytes calldata data)
    external view returns (uint256);
```

- **Type**: `IPriceStrategy`, stored on the canonical minter as
  `priceStrategy`, not on the token
- **Set by**: `setPriceStrategy(address)` on the minter, owner or admin (the
  collection's, borrowed by the minter), no freeze gate
- **Fallback**: when unset, the minter charges its stored `price` times
  `quantity` and requires an exact match (`WrongPayment` on mismatch)
- **What it does**: when set, `mint` and the read-only `priceOf` call
  `priceOf(collection, to, quantity, data)` to get the required payment.
  Because a strategy's quote can move between when a collector reads it and
  when their transaction lands (for example a basefee-driven price), the
  minter accepts `msg.value >= required` and accrues any excess back to the
  payer as a pull withdrawal, rather than reverting on overpayment
- **What it can and cannot do**: a `view` function only, so it can read
  anything (basefee, companion state, the collection itself) but cannot move
  funds. The quote is read once and reused for the settle, so a misbehaving
  strategy cannot split value the minter never received

See [IPriceStrategy](/docs/collections/contracts/i-price-strategy),
[Write a price strategy](/docs/collections/guides/write-a-price-strategy).
