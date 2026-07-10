// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {IRenderer, ICollectionView} from "../interfaces/IRenderer.sol";
import {IdMode} from "../CollectionTypes.sol";
import {CodeKind, CodeRef, WorkConfig} from "./WorkTypes.sol";
import {RenderAssets} from "./RenderAssets.sol";
import {IScriptyBuilderV2} from "../vendor/scripty/interfaces/IScriptyBuilderV2.sol";
import {HTMLRequest, HTMLTag, HTMLTagType} from "../vendor/scripty/core/ScriptyStructs.sol";

/// @title GenerativeRenderer
/// @notice The default renderer for script-based generative collections, and
///         the registry of their work configs: per-collection WorkConfig is
///         stored HERE, in renderer-land, written by each collection's
///         owner/admins and lockable one-way per collection. The collection
///         core stores no presentation data at all — it defers tokenURI to
///         this contract, which reads its own work registry plus the token's
///         seed, assembles a complete HTML document via ScriptyBuilderV2
///         (dependencies from onchain storage + the injected token context +
///         the artist's code), and returns tokenURI JSON whose animation_url
///         is a data:text/html;base64 URI. The live view is a pure function
///         of chain state: no server, no pin, nothing to keep alive.
///
///         The injected context (render-context convention v1) is
///         window.tokenData = { hash, tokenId, collection, chainId, version }
///         — hash/tokenId use the widely-adopted long-form-generative shape
///         so existing sketches run unmodified.
///
///         Full presentation permanence for a work = the collection's
///         lockRenderer() (pin the pointer at this immutable contract) plus
///         lockWork(collection) here (pin the algorithm). Static images
///         (cover, per-token captures) are read from the RenderAssets
///         registry and stay refreshable — they mirror rendered output.
contract GenerativeRenderer is IRenderer {
    using LibString for uint256;
    using LibString for address;

    /// @notice The scripty v2 builder that assembles the HTML.
    IScriptyBuilderV2 public immutable scriptyBuilder;

    /// @notice Static-asset registry (cover + captures) for the image field.
    RenderAssets public immutable renderAssets;

    /// @notice Storage contract + file name of the gunzip helper, emitted as
    ///         the first body tag whenever any dep/code file is gzipped.
    address public immutable gunzipStore;
    string public gunzipFile;

    /// @dev Per-collection work configs + one-way locks. Auth borrows each
    ///      collection's own owner/admin root, so managing the work carries
    ///      exactly the same authority as the collection's own setters.
    mapping(address => WorkConfig) private _works;
    mapping(address => bool) public workLockedOf;

    error NotCollectionAdmin();
    error WorkIsLocked();

    event WorkSet(address indexed collection, bytes32 codeHash);
    event WorkLocked(address indexed collection);

    constructor(
        address scriptyBuilder_,
        address renderAssets_,
        address gunzipStore_,
        string memory gunzipFile_
    ) {
        require(scriptyBuilder_ != address(0), "GR: builder required");
        require(renderAssets_ != address(0), "GR: assets required");
        require(gunzipStore_ != address(0), "GR: gunzip store required");
        scriptyBuilder = IScriptyBuilderV2(scriptyBuilder_);
        renderAssets = RenderAssets(renderAssets_);
        gunzipStore = gunzipStore_;
        gunzipFile = gunzipFile_;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Work registry (renderer-land storage; collection-authorized writes)
    // ─────────────────────────────────────────────────────────────────────────

    modifier onlyCollectionAdmin(address collection) {
        ICollectionView c = ICollectionView(collection);
        if (msg.sender != c.owner() && !c.isAdmin(msg.sender)) revert NotCollectionAdmin();
        _;
    }

    /// @notice Set or replace `collection`'s work definition. Reverts
    ///         WorkIsLocked once lockWork(collection) has run.
    function setWork(address collection, WorkConfig calldata work)
        external
        onlyCollectionAdmin(collection)
    {
        if (workLockedOf[collection]) revert WorkIsLocked();
        delete _works[collection]; // clear nested arrays before re-copy
        WorkConfig storage w = _works[collection];
        for (uint256 i = 0; i < work.code.length; i++) {
            w.code.push(work.code[i]);
        }
        for (uint256 i = 0; i < work.deps.length; i++) {
            w.deps.push(work.deps[i]);
        }
        w.codeURI = work.codeURI;
        w.codeHash = work.codeHash;
        w.injectionVersion = work.injectionVersion;
        w.renderParams = work.renderParams;
        emit WorkSet(collection, work.codeHash);
    }

    /// @notice One-way: permanently lock `collection`'s work definition, so
    ///         setWork can never change it again. With the collection's
    ///         lockRenderer() this is full presentation permanence.
    function lockWork(address collection) external onlyCollectionAdmin(collection) {
        if (workLockedOf[collection]) revert WorkIsLocked();
        workLockedOf[collection] = true;
        emit WorkLocked(collection);
    }

    function workOf(address collection) external view returns (WorkConfig memory) {
        return _works[collection];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // IRenderer
    // ─────────────────────────────────────────────────────────────────────────

    function tokenURI(address collection, uint256 tokenId)
        external
        view
        override
        returns (string memory)
    {
        ICollectionView c = ICollectionView(collection);
        WorkConfig memory work = _works[collection];
        bytes32 seed = c.tokenSeed(tokenId);

        // getEncodedHTMLString returns a complete data:text/html;base64 URI.
        string memory htmlUri = _buildHTML(collection, tokenId, work, seed);
        string memory image = _imageFor(collection, tokenId);

        bytes memory json = abi.encodePacked(
            '{"name":"',
            LibString.escapeJSON(c.name()),
            " #",
            tokenId.toString(),
            '","animation_url":"',
            htmlUri,
            '"',
            bytes(image).length > 0
                ? string(abi.encodePacked(',"image":"', image, '"'))
                : "",
            ',"attributes":',
            _attributes(c, tokenId, seed),
            "}"
        );
        return string(
            abi.encodePacked("data:application/json;base64,", Base64.encode(json))
        );
    }

    function contractURI(address collection) external view override returns (string memory) {
        ICollectionView c = ICollectionView(collection);
        bytes memory json = abi.encodePacked(
            '{"name":"',
            LibString.escapeJSON(c.name()),
            '"',
            bytes(renderAssets.coverOf(collection)).length > 0
                ? string(
                    abi.encodePacked(
                        ',"image":"',
                        LibString.escapeJSON(renderAssets.coverOf(collection)),
                        '"'
                    )
                )
                : "",
            "}"
        );
        return string(
            abi.encodePacked("data:application/json;base64,", Base64.encode(json))
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HTML assembly
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Body tag order per the injection convention: dependencies →
    ///      token context → artist code → gunzip helper LAST when any tag is
    ///      gzipped. The helper (gunzipScripts-0.0.1.js) decompresses at its
    ///      own parse time by scanning the gzip tags that precede it in the
    ///      document and replacing each with an executing script tag, in
    ///      document order; placed first it would find nothing. This matches
    ///      scripty's own gzip examples.
    function _buildHTML(
        address collection,
        uint256 tokenId,
        WorkConfig memory work,
        bytes32 seed
    ) private view returns (string memory) {
        require(work.code.length > 0, "GR: no code");

        bool needsGunzip = _anyGzip(work.deps) || _anyGzip(work.code);
        uint256 n = (needsGunzip ? 1 : 0) + work.deps.length + 1 + work.code.length;
        HTMLTag[] memory body = new HTMLTag[](n);
        uint256 i = 0;

        for (uint256 d = 0; d < work.deps.length; d++) {
            body[i] = _fileTag(work.deps[d]);
            i++;
        }
        body[i].tagType = HTMLTagType.script;
        body[i].tagContent = _contextJs(collection, tokenId, seed, work.injectionVersion);
        i++;
        for (uint256 s = 0; s < work.code.length; s++) {
            body[i] = _fileTag(work.code[s]);
            i++;
        }
        if (needsGunzip) {
            body[i].name = gunzipFile;
            body[i].contractAddress = gunzipStore;
            // EthFS v1 stores files as base64 TEXT (its data-URI design), so
            // the helper must ship as a base64 data-URI script src; inlined
            // raw it is a guaranteed syntax error. Verified against the
            // deployed file's actual bytes.
            body[i].tagType = HTMLTagType.scriptBase64DataURI;
            i++;
        }

        HTMLTag[] memory head = new HTMLTag[](1);
        head[0].tagOpen = "<style>";
        head[0].tagContent = "html,body{margin:0;padding:0;height:100%;overflow:hidden}"
            "canvas{display:block}";
        head[0].tagClose = "</style>";
        head[0].tagType = HTMLTagType.useTagOpenAndClose;

        return scriptyBuilder.getEncodedHTMLString(HTMLRequest({headTags: head, bodyTags: body}));
    }

    function _fileTag(CodeRef memory ref) private pure returns (HTMLTag memory tag) {
        tag.name = ref.name;
        tag.contractAddress = ref.store;
        tag.tagType = ref.kind == CodeKind.ScriptGzip
            ? HTMLTagType.scriptGZIPBase64DataURI
            : HTMLTagType.script;
    }

    function _anyGzip(CodeRef[] memory refs) private pure returns (bool) {
        for (uint256 i = 0; i < refs.length; i++) {
            if (refs[i].kind == CodeKind.ScriptGzip) return true;
        }
        return false;
    }

    /// @dev Render-context convention v1: hash + tokenId, the standard
    ///      long-form-generative tokenData shape for sketch portability. In
    ///      Sequential mode the token id IS the mint order, so art keyed to
    ///      order reads tokenId; works needing other mint-time inputs (block,
    ///      pooled order) record them via a hook/minter and read them through
    ///      their own renderer.
    function _contextJs(
        address collection,
        uint256 tokenId,
        bytes32 seed,
        uint8 version
    ) private view returns (bytes memory) {
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
            uint256(version).toString(),
            "};"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Metadata pieces
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Static image from the RenderAssets registry: the per-token
    ///      capture if one exists, else the collection cover. Escaped; may
    ///      be empty.
    function _imageFor(address collection, uint256 tokenId)
        private
        view
        returns (string memory)
    {
        return LibString.escapeJSON(renderAssets.imageFor(collection, tokenId));
    }

    /// @dev Provenance traits, derived (trait names shared with
    ///      DefaultRenderer): in Sequential mode the token id is the mint
    ///      order, so Mint Order = tokenId. Pooled ids are not mint order, so
    ///      pooled works get the seed only.
    function _attributes(ICollectionView c, uint256 tokenId, bytes32 seed)
        private
        view
        returns (bytes memory)
    {
        bytes memory order = c.idMode() == IdMode.Sequential
            ? abi.encodePacked('{"trait_type":"Mint Order","value":', tokenId.toString(), "},")
            : bytes("");
        return abi.encodePacked(
            "[", order, '{"trait_type":"Seed","value":"', uint256(seed).toHexString(32), '"}]'
        );
    }
}
