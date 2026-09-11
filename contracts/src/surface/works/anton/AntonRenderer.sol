// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {LibString} from "solady/utils/LibString.sol";
import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";

import {ScriptyRenderer} from "../../templates/ScriptyRenderer.sol";
import {ISurfaceView} from "../../interfaces/IRenderer.sol";
import {IdMode} from "../../SurfaceTypes.sol";
import {CodeRef} from "../../templates/CodeTypes.sol";

/// @title AntonRenderer
/// @notice The anton work's renderer. A chain-live ScriptyRenderer: everything
///         about a token derives from its seed (fully generative), and the
///         current owner drives the wallet-synced shape/background TIMING. The
///         owner is injected into the render context; palette + tone are
///         published as onchain traits, derived from the seed the SAME way the
///         JS derives them: `palette = seed % 10`, `tone = (seed >> 8) % 2`.
///         Keep those two formulas in lockstep with anton.js.
///
///         Because the render depends on the current owner (state a pre-mint
///         preview cannot fake), the inherited `previewURI` is not faithful for
///         this work; it still assembles a document (owner defaulted to zero for
///         a nonexistent id) so a try/catch preview probe resolves cleanly.
contract AntonRenderer is ScriptyRenderer {
    using LibString for uint256;
    using LibString for address;

    string[] private _paletteNames;
    string[] private _toneNames;

    constructor(
        address scriptyBuilder_,
        address gunzipStore_,
        string memory gunzipFile_,
        CodeRef[] memory code_,
        CodeRef[] memory deps_,
        uint8 injectionVersion_,
        address renderAssets_
    ) ScriptyRenderer(scriptyBuilder_, gunzipStore_, gunzipFile_, code_, deps_, injectionVersion_, renderAssets_) {
        _paletteNames = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
        _toneNames = ["sun", "moon"];
    }

    /// @dev Standard render context plus `owner` (drives the wallet-synced
    ///      shape/background timing). Owner is read live; on a nonexistent token
    ///      (a preview probe) it defaults to zero.
    function _contextJs(address collection, uint256 tokenId, bytes32 seed, string memory context)
        internal
        view
        override
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
            '","owner":"',
            _ownerOrZero(collection, tokenId).toHexString(),
            '"};'
        );
    }

    /// @dev Seed-derived traits: Mint Order (Sequential), Seed, Palette, Tone.
    function _attributes(ISurfaceView c, uint256 tokenId, bytes32 seed)
        internal
        view
        override
        returns (bytes memory)
    {
        uint256 s = uint256(seed);
        string memory palette = _paletteNames[s % _paletteNames.length];
        string memory tone = _toneNames[(s >> 8) % _toneNames.length];
        bytes memory order = c.idMode() == IdMode.Sequential
            ? abi.encodePacked('{"trait_type":"Mint Order","value":', tokenId.toString(), "},")
            : bytes("");
        return abi.encodePacked(
            "[",
            order,
            '{"trait_type":"Seed","value":"',
            s.toHexString(32),
            '"},{"trait_type":"Palette","value":"',
            palette,
            '"},{"trait_type":"Tone","value":"',
            tone,
            '"}]'
        );
    }

    function _ownerOrZero(address collection, uint256 tokenId) private view returns (address) {
        try IERC721(collection).ownerOf(tokenId) returns (address o) {
            return o;
        } catch {
            return address(0);
        }
    }
}
