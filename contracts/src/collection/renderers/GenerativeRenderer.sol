// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {IRenderer, ICollectionView} from "../interfaces/IRenderer.sol";
import {CodeKind, CodeRef, MintMark, WorkConfig} from "../CollectionTypes.sol";
import {IScriptyBuilderV2} from "../vendor/scripty/interfaces/IScriptyBuilderV2.sol";
import {HTMLRequest, HTMLTag, HTMLTagType} from "../vendor/scripty/core/ScriptyStructs.sol";

/// @title GenerativeRenderer
/// @notice The default renderer for script-based generative collections. A
///         stateless singleton: reads a collection's WorkConfig and a token's
///         seed, assembles a complete HTML document via ScriptyBuilderV2
///         (dependencies from onchain storage + the injected token context +
///         the artist's code), and returns tokenURI JSON whose animation_url
///         is a data:text/html;base64 URI. The live view is a pure function
///         of chain state: no server, no pin, nothing to keep alive.
///
///         The injected context implements docs/injection-convention.md v1:
///         window.tokenData = { hash, tokenId, mintIndex, mintBlock,
///         collection, chainId, version } — hash/tokenId are Art
///         Blocks-compatible so existing AB-style sketches run unmodified.
///
/// @dev    Immutable configuration only; per-work variability lives entirely
///         in each collection's WorkConfig. Anyone may point any contract
///         implementing ICollectionView at this renderer.
contract GenerativeRenderer is IRenderer {
    using LibString for uint256;
    using LibString for address;

    /// @notice The scripty v2 builder that assembles the HTML.
    IScriptyBuilderV2 public immutable scriptyBuilder;

    /// @notice Storage contract + file name of the gunzip helper, emitted as
    ///         the first body tag whenever any dep/code file is gzipped.
    address public immutable gunzipStore;
    string public gunzipFile;

    constructor(address scriptyBuilder_, address gunzipStore_, string memory gunzipFile_) {
        require(scriptyBuilder_ != address(0), "GR: builder required");
        require(gunzipStore_ != address(0), "GR: gunzip store required");
        scriptyBuilder = IScriptyBuilderV2(scriptyBuilder_);
        gunzipStore = gunzipStore_;
        gunzipFile = gunzipFile_;
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
        WorkConfig memory work = c.workConfig();
        MintMark memory mark = c.mintMarkOf(tokenId);
        bytes32 seed = c.tokenSeed(tokenId);

        // getEncodedHTMLString returns a complete data:text/html;base64 URI.
        string memory htmlUri = _buildHTML(collection, tokenId, work, mark, seed);
        string memory image = _imageFor(c, tokenId);

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
            _attributes(mark, seed),
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
            bytes(c.artwork()).length > 0
                ? string(abi.encodePacked(',"image":"', LibString.escapeJSON(c.artwork()), '"'))
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
        MintMark memory mark,
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
        body[i].tagContent = _contextJs(collection, tokenId, mark, seed, work.injectionVersion);
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

    /// @dev docs/injection-convention.md v1. hash/tokenId shapes match Art
    ///      Blocks' tokenData for sketch portability.
    function _contextJs(
        address collection,
        uint256 tokenId,
        MintMark memory mark,
        bytes32 seed,
        uint8 version
    ) private view returns (bytes memory) {
        return abi.encodePacked(
            'window.tokenData={"hash":"',
            uint256(seed).toHexString(32),
            '","tokenId":"',
            tokenId.toString(),
            '","mintIndex":',
            uint256(mark.mintIndex).toString(),
            ',"mintBlock":',
            uint256(mark.mintBlock).toString(),
            ',"collection":"',
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

    /// @dev Static image: the per-token override (a capture, once one exists)
    ///      else the collection cover. Escaped; may be empty.
    function _imageFor(ICollectionView c, uint256 tokenId) private view returns (string memory) {
        string memory art = c.tokenArtwork(tokenId);
        if (bytes(art).length == 0) art = c.artwork();
        return LibString.escapeJSON(art);
    }

    /// @dev Mint Mark provenance (trait names shared with DefaultRenderer)
    ///      plus the seed.
    function _attributes(MintMark memory mark, bytes32 seed)
        private
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            '[{"trait_type":"Mint Order","value":',
            uint256(mark.mintIndex + 1).toString(),
            '},{"trait_type":"Mint Block","value":',
            uint256(mark.mintBlock).toString(),
            '},{"trait_type":"Seed","value":"',
            uint256(seed).toHexString(32),
            '"}]'
        );
    }
}
