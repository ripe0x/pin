// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {LibString} from "solady/utils/LibString.sol";
import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";

import {ScriptyRenderer} from "../../templates/ScriptyRenderer.sol";
import {ISurfaceView} from "../../interfaces/IRenderer.sol";
import {IdMode} from "../../SurfaceTypes.sol";
import {CodeRef} from "../../templates/CodeTypes.sol";
import {AntonParams} from "./AntonParams.sol";

/// @title AntonRenderer
/// @notice The anton work's renderer. A chain-live ScriptyRenderer: the minted
///         identity (palette, tone) is read from AntonParams and the current
///         owner is read for the wallet-synced shape morph and background drift.
///         All three are injected beyond the standard render context; the
///         palette and tone are published as onchain traits. (Shape and
///         background are not per-token state — they morph over time in the JS,
///         synced to the owner — so they are not traits.)
///
///         Because the render depends on state a pre-mint preview cannot fake
///         (the chosen identity, the owner), this work has no faithful onchain
///         preview; the offchain mint surface builds the byte-equivalent
///         document. The inherited `previewURI` still assembles a document
///         (owner defaulted when a token does not exist), so the try/catch
///         preview probe resolves cleanly rather than reverting.
///
///         The palette/tone name vocabularies below MUST match the work's JS
///         exactly (same order, same strings): the minter stores an index, this
///         renderer maps it to a name, and the JS looks the name up.
contract AntonRenderer is ScriptyRenderer {
    using LibString for uint256;
    using LibString for address;

    /// @notice The params registry read for each token's identity.
    AntonParams public immutable params;

    string[] private _paletteNames;
    string[] private _toneNames;

    constructor(
        address scriptyBuilder_,
        address gunzipStore_,
        string memory gunzipFile_,
        CodeRef[] memory code_,
        CodeRef[] memory deps_,
        uint8 injectionVersion_,
        address renderAssets_,
        address params_
    ) ScriptyRenderer(scriptyBuilder_, gunzipStore_, gunzipFile_, code_, deps_, injectionVersion_, renderAssets_) {
        params = AntonParams(params_);
        _paletteNames = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
        _toneNames = ["sun", "moon"];
    }

    /// @dev Extended render context: the standard fields plus `owner` (drives
    ///      the synced shape morph + background drift) and `params` (palette +
    ///      tone). Owner is read live; on a nonexistent token (a preview probe)
    ///      it defaults to zero.
    function _contextJs(address collection, uint256 tokenId, bytes32 seed, string memory context)
        internal
        view
        override
        returns (bytes memory)
    {
        bytes memory head = abi.encodePacked(
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
            '"'
        );
        return abi.encodePacked(
            head,
            ',"owner":"',
            _ownerOrZero(collection, tokenId).toHexString(),
            '",',
            _paramsJson(collection, tokenId),
            "};"
        );
    }

    /// @dev The `"params":{...}` fragment of the render context.
    function _paramsJson(address collection, uint256 tokenId) private view returns (bytes memory) {
        (string memory palette, string memory tone) = _resolveParams(collection, tokenId);
        return abi.encodePacked('"params":{"palette":"', palette, '","tone":"', tone, '"}');
    }

    /// @dev Identity traits: Mint Order (Sequential), Seed, Palette, Tone.
    function _attributes(ISurfaceView c, uint256 tokenId, bytes32 seed)
        internal
        view
        override
        returns (bytes memory)
    {
        (string memory palette, string memory tone) = _resolveParams(address(c), tokenId);
        bytes memory order = c.idMode() == IdMode.Sequential
            ? abi.encodePacked('{"trait_type":"Mint Order","value":', tokenId.toString(), "},")
            : bytes("");
        return abi.encodePacked(
            "[",
            order,
            '{"trait_type":"Seed","value":"',
            uint256(seed).toHexString(32),
            '"},{"trait_type":"Palette","value":"',
            palette,
            '"},{"trait_type":"Tone","value":"',
            tone,
            '"}]'
        );
    }

    /// @dev Map a token's stored indices to names, falling back to the first of
    ///      each vocabulary when no entry is set (a preview of an unminted id).
    function _resolveParams(address collection, uint256 tokenId)
        private
        view
        returns (string memory palette, string memory tone)
    {
        (bool set, uint8 p, uint8 t) = params.paramsOf(collection, tokenId);
        if (!set) return (_paletteNames[0], _toneNames[0]);
        return (_paletteNames[p], _toneNames[t]);
    }

    function _ownerOrZero(address collection, uint256 tokenId) private view returns (address) {
        try IERC721(collection).ownerOf(tokenId) returns (address o) {
            return o;
        } catch {
            return address(0);
        }
    }
}
