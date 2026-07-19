---
title: Types
description: The shared enums and structs in SurfaceTypes.sol, the data-only surface with no ABI functions of its own.
---

# Types

`SurfaceTypes.sol` defines the enums and structs shared across the Surface
System: the token core and the renderer and price-strategy interfaces. These
types have no functions or events of their own, only fields, so they do not
appear as generated contract pages; this page is their reference.

## Enums

### `IdMode`

Token id assignment model, fixed at `initialize` and never changed after. It
is not a config field; each form is a separate contract, and `idMode()`
reports which.

| Value | Meaning |
| --- | --- |
| `Sequential` | The core assigns ids 1, 2, 3... in mint order; a minter mints through `mintTo` but never chooses ids; ids are never reused after burn |
| `Pooled` | An authorized minter supplies every id (`tokenId == sourceId` forms) through `mintToId`; a burned id may be minted again as a new instance with a fresh seed |

See [Id modes](/docs/surface/concepts/id-modes) for the full behavioral
detail.

Generative works define their own code and dependency shapes inside the
artist's renderer, not in a shared core type; see the
[Injection convention](/docs/surface/reference/injection-convention) for
the render-context contract those renderers follow.

## Structs

### `SurfaceConfig`

The live token configuration. Set at `initialize` and, except the two locks
once set, updatable afterward through the setters (`setRenderer`,
`setRoyalty`, `setSupplyCap`), so the struct `config()` returns is always the
single current truth. There is no price, mint window, payout, or referral
field here: those are sale concerns and live in the minter, not the token.

| Field | Type | Meaning |
| --- | --- | --- |
| `supplyCap` | `uint256` | `0` means open supply; lockable one-way via `lockSupply` |
| `royaltyBps` | `uint16` | EIP-2981 royalty, capped at 5000 (50%) by the contract |
| `royaltyReceiver` | `address` | `0` defers to `owner()` |
| `renderer` | `address` | Provides `tokenURI`; `0` at init uses the factory `defaultRenderer` |
| `rendererLocked` | `bool` | One-way; `true` pins the renderer pointer (see `lockRenderer`) |
| `supplyLocked` | `bool` | One-way; `true` freezes the supply cap (see `lockSupply`) |

`config()` returns this struct plus the mints-ever count; it carries no
lifecycle status, because the token has no mint window to derive one from.

### `InitParams`

Everything `initialize()` needs, bundled into one struct so the call stays
within legacy-codegen stack limits and can grow without signature churn.

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | ERC721 name |
| `symbol` | `string` | ERC721 symbol |
| `owner` | `address` | The collection's owner (the artist); required, cannot be zero |
| `cfg` | `SurfaceConfig` | The token configuration |
| `defaultRenderer` | `address` | The fallback renderer used when `cfg.renderer` is zero |
| `initialMinters` | `address[]` | Minters granted at init, so a collection deploys fully wired in one transaction |
| `catalog` | `address` | The Catalog singleton used for creator confirmation; `0` disables it |
| `creators` | `address[]` | Initial listed creators (the owner's side of attribution); each confirms via the Catalog |

The factory fills `defaultRenderer` and `catalog` from its own immutables and
usually fills `initialMinters` with the canonical minter clone it wires;
`createSurface` does exactly that.

See [Seed and provenance](/docs/surface/concepts/mint-marks-and-entropy)
for per-token provenance: the seed is the only per-token storage, and mint
order and first/final standing are derived from the id, the live config, and
the `Minted` event.
