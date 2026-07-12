---
title: Types
description: The shared enums and structs in CollectionTypes.sol, the data-only surface with no ABI functions of its own.
---

# Types

`CollectionTypes.sol` defines the enums and structs shared across the
Collection System: the collection core and the renderer and price-strategy
interfaces. These types have no functions or events of their own, only
fields, so they don't appear as generated contract pages; this page is
their reference.

## Enums

### `CollectionStatus`

Lifecycle status, derived purely from the mint window, the supply cap, and
the current block — never from stored state. `config()` reports it live and
each `Minted` event stamps the value at mint time.

| Value | Meaning |
| --- | --- |
| `Scheduled` | Before `mintStart`: the public window has not opened yet |
| `Open` | Within the mint window and under cap |
| `Closed` | The mint window ended, or a sequential cap is full |

### `IdMode`

Token id assignment model, fixed at `initialize` and never changed after.

| Value | Meaning |
| --- | --- |
| `Sequential` | The core assigns `nextId++`; extension minters may mint but never choose ids; ids are never reused after burn |
| `Pooled` | An authorized extension minter supplies every id (`tokenId == sourceId` forms); a burned id may be minted again as a new instance with a fresh Mint Mark and entropy |

See [Id modes](/docs/collections/concepts/id-modes) for the full behavioral detail.

Generative works define their own code/dependency shapes inside the artist's
renderer, not in a shared core type; see the [Injection convention](/docs/collections/reference/injection-convention)
for the render-context contract those renderers follow.

## Structs

### `CollectionConfig`

The live collection configuration. Set at `initialize` and — except
`idMode`, which is structural — updatable afterward through the setters
(`setMintWindow`, `setPrice`, `setRoyalty`, `setSupplyCap`,
`setPayoutAddress`, and the three slot setters), so the struct `config()`
returns is always the single current truth. There is no referral-share
field on this struct: the share is the fixed protocol constant
`REFERRAL_SHARE_BPS`, paid to whoever hosts the mint, not an artist-set
value.

| Field | Type | Meaning |
| --- | --- | --- |
| `price` | `uint256` | Wei; used when `priceStrategy` is unset. `0` means gas-only mints |
| `supplyCap` | `uint256` | `0` means open supply; lockable one-way via `lockSupply` |
| `mintStart` | `uint64` | Unix seconds; `0` means open immediately |
| `mintEnd` | `uint64` | Unix seconds; `0` means open-ended |
| `royaltyBps` | `uint16` | EIP-2981 royalty, capped at 5000 (50%) by the contract |
| `royaltyReceiver` | `address` | `0` defers to `owner()` |
| `payoutAddress` | `address` | Where the artist's share of proceeds accrues; `0` defers to `owner()` |
| `renderer` | `address` | `0` means the collection's `defaultRenderer` applies |
| `mintHook` | `address` | `0` means no hook runs |
| `priceStrategy` | `address` | `0` means the stored `price` applies |
| `idMode` | `IdMode` | Sequential or Pooled, fixed for the collection's lifetime |

### `InitParams`

Everything `initialize()` needs, bundled into one struct so the call stays
within legacy-codegen stack limits and can grow without signature churn.

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | ERC721 name |
| `symbol` | `string` | ERC721 symbol |
| `owner` | `address` | The collection's owner (the artist); required, cannot be zero |
| `cfg` | `CollectionConfig` | The collection configuration |
| `defaultRenderer` | `address` | The fallback renderer; required, cannot be zero |
| `initialMinters` | `address[]` | Extension minters granted at init, so pooled and backed forms deploy fully wired in one transaction |
| `catalog` | `address` | The Catalog singleton used for creator confirmation; `0` disables it |
| `creators` | `address[]` | Initial listed creators (the owner's side of attribution); each confirms via the Catalog |

See [Mint Marks and entropy](/docs/collections/concepts/mint-marks-and-entropy) for
per-token provenance: the seed is the only per-token storage (there is no
mint-record struct), and the Mint Mark is derived from the id, the live
config, and the `Minted` event.
