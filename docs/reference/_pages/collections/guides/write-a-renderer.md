---
title: Write a renderer
description: Implement IRenderer against ICollectionView, the three built-in renderers, and how metadata freezing and work locking work.
---

# Write a renderer

A renderer builds a collection's `tokenURI` and `contractURI`. It is a slot: the collection delegates both calls to whichever renderer address is currently set, falling back to `defaultRenderer` (wired in at deploy) when the owner hasn't set an override.

```solidity
interface IRenderer {
    function tokenURI(address collection, uint256 tokenId) external view returns (string memory);
    function contractURI(address collection) external view returns (string memory);
}
```

The collection address is an explicit parameter, not `msg.sender`. That's a deliberate choice: one deployed renderer instance can serve every collection built against the same algorithm, offchain callers can `eth_call` a renderer directly for any collection without transacting, and any contract (not only `Collection`) can adopt the interface by implementing enough of `ICollectionView` for its chosen renderer to read.

## Reading collection state through ICollectionView

```solidity
interface ICollectionView {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function owner() external view returns (address);
    function totalSupply() external view returns (uint256);
    function tokenSeed(uint256 tokenId) external view returns (bytes32);
    function config()
        external
        view
        returns (CollectionConfig memory cfg, CollectionStatus status, uint256 minted);
    function artwork() external view returns (string memory);
    function isWorkLocked() external view returns (bool);
    function idMode() external view returns (IdMode);
}
```

`Collection` implements this surface in full (though it does not formally inherit the interface, to avoid forcing passthrough re-overrides against its OZ bases for zero behavior). A renderer is a plain onchain view with full EVM read access: the seed, the current owner, sibling tokens, companion state, foreign contracts, block state, anything callable. That is what makes network-based (chain-live) works possible at all; a renderer isn't a sandbox with two inputs, it's an ordinary contract call.

## The three built-in renderers

### DefaultRenderer

The canonical renderer wired into every collection at deploy. Static: it reads the token's image from the [RenderAssets](/docs/collections/contracts/render-assets) registry (the per-token capture if one exists, else the collection cover) and wraps it in a JSON envelope with the token's Mint Mark as provenance attributes (`Mint Order`, `Mint Block`, plus `Provenance: First/Final mint` where applicable). No code execution, no onchain algorithm; the image is whatever URI the artist set.

### SVGRenderer (abstract base)

For fully onchain Solidity SVG works. `SVGRenderer` implements `IRenderer` end to end (base64 JSON envelope, `image` as a `data:image/svg+xml;base64,...` URI, the same Mint Mark attributes as `DefaultRenderer`), leaving exactly one abstract function for a concrete work to implement:

```solidity
function svg(address collection, uint256 tokenId) internal view virtual returns (string memory);
```

Return a complete `<svg ...>...</svg>` document; the base handles base64 encoding and the data URI wrapper. Optional hooks to override:

```solidity
function tokenName(address collection, uint256 tokenId) internal view virtual returns (string memory);
function tokenDescription(address collection, uint256 tokenId) internal view virtual returns (string memory);
function attributes(address collection, uint256 tokenId) internal view virtual returns (string memory);
```

Minimal concrete work:

```solidity
// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SVGRenderer} from "./renderers/SVGRenderer.sol";
import {ICollectionView} from "./interfaces/IRenderer.sol";
import {LibString} from "solady/utils/LibString.sol";

contract Dithers is SVGRenderer {
    function svg(address collection, uint256 tokenId) internal view override returns (string memory) {
        bytes32 seed = ICollectionView(collection).tokenSeed(tokenId);
        uint256 hue = uint256(seed) % 360;
        return string.concat(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 500 500'>",
            "<rect width='500' height='500' fill='hsl(", LibString.toString(hue), ",60%,20%)'/>",
            "</svg>"
        );
    }
}
```

Solidity SVG is the highest preservation tier the system offers: no JS runtime, no browser to drift, and it renders in anything that parses SVG, including bare `<img>` tags, so SVG works also mostly skip the capture worker used for thumbnails of HTML works.

### GenerativeRenderer (default for script-based generative)

An ownerless singleton for Art Blocks-style long-form generative work, and the registry of generative work configs: per-collection `WorkConfig` is stored in the renderer itself, written by the collection's owner/admins (`setWork(collection, work)`) and lockable one-way (`lockWork(collection)`). At `tokenURI` time it reads its own registry plus the token's seed, assembles a complete HTML document via ScriptyBuilderV2 from onchain-stored files (dependencies + the injected token context + the artist's code), and returns `tokenURI` JSON whose `animation_url` is a `data:text/html;base64,...` URI. See [Deploy a collection](/docs/collections/guides/deploy-a-collection) for the `WorkConfig` fields, and [Injection convention](/docs/collections/reference/injection-convention) for the exact context object the assembled document injects.

## Installing a renderer

```solidity
function setRenderer(address renderer_) external; // owner-only
function renderer() external view returns (address); // resolved: override or defaultRenderer
```

`setRenderer` reverts `RendererIsLocked` once the owner has called `lockRenderer` (optional, off by default). The lock is one-way and pins the pointer: after locking, this exact renderer contract answers `tokenURI` forever. The core cannot attest what a renderer does internally — an immutable renderer plus a locked pointer is full presentation permanence, while a mutable renderer with a locked pointer is the artist's explicit, inspectable choice.

## Locking the work

For generative collections, the companion permanence lever lives in the renderer's own registry:

```solidity
// on GenerativeRenderer, authorized by the collection's owner/admins
function setWork(address collection, WorkConfig calldata work) external; // reverts WorkIsLocked once locked
function lockWork(address collection) external; // one-way
function workLockedOf(address collection) external view returns (bool);
```

`lockRenderer` (on the collection) pins *who* renders; `lockWork` (in the renderer) pins *what the work is*. Together they are the strongest guarantee the system offers short of the contract itself being immutable from deploy, which it already is.

See [IRenderer](/docs/collections/contracts/i-renderer) and [ICollectionView](/docs/collections/contracts/i-collection-view) for the generated interface reference, [GenerativeRenderer](/docs/collections/contracts/generative-renderer) and [DefaultRenderer](/docs/collections/contracts/default-renderer) for the deployed singletons, and [Injection convention](/docs/collections/reference/injection-convention) for the render-context contract every offchain preview (studio, mint surface, artist-site embed) must match byte-for-byte with the onchain assembly.
