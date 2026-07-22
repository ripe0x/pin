// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {IRenderer, ISurfaceView} from "../interfaces/IRenderer.sol";
import {IPreviewRenderer} from "../interfaces/IPreviewRenderer.sol";
import {IdMode} from "../SurfaceTypes.sol";
import {RenderAssets} from "../renderers/RenderAssets.sol";
import {CodeKind, CodeRef} from "./CodeTypes.sol";
import {IScriptyBuilderV2} from "./vendor/scripty/interfaces/IScriptyBuilderV2.sol";
import {HTMLRequest, HTMLTag, HTMLTagType} from "./vendor/scripty/core/ScriptyStructs.sol";

/// @title ScriptyRenderer
/// @notice A **bring-your-own generative renderer template**: a concrete,
///         forkable `IRenderer` for Art Blocks-style script-based work,
///         assembled fully onchain via ScriptyBuilderV2. Deploy one instance
///         per work (or subclass it for custom traits), then point a
///         collection's renderer slot at it.
///
///         **Immutable by construction.** The work definition (its onchain code
///         and dependency files, the injection version) is fixed in the
///         constructor and never mutated: no `setWork`, no owner, no separate
///         lock step. The renderer's output is therefore a pure function of
///         chain state that any external checker can attest. Combined with the
///         collection's `lockRenderer()`, which pins the renderer pointer at
///         this contract, presentation permanence holds with no trusted
///         post-deploy steps.
///
///         At `tokenURI` time it reads the token's seed through
///         `ISurfaceView`, injects the render context
///         (`window.tokenData = { hash, tokenId, collection, chainId, version,
///         context }`; hash/tokenId use the widely-adopted long-form-
///         generative shape, so existing sketches run unmodified; `context`
///         states why the document is rendered: "token" for canonical
///         renders, "preview" for previewURI renders), assembles
///         the dependencies + context + artist code into a complete HTML
///         document, and returns metadata whose `animation_url` is a
///         `data:text/html;base64,...` URI. See
///         `docs/injection-convention.md` for the exact parity contract every
///         offchain preview must match.
///
///         Implements the OPTIONAL `IPreviewRenderer`: the work is a pure
///         function of (tokenId, seed), so a preview is the same document
///         assembly with a caller-supplied seed. A mint page can sample
///         outputs before any token exists.
///
///         **Fork points** (override in a subclass; see ExampleScriptyWork):
///         - `_workTraits(seed)` to publish seed-derived onchain traits
///         - `_image(collection, tokenId)` to change where the poster/
///           thumbnail comes from (default: RenderAssets, when wired)
///         - `_headTags()` to customize the document `<head>`
contract ScriptyRenderer is IRenderer, IPreviewRenderer {
    using LibString for uint256;
    using LibString for address;

    /// @notice The scripty v2 builder that assembles the HTML document.
    IScriptyBuilderV2 public immutable scriptyBuilder;

    /// @notice Storage contract holding the gunzip helper, emitted LAST when
    ///         any dependency or code file is gzipped.
    address public immutable gunzipStore;

    /// @notice Render-context injection convention version, echoed to the work
    ///         as `tokenData.version`.
    uint8 public immutable injectionVersion;

    /// @notice Where the cover and per-token captures live, when wired
    ///         (address(0) = no static images; `animation_url` stands alone).
    ///         Marketplace grids show `image`, not the live render, so a work
    ///         that wants tiles on those surfaces points this at the
    ///         RenderAssets singleton and sets captures there.
    RenderAssets public immutable renderAssets;

    /// @dev Set once in the constructor, never mutated (no setter exists), so
    ///      they are immutable in behavior even though Solidity `immutable`
    ///      cannot hold dynamic arrays / strings.
    string private _gunzipFile;
    CodeRef[] private _code; // the artist's algorithm, chunked/named onchain
    CodeRef[] private _deps; // library files (gzipped p5 / three / etc.)

    error NoCode();
    error BuilderRequired();
    error GunzipStoreRequired();
    error StoreNotContract(address store);

    constructor(
        address scriptyBuilder_,
        address gunzipStore_,
        string memory gunzipFile_,
        CodeRef[] memory code_,
        CodeRef[] memory deps_,
        uint8 injectionVersion_,
        address renderAssets_
    ) {
        if (scriptyBuilder_.code.length == 0) revert BuilderRequired();
        if (code_.length == 0) revert NoCode();
        scriptyBuilder = IScriptyBuilderV2(scriptyBuilder_);
        gunzipStore = gunzipStore_;
        _gunzipFile = gunzipFile_;
        injectionVersion = injectionVersion_;
        renderAssets = RenderAssets(renderAssets_);
        // Every referenced file store must be a deployed contract. An EOA store
        // makes tokenURI revert; if the renderer is then locked, the break is
        // permanent. The core runs the same code-length check on the renderer
        // slot; this applies it to the files the renderer reads.
        bool needsGunzip;
        for (uint256 i = 0; i < code_.length; i++) {
            if (code_[i].store.code.length == 0) revert StoreNotContract(code_[i].store);
            if (code_[i].kind == CodeKind.ScriptGzip) needsGunzip = true;
            _code.push(code_[i]);
        }
        for (uint256 i = 0; i < deps_.length; i++) {
            if (deps_[i].store.code.length == 0) revert StoreNotContract(deps_[i].store);
            if (deps_[i].kind == CodeKind.ScriptGzip) needsGunzip = true;
            _deps.push(deps_[i]);
        }
        // The gunzip helper is consulted only when a gzipped file is present;
        // when one is, its store must hold code (the build would revert
        // otherwise), so a missing store is rejected here instead of after a
        // lock.
        if (needsGunzip && gunzipStore_.code.length == 0) revert GunzipStoreRequired();
    }

    // ── verification views (anyone can attest what this renderer assembles) ──

    function gunzipFile() external view returns (string memory) {
        return _gunzipFile;
    }

    function code() external view returns (CodeRef[] memory) {
        return _code;
    }

    function deps() external view returns (CodeRef[] memory) {
        return _deps;
    }

    // ── IRenderer ────────────────────────────────────────────────────────────

    function tokenURI(address collection, uint256 tokenId) external view override returns (string memory) {
        ISurfaceView c = ISurfaceView(collection);
        bytes32 seed = c.tokenSeed(tokenId);
        string memory htmlUri = _buildHTML(collection, tokenId, seed, "token");
        string memory image = _image(collection, tokenId);

        bytes memory json = abi.encodePacked(
            '{"name":"',
            LibString.escapeJSON(c.name()),
            " #",
            tokenId.toString(),
            '","animation_url":"',
            htmlUri,
            '"',
            bytes(image).length > 0 ? string(abi.encodePacked(',"image":"', LibString.escapeJSON(image), '"')) : "",
            ',"attributes":',
            _attributes(c, tokenId, seed),
            "}"
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    /// @inheritdoc IPreviewRenderer
    /// @dev Identical document assembly as tokenURI, with the caller's seed
    ///      in place of tokenSeed and `context:"preview"` injected. No token
    ///      needs to exist. The metadata carries no provenance: the name is
    ///      marked as a preview, attributes carry the seed only, and no
    ///      static image is attached (a preview is the live render).
    function previewURI(address collection, uint256 tokenId, bytes32 seed)
        external
        view
        override
        returns (string memory)
    {
        string memory htmlUri = _buildHTML(collection, tokenId, seed, "preview");

        bytes memory json = abi.encodePacked(
            '{"name":"',
            LibString.escapeJSON(ISurfaceView(collection).name()),
            " #",
            tokenId.toString(),
            ' (preview)","animation_url":"',
            htmlUri,
            '","attributes":[{"trait_type":"Seed","value":"',
            uint256(seed).toHexString(32),
            '"}]}'
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    /// @dev Contract-level metadata for the marketplace collection page.
    ///      Includes the cover when renderAssets is wired and a cover is set.
    function contractURI(address collection) external view override returns (string memory) {
        string memory cover =
            address(renderAssets) == address(0) ? "" : renderAssets.coverOf(collection);
        bytes memory json = abi.encodePacked(
            '{"name":"',
            LibString.escapeJSON(ISurfaceView(collection).name()),
            '"',
            bytes(cover).length > 0
                ? string(abi.encodePacked(',"image":"', LibString.escapeJSON(cover), '"'))
                : "",
            "}"
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    // ── HTML assembly ─────────────────────────────────────────────────────────

    /// @dev Body tag order per the injection convention: dependencies → token
    ///      context → artist code → gunzip helper LAST when any tag is gzipped.
    ///      The helper decompresses at its own parse time by scanning the gzip
    ///      tags that precede it and replacing each with an executing script
    ///      tag, in document order; placed earlier it would find nothing.
    function _buildHTML(address collection, uint256 tokenId, bytes32 seed, string memory context)
        private
        view
        returns (string memory)
    {
        bool needsGunzip = _anyGzip(_deps) || _anyGzip(_code);
        if (needsGunzip && gunzipStore == address(0)) revert GunzipStoreRequired();

        uint256 n = (needsGunzip ? 1 : 0) + _deps.length + 1 + _code.length;
        HTMLTag[] memory body = new HTMLTag[](n);
        uint256 i = 0;

        for (uint256 d = 0; d < _deps.length; d++) {
            body[i] = _fileTag(_deps[d]);
            i++;
        }
        body[i].tagType = HTMLTagType.script;
        body[i].tagContent = _contextJs(collection, tokenId, seed, context);
        i++;
        for (uint256 s = 0; s < _code.length; s++) {
            body[i] = _fileTag(_code[s]);
            i++;
        }
        if (needsGunzip) {
            body[i].name = _gunzipFile;
            body[i].contractAddress = gunzipStore;
            // EthFS stores files as base64 TEXT, so the helper ships as a
            // base64 data-URI script src; inlined raw it is a syntax error.
            body[i].tagType = HTMLTagType.scriptBase64DataURI;
            i++;
        }

        return scriptyBuilder.getEncodedHTMLString(HTMLRequest({headTags: _headTags(), bodyTags: body}));
    }

    function _fileTag(CodeRef memory ref) private pure returns (HTMLTag memory tag) {
        tag.name = ref.name;
        tag.contractAddress = ref.store;
        tag.tagType = ref.kind == CodeKind.ScriptGzip ? HTMLTagType.scriptGZIPBase64DataURI : HTMLTagType.script;
    }

    function _anyGzip(CodeRef[] storage refs) private view returns (bool) {
        for (uint256 i = 0; i < refs.length; i++) {
            if (refs[i].kind == CodeKind.ScriptGzip) return true;
        }
        return false;
    }

    /// @dev Render-context convention: `hash` + `tokenId` use the standard
    ///      long-form-generative `tokenData` shape for sketch portability. In
    ///      Sequential mode the token id equals the mint order. `context`
    ///      ("token" | "preview" | offchain "capture") is additive within v1:
    ///      work code SHOULD tolerate additions and treat a missing/"token"
    ///      context as the canonical render.
    function _contextJs(address collection, uint256 tokenId, bytes32 seed, string memory context)
        private
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            'window.tokenData={"hash":"',
            uint256(seed).toHexString(32),
            '","tokenId":"',
            tokenId.toString(),
            '","collection":"',
            collection.toHexString(),
            '","chainId":',
            block.chainid.toString(),
            ',"version":',
            uint256(injectionVersion).toString(),
            ',"context":"',
            context,
            '"};'
        );
    }

    // ── overridable fork points ───────────────────────────────────────────────

    /// @dev The document `<head>`. Default: a full-bleed canvas reset. Override
    ///      for custom styling, meta tags, or a fixed aspect ratio.
    function _headTags() internal view virtual returns (HTMLTag[] memory head) {
        head = new HTMLTag[](1);
        head[0].tagOpen = "<style>";
        head[0].tagContent = "html,body{margin:0;padding:0;height:100%;overflow:hidden}canvas{display:block}";
        head[0].tagClose = "</style>";
        head[0].tagType = HTMLTagType.useTagOpenAndClose;
    }

    /// @dev Poster/thumbnail for the metadata `image` field. Default: the
    ///      RenderAssets lookup (capture, else template, else cover) when the
    ///      registry is wired, nothing otherwise. In both cases
    ///      `animation_url` remains the artwork. Override for a custom
    ///      source.
    function _image(address collection, uint256 tokenId) internal view virtual returns (string memory) {
        if (address(renderAssets) == address(0)) return "";
        return renderAssets.imageFor(collection, tokenId);
    }

    /// @dev Seed-derived onchain traits, appended to the derived provenance
    ///      traits. Default: none. Override to publish traits that are a pure
    ///      function of the seed (a palette, a density, a variant) so they read
    ///      onchain without running the sketch. Return raw JSON object entries
    ///      WITH a leading comma, e.g. `,{"trait_type":"Palette","value":"Dusk"}`.
    ///      Traits that require executing the algorithm cannot be computed here.
    function _workTraits(
        bytes32 /* seed */
    )
        internal
        view
        virtual
        returns (bytes memory)
    {
        return "";
    }

    /// @dev Provenance traits (Mint Order in Sequential mode + Seed), then the
    ///      work's own seed-derived traits from `_workTraits`.
    function _attributes(ISurfaceView c, uint256 tokenId, bytes32 seed) private view returns (bytes memory) {
        bytes memory order = c.idMode() == IdMode.Sequential
            ? abi.encodePacked('{"trait_type":"Mint Order","value":', tokenId.toString(), "},")
            : bytes("");
        return abi.encodePacked(
            "[", order, '{"trait_type":"Seed","value":"', uint256(seed).toHexString(32), '"}', _workTraits(seed), "]"
        );
    }
}
