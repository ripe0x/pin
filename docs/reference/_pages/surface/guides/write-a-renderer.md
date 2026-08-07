---
title: Write a renderer
description: Implement IRenderer against ISurfaceView, the bundled renderers, and how renderer locking works.
---

# Write a renderer

A renderer builds a collection's `tokenURI` and `contractURI`. It is a slot: the collection delegates both calls to whichever renderer address is currently set. The slot is resolved once at init, from the config or the factory's `defaultRenderer`, and is never zero afterward. The mainnet factory carries no `defaultRenderer`, so a collection names its own renderer at deploy.

```solidity
interface IRenderer {
    function tokenURI(address collection, uint256 tokenId) external view returns (string memory);
    function contractURI(address collection) external view returns (string memory);
}
```

The collection address is an explicit parameter, not `msg.sender`: one deployed renderer instance can serve every collection built against the same algorithm, offchain callers can `eth_call` a renderer directly for any collection without transacting, and any contract (not only `Surface`) can adopt the interface by implementing enough of `ISurfaceView` for its chosen renderer to read.

## Reading collection state through ISurfaceView

```solidity
interface ISurfaceView {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function owner() external view returns (address);
    function totalSupply() external view returns (uint256);
    function tokenSeed(uint256 tokenId) external view returns (bytes32);
    function config() external view returns (SurfaceConfig memory cfg, uint256 minted);
    function idMode() external view returns (IdMode);
}
```

`Surface` implements this surface in full (though it does not formally inherit the interface, to avoid forcing passthrough re-overrides against its OZ bases for zero behavior). A renderer is an onchain view with full EVM read access: the seed, the current owner, sibling tokens, companion state, other contracts, and block state. A renderer's output can therefore depend on live chain state, not only on the seed.


## DefaultRenderer

The canonical renderer wired into every collection at deploy. Static: it reads the token's image from the [RenderAssets](/docs/surface/contracts/render-assets) registry (per-token capture, else the collection's capture template resolved for this id, else the cover) and wraps it in a JSON envelope with derived provenance attributes (`Mint Order` plus `Provenance: First/Final mint` where applicable, sequential-id collections only). Its `contractURI` carries the cover, which is what marketplace collection pages show. No code execution, no onchain algorithm; the image is whatever URI the artist set.

## ScriptyRenderer (bring-your-own generative)

Art Blocks-style script-based work ships as its own renderer. The system provides a template, [ScriptyRenderer](/docs/surface/contracts/scripty-renderer), that assembles a complete HTML document onchain via ScriptyBuilderV2: at `tokenURI` time it reads the token's seed through [ISurfaceView](/docs/surface/contracts/i-surface-view), injects the render context, emits the work's dependencies + context + code (+ a gunzip helper when anything is gzipped), and returns `tokenURI` JSON whose `animation_url` is a `data:text/html;base64,...` URI. Follow the [Injection convention](/docs/surface/reference/injection-convention) for the exact context object it injects, so an offchain preview is byte-for-byte the render.

The work definition (its onchain code and dependency refs, the injection version) is fixed in the constructor, with no `setWork`, owner, or lock, so the output is a pure function of chain state. With the collection's `lockRenderer()`, the token's presentation is fixed with no post-deploy step. Deploy `ScriptyRenderer` directly with your work for the default provenance traits (`Mint Order` + `Seed`), or subclass it to customize through three fork points:

```solidity
// override in a subclass, see ExampleScriptyWork
function _workTraits(bytes32 seed) internal view virtual returns (bytes memory);        // seed-derived onchain traits
function _image(address collection, uint256 tokenId) internal view virtual returns (string memory); // a poster/thumbnail
function _headTags() internal view virtual returns (HTMLTag[] memory);                  // the document <head>
```

Onchain traits must be a pure function of the seed, computed the same way your sketch computes them so the published trait matches the render; traits that require running the algorithm belong offchain. The worked example `ExampleScriptyWork` (in `contracts/src/surface/templates/`) shows a seed-derived `Palette` trait and a fixed-aspect head, and the fork test `ScriptyRendererFork.t.sol` proves an instance assembles a full document (real gzipped p5, the injected seed, the artist code) from chain state alone.

## Fully onchain Solidity SVG

For a Solidity SVG work, implement `IRenderer` directly; there is no abstract base to inherit, since the interface is two views, and the shared `MetadataJson` library (`contracts/src/surface/renderers/MetadataJson.sol`) provides the pieces that should not be rewritten per work (RFC 8259 JSON escaping, the base64 data-URI envelope, and the derived provenance traits every bundled renderer emits the same way).

```solidity
// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IRenderer, ISurfaceView} from "./interfaces/IRenderer.sol";
import {MetadataJson} from "./renderers/MetadataJson.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

contract Dithers is IRenderer {
    using LibString for uint256;

    function tokenURI(address collection, uint256 tokenId) external view override returns (string memory) {
        ISurfaceView cv = ISurfaceView(collection);
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
            string.concat('{"name":"', MetadataJson.escape(ISurfaceView(collection).name()), '"}')
        );
    }
}
```

A Solidity SVG work has no JS runtime and no browser dependency, and it renders in anything that parses SVG, including bare `<img>` tags, so an SVG work also mostly skips the capture pipeline used for thumbnails of HTML works.

## Installing a renderer

```solidity
function setRenderer(address renderer_) external; // owner or admin
function renderer() external view returns (address); // the current slot; never zero
```

`setRenderer` reverts `RendererIsLocked` once the owner has called `lockRenderer` (optional, off by default). The lock is one-way and pins the pointer: after locking, this renderer contract answers `tokenURI` from then on. The core does not verify what a renderer does internally: an immutable renderer behind a locked pointer fixes presentation, while a mutable renderer behind a locked pointer leaves that renderer's output changeable.

## Renderer permanence

`lockRenderer` (on the collection) pins *which* renderer answers `tokenURI`; it does not verify what that renderer does internally. A generative renderer makes its *own* permanence promise: deploy it immutable (no setters at all), or give it a one-way lock over its work definition. A locked pointer at an immutable renderer fixes presentation as firmly as the collection contract itself, which is immutable from deploy.

## Document size and the gas budget

A renderer that assembles a full HTML document onchain pays for it at read time: `tokenURI` is an `eth_call`, and public RPCs cap how much gas a call may consume. A ScriptyRenderer work over a gzipped p5 dependency measures roughly 60 to 120 million gas per `tokenURI`, which an elevated-gas `eth_call` still serves. A work that inlines large assets pushes past that: escape blue bakes an mp3 via EthFS and its `tokenURI` costs about 5.45 billion gas, which no RPC will evaluate.

An oversized `tokenURI` does not mean the work stops rendering. For any ScriptyRenderer-shaped renderer (one exposing `code()`, `deps()`, `injectionVersion()`, and the gunzip pointer), the web app reassembles the identical document offchain from the renderer's code refs and the bytes stored in ScriptyStorageV2 / EthFS, byte-for-byte with the onchain output (the parity render library, asserted against the onchain assembly). So a heavy work still shows on its token page and mint surface; the fallback triggers automatically when the `tokenURI` call exceeds the gas budget.

The tradeoff is what a fully-onchain reader gets. A work whose `tokenURI` fits the gas budget can be read start to finish from a single call by anyone. A work that overflows it can only be read by re-assembling from its stored bytes: still fully onchain (the code and dependencies live in onchain storage), but not in one `eth_call`. Keep the assembled document within the budget when a single-call read matters for the work; reach for large inlined assets knowing the read path becomes re-assembly.

For a renderer to be offchain-assemblable it must expose its work publicly: `code()` and `deps()` returning `CodeRef[]`, `injectionVersion()`, and `gunzipStore()` / `gunzipFile()`. ScriptyRenderer does. A bespoke renderer that hides its refs cannot use the generic fallback and needs its own server-side assembler.

See [IRenderer](/docs/surface/contracts/i-renderer) and [ISurfaceView](/docs/surface/contracts/i-surface-view) for the generated interface reference, [DefaultRenderer](/docs/surface/contracts/default-renderer) for the deployed fallback singleton, and [Injection convention](/docs/surface/reference/injection-convention) for the render-context contract every offchain preview (studio, mint surface, artist-site embed) must match byte-for-byte with the onchain assembly.
