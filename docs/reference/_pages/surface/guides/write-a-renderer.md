---
title: Write a renderer
description: Implement IRenderer for your collection, what the renderer owns (image, cover, traits), reading the seed, and how the renderer pointer is changed and made permanent.
---

# Write a renderer

A renderer builds a collection's `tokenURI` and `contractURI`. The collection
holds one pointer, `renderer()`, and delegates both calls to whatever contract
it names. On [Surface v2](/docs/surface/contracts/surface-v2) that contract is
always the artist's own: v2 has no default renderer and no no-code tier, and
`initialize` reverts `RendererRequired` on a zero address and
`RendererNotContract` on an address without code. PND ships no renderer
module for either version; on [Surface](/docs/surface/contracts/surface) (v1)
the mainnet factory's `defaultRenderer` is the zero address, so a v1
collection names its own renderer at deploy too.

```solidity
interface IRenderer {
    function tokenURI(address collection, uint256 tokenId) external view returns (string memory);
    function contractURI(address collection) external view returns (string memory);
}
```

Both versions call the same [IRenderer](/docs/surface/contracts/i-renderer).
The collection address is an explicit parameter, not `msg.sender`: one
deployed renderer instance can serve every collection built against the same
algorithm, offchain callers can `eth_call` a renderer directly for any
collection without transacting, and any contract can adopt the interface by
exposing the reads its chosen renderer makes.

## What the renderer owns

The token stores no presentation data. Everything a marketplace displays comes
from the renderer:

- **Token metadata** (`tokenURI`): the JSON `name`, `description`, `image`,
  `animation_url`, and `attributes`. `image` is the renderer's job: a static
  URI it stores or derives, an onchain SVG, or a captured still of an HTML
  work. A generative HTML work usually puts the live document in
  `animation_url` and a still in `image`.
- **Collection metadata** (`contractURI`): the collection's cover image,
  description, and links, which is what marketplace collection pages show.
- **Traits**: any `attributes`, including provenance traits such as mint
  order. The token derives none of them for you.

When the output changes (a reveal, a new still), the renderer or the
collection owner calls `notifyMetadataUpdate(fromTokenId, toTokenId)` on the
collection, which emits the ERC-4906 `BatchMetadataUpdate` marketplaces
listen for.

## Reading collection state

A renderer is an onchain view with full EVM read access: the seed, the current
owner, sibling tokens, companion state, other contracts, and block state. Its
output can therefore depend on live chain state, not only on the seed.

The reads both versions share:

```solidity
function name() external view returns (string memory);
function symbol() external view returns (string memory);
function owner() external view returns (address);
function totalSupply() external view returns (uint256);
function tokenSeed(uint256 tokenId) external view returns (bytes32);
function version() external view returns (uint256); // 1 or 2
```

`config()` differs. On v2 it returns
`(renderer, minter, supplyCap, royaltyBps, royaltyReceiver, minted)`, and v2
has no `idMode`. On v1 it returns the `SurfaceConfig` struct plus `minted`,
and `idMode()` reports sequential or pooled; that is the shape
[ISurfaceView](/docs/surface/contracts/i-surface-view) describes. A renderer
meant to serve both reads `version()` first, or sticks to the shared reads.
On v2, and on a sequential v1 collection, the token id is the mint order, so
first is id 1 and final is `minted == supplyCap` once a cap is set.

### The seed

`tokenSeed(tokenId)` is the one value written at mint that cannot be recreated
later. The collection computes it once, in the mint transaction:

```solidity
// Surface v2
seed = keccak256(abi.encode(block.prevrandao, collection, tokenId))
// Surface v1 (mintIndex re-rolls a pooled re-mint of the same id)
seed = keccak256(abi.encode(block.prevrandao, collection, tokenId, mintIndex))
```

Read the stored value; never re-derive it. Changing renderers never changes a
token's seed. A work that wants different entropy derives it from the seed (any
pure function of it). See
[Seed and provenance](/docs/surface/concepts/mint-marks-and-entropy) and the
[Injection convention](/docs/surface/reference/injection-convention).

## Fully onchain Solidity SVG

For a Solidity SVG work, implement `IRenderer` directly. There is no base
contract to inherit: the interface is two views. A minimal v2 renderer that
reads the seed and returns a data URI:

```solidity
// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IRenderer} from "./interfaces/IRenderer.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

interface ISurfaceReads {
    function name() external view returns (string memory);
    function tokenSeed(uint256 tokenId) external view returns (bytes32);
}

contract Dithers is IRenderer {
    using LibString for uint256;

    function tokenURI(address collection, uint256 tokenId) external view override returns (string memory) {
        ISurfaceReads c = ISurfaceReads(collection);
        uint256 hue = uint256(c.tokenSeed(tokenId)) % 360;
        string memory svg = string.concat(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 500 500'>",
            "<rect width='500' height='500' fill='hsl(", hue.toString(), ",60%,20%)'/>",
            "</svg>"
        );
        string memory json = string.concat(
            '{"name":"', LibString.escapeJSON(c.name()), " #", tokenId.toString(),
            '","image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)),
            '","attributes":[{"trait_type":"Mint Order","value":', tokenId.toString(), "}]}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function contractURI(address collection) external view override returns (string memory) {
        string memory json = string.concat(
            '{"name":"', LibString.escapeJSON(ISurfaceReads(collection).name()), '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
}
```

Escape every string you did not write yourself (the collection name can change
on v2 through `setName`). A Solidity SVG work has no JS runtime and no browser
dependency, and it renders in anything that parses SVG, including bare `<img>`
tags, so its `image` needs no separate capture.

## Script-based generative work

Art Blocks-style work ships as the artist's own renderer that assembles an
HTML document at `tokenURI` time: it reads the token's seed, injects the render
context, emits the work's dependencies, context, and code (plus a gunzip helper
when anything is gzipped), and returns `tokenURI` JSON whose `animation_url`
is a `data:text/html;base64,...` URI. Scripty's `ScriptyBuilderV2` and
`ScriptyStorageV2` are a common way to store the code and assemble the
document onchain. Follow the [Injection convention](/docs/surface/reference/injection-convention)
for the exact context object, so an offchain preview (studio, mint page,
artist-site embed) is byte-for-byte the render.

Onchain traits must be a pure function of the seed, computed the same way your
sketch computes them so the published trait matches the render; traits that
require running the algorithm belong offchain. An HTML work's `image` is a
still the renderer stores or points at, since marketplaces cannot run the
document for a thumbnail.

A renderer whose output is a pure function of `(tokenId, seed)` can also
implement the optional [IPreviewRenderer](/docs/surface/contracts/i-preview-renderer)
extension, so callers can preview outputs for seeds that have not been minted.

PND earlier carried reference renderers for this (`DefaultRenderer`,
`ScriptyRenderer`, and a shared `RenderAssets` registry). They were removed
from the protocol with Surface v2, were never deployed to mainnet by PND, and
may return later as a separate optional package.

## Static images and covers

A renderer can store its image URIs itself, or read them from another
contract. One existing example: Form of Solitude's renderer takes its token
stills (captured images) from an independent `RenderAssets` registry at
`0x34D384646a44EbeA51f07C1Fa888E469483e25fB`, deployed from an external repo.
That is one artist's pattern, not part of PND's protocol: PND does not deploy,
maintain, or depend on it, and any renderer is free to store assets however it
likes.

For an edition released in batches, an artist-deployed `BatchRenderRouter`
can sit in the renderer slot and dispatch `tokenURI` by token id range to one
renderer per batch.

## Installing a renderer

On v2:

```solidity
function setRenderer(address renderer_) external; // owner only
function renderer() external view returns (address); // never zero
```

`setRenderer` reverts `RendererRequired` on zero and `RendererNotContract` on
an address without code, and emits `RendererSet`,
`BatchMetadataUpdate(0, type(uint256).max)` and `ContractURIUpdated` so
marketplaces refresh. Once the owner calls `renounceOwnership`, no setter can
succeed and the renderer pointer is fixed for good.

On v1, `setRenderer` is callable by the owner or an admin, and reverts
`RendererIsLocked` once `lockRenderer` has been called (optional, one-way, off
by default).

## Renderer permanence

Fixing the pointer (renounce on v2, `lockRenderer` on v1) pins *which*
renderer answers `tokenURI`; the collection does not verify what that renderer
does internally. A renderer makes its *own* permanence promise: deploy it
immutable (no setters at all), or give it a one-way lock over its work
definition and assets. A fixed pointer at an immutable renderer fixes
presentation as firmly as the collection contract itself.

See [IRenderer](/docs/surface/contracts/i-renderer),
[IPreviewRenderer](/docs/surface/contracts/i-preview-renderer), and
[ISurfaceView](/docs/surface/contracts/i-surface-view) for the generated
interface references, and the
[Injection convention](/docs/surface/reference/injection-convention) for the
render-context contract every offchain preview must match byte-for-byte with
the onchain assembly.
