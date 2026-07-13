---
title: Write a renderer
description: Implement IRenderer against ICollectionView, the bundled renderers, and how renderer locking works.
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
    function idMode() external view returns (IdMode);
}
```

`Collection` implements this surface in full (though it does not formally inherit the interface, to avoid forcing passthrough re-overrides against its OZ bases for zero behavior). A renderer is a plain onchain view with full EVM read access: the seed, the current owner, sibling tokens, companion state, foreign contracts, block state, anything callable. That is what makes network-based (chain-live) works possible at all; a renderer isn't a sandbox with two inputs, it's an ordinary contract call.


## DefaultRenderer

The canonical renderer wired into every collection at deploy. Static: it reads the token's image from the [RenderAssets](/docs/collections/contracts/render-assets) registry (per-token capture, else the collection's capture template resolved for this id, else the cover) and wraps it in a JSON envelope with derived provenance attributes (`Mint Order` plus `Provenance: First/Final mint` where applicable, sequential-id collections only). Its `contractURI` carries the cover, which is what marketplace collection pages show. No code execution, no onchain algorithm; the image is whatever URI the artist set.

## ScriptyRenderer (bring-your-own generative)

Art Blocks-style script-based work ships as its own renderer. The system provides a concrete template — [ScriptyRenderer](/docs/collections/contracts/scripty-renderer) — that assembles a complete HTML document onchain via ScriptyBuilderV2: at `tokenURI` time it reads the token's seed through [ICollectionView](/docs/collections/contracts/i-collection-view), injects the render context, emits the work's dependencies + context + code (+ a gunzip helper when anything is gzipped), and returns `tokenURI` JSON whose `animation_url` is a `data:text/html;base64,...` URI. Follow the [Injection convention](/docs/collections/reference/injection-convention) for the exact context object it injects, so an offchain preview is byte-for-byte the render.

It is **immutable by construction**: the work definition (its onchain code and dependency refs, the injection version) is fixed in the constructor — no `setWork`, no owner, no lock — so the output is a pure function of chain state any external checker can attest. With the collection's `lockRenderer()` that is provable, end-to-end permanence with zero trusted post-deploy steps. Deploy `ScriptyRenderer` directly with your work for the default provenance traits (`Mint Order` + `Seed`), or subclass it to customize through three fork points:

```solidity
// override in a subclass — see ExampleScriptyWork
function _workTraits(bytes32 seed) internal view virtual returns (bytes memory);        // seed-derived onchain traits
function _image(address collection, uint256 tokenId) internal view virtual returns (string memory); // a poster/thumbnail
function _headTags() internal view virtual returns (HTMLTag[] memory);                  // the document <head>
```

Onchain traits must be a pure function of the seed, computed the same way your sketch computes them so the published trait matches the render; traits that require running the algorithm belong offchain. The worked example `ExampleScriptyWork` (in `contracts/src/collection/templates/`) shows a seed-derived `Palette` trait and a fixed-aspect head, and the fork test `ScriptyRendererFork.t.sol` proves an instance assembles a full document (real gzipped p5, the injected seed, the artist code) from chain state alone.

## Fully onchain Solidity SVG

For a Solidity SVG work, implement `IRenderer` directly — there is no abstract base to inherit, on purpose: the whole interface is two views, and the shared `MetadataJson` library (`contracts/src/collection/renderers/MetadataJson.sol`) provides the pieces that should not be rewritten per work (RFC 8259 JSON escaping, the base64 data-URI envelope, and the derived provenance traits every bundled renderer emits the same way).

```solidity
// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IRenderer, ICollectionView} from "./interfaces/IRenderer.sol";
import {MetadataJson} from "./renderers/MetadataJson.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

contract Dithers is IRenderer {
    using LibString for uint256;

    function tokenURI(address collection, uint256 tokenId) external view override returns (string memory) {
        ICollectionView cv = ICollectionView(collection);
        uint256 hue = uint256(cv.tokenSeed(tokenId)) % 360;
        string memory svg = string.concat(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 500 500'>",
            "<rect width='500' height='500' fill='hsl(", hue.toString(), ",60%,20%)'/>",
            "</svg>"
        );
        string memory json = string.concat(
            '{"name":"', MetadataJson.escape(cv.name()), " #", tokenId.toString(),
            '","image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)),
            '","attributes":', MetadataJson.provenanceAttributes(cv, tokenId), "}"
        );
        return MetadataJson.jsonDataURI(json);
    }

    function contractURI(address collection) external view override returns (string memory) {
        return MetadataJson.jsonDataURI(
            string.concat('{"name":"', MetadataJson.escape(ICollectionView(collection).name()), '"}')
        );
    }
}
```

Solidity SVG is the highest preservation tier the system offers: no JS runtime, no browser to drift, and it renders in anything that parses SVG, including bare `<img>` tags, so SVG works also mostly skip the capture pipeline used for thumbnails of HTML works.

## Installing a renderer

```solidity
function setRenderer(address renderer_) external; // owner or admin
function renderer() external view returns (address); // resolved: override or defaultRenderer
```

`setRenderer` reverts `RendererIsLocked` once the owner has called `lockRenderer` (optional, off by default). The lock is one-way and pins the pointer: after locking, this exact renderer contract answers `tokenURI` forever. The core cannot attest what a renderer does internally — an immutable renderer plus a locked pointer is full presentation permanence, while a mutable renderer with a locked pointer is the artist's explicit, inspectable choice.

## Renderer permanence

`lockRenderer` (on the collection) pins *which* renderer answers `tokenURI` forever; it does not attest what that renderer does internally. A generative renderer makes its *own* permanence promise: deploy it immutable (no setters at all), or give it a one-way lock over its work definition. A locked pointer plus an immutable renderer is the strongest guarantee the system offers short of the collection contract itself, which is already immutable from deploy.

See [IRenderer](/docs/collections/contracts/i-renderer) and [ICollectionView](/docs/collections/contracts/i-collection-view) for the generated interface reference, [DefaultRenderer](/docs/collections/contracts/default-renderer) for the deployed fallback singleton, and [Injection convention](/docs/collections/reference/injection-convention) for the render-context contract every offchain preview (studio, mint surface, artist-site embed) must match byte-for-byte with the onchain assembly.
