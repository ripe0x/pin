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
/// @notice The anton work's renderer. A chain-live ScriptyRenderer: the image
///         is a function of owner-mutable params (read from AntonParams) and
///         the current owner (read for the animation pace), not the token seed.
///         It injects those two beyond the standard render context, and
///         publishes the chosen params as onchain traits.
///
///         Because the render depends on state a pre-mint preview cannot fake
///         (the chosen params, the owner), this work has no faithful onchain
///         preview; the offchain mint surface builds the byte-equivalent
///         document from the selection being previewed. The inherited
///         `previewURI` still assembles a document (owner defaulted when a
///         token does not exist), so the try/catch preview probe resolves
///         cleanly rather than reverting.
///
///         The name vocabularies below MUST match the work's JS exactly (same
///         order, same strings): the minter stores an index, this renderer maps
///         it to a name, and the JS looks the name up. A mismatch renders the
///         wrong variant.
contract AntonRenderer is ScriptyRenderer {
    using LibString for uint256;
    using LibString for address;

    /// @notice The params registry read for each token's selection.
    AntonParams public immutable params;

    string[] private _paletteNames;
    string[] private _shapeNames;
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
        _shapeNames = [
            "halo",
            "arch",
            "wide",
            "bloom",
            "opal",
            "curved-circle",
            "rounded-trapezoid",
            "arrow",
            "opal-2",
            "droplet",
            "square",
            "opal-3",
            "rounded-triangle",
            "onyx",
            "soft-oval",
            "shard-x",
            "shard-y",
            "needle-veil",
            "beam"
        ];
        _toneNames = ["sun", "moon"];
    }

    /// @dev Extended render context: the standard fields plus `owner` (drives
    ///      animation pace) and `params` (drives the composition). Owner is read
    ///      live; on a nonexistent token (a preview probe) it defaults to zero.
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
        (string memory palette, string memory shape, string memory tone, bool bgOnly) =
            _resolveParams(collection, tokenId);
        return abi.encodePacked(
            '"params":{"palette":"',
            palette,
            '","shape":"',
            shape,
            '","tone":"',
            tone,
            '","bgOnly":',
            bgOnly ? "true" : "false",
            "}"
        );
    }

    /// @dev Params-based traits, not seed-based: Mint Order (Sequential), Seed,
    ///      then the chosen Palette / Shape / Tone.
    function _attributes(ISurfaceView c, uint256 tokenId, bytes32 seed)
        internal
        view
        override
        returns (bytes memory)
    {
        (string memory palette, string memory shape, string memory tone,) = _resolveParams(address(c), tokenId);
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
            '"},{"trait_type":"Shape","value":"',
            shape,
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
        returns (string memory palette, string memory shape, string memory tone, bool bgOnly)
    {
        (bool set, uint8 p, uint8 s, uint8 t, bool bg) = params.paramsOf(collection, tokenId);
        if (!set) return (_paletteNames[0], _shapeNames[0], _toneNames[0], false);
        return (_paletteNames[p], _shapeNames[s], _toneNames[t], bg);
    }

    function _ownerOrZero(address collection, uint256 tokenId) private view returns (address) {
        try IERC721(collection).ownerOf(tokenId) returns (address o) {
            return o;
        } catch {
            return address(0);
        }
    }
}
