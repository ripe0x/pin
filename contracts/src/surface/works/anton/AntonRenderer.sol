// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {LibString} from "solady/utils/LibString.sol";
import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";

import {ScriptyRenderer} from "../../templates/ScriptyRenderer.sol";
import {ISurfaceView} from "../../interfaces/IRenderer.sol";
import {CodeRef, MetadataText} from "../../templates/CodeTypes.sol";

/// @title AntonRenderer
/// @notice The anton work's renderer. A chain-live ScriptyRenderer: everything
///         about a token derives from its seed (fully generative), and the
///         current owner drives the wallet-synced shape/background TIMING. The
///         owner is injected into the render context; palette, mode and flow
///         are published as onchain traits (the palette as its name), derived
///         from the seed the SAME way the JS derives them: `palette = seed % 10`,
///         `mode = (seed >> 8) & 1`, `flow = (seed >> 16) & 1`. Keep those
///         formulas in lockstep with anton.js.
///
///         Because the render depends on the current owner (state a pre-mint
///         preview cannot fake), the inherited `previewURI` is not faithful for
///         this work; it still assembles a document (owner defaulted to zero for
///         a nonexistent id) so a try/catch preview probe resolves cleanly.
contract AntonRenderer is ScriptyRenderer {
    using LibString for uint256;
    using LibString for address;

    string[] private _paletteNames;
    string[] private _modeNames;
    string[] private _flowNames;

    constructor(
        address scriptyBuilder_,
        address gunzipStore_,
        string memory gunzipFile_,
        CodeRef[] memory code_,
        CodeRef[] memory deps_,
        uint8 injectionVersion_,
        address renderAssets_,
        MetadataText memory metadataText_
    )
        ScriptyRenderer(
            scriptyBuilder_, gunzipStore_, gunzipFile_, code_, deps_, injectionVersion_, renderAssets_, metadataText_
        )
    {
        _paletteNames = [
            "Celestial Azure",
            "Purple Thunder",
            "Jade Mist",
            "Fiery Origin",
            "Twilight Amber",
            "Lunar Depth",
            "Turquoise Current",
            "Rose Ash",
            "Sapphire Silence",
            "Golden Rift"
        ];
        _modeNames = ["Sun", "Moon"];
        _flowNames = ["down", "up"];
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

    /// @dev Attributes: Palette, Mode and Flow, derived from the seed. Overrides
    ///      the base's Mint Order and Seed provenance traits, which this work
    ///      does not publish. Derivation matches anton.js: palette = seed % 10,
    ///      mode = (seed >> 8) & 1, flow = (seed >> 16) & 1. Keep in lockstep.
    function _attributes(
        ISurfaceView, /* c */
        uint256, /* tokenId */
        bytes32 seed
    ) internal view override returns (bytes memory) {
        uint256 s = uint256(seed);
        string memory palette = _paletteNames[s % _paletteNames.length];
        string memory mode = _modeNames[(s >> 8) & 1];
        string memory flow = _flowNames[(s >> 16) & 1];
        return abi.encodePacked(
            '[{"trait_type":"Palette","value":"',
            palette,
            '"},{"trait_type":"Mode","value":"',
            mode,
            '"},{"trait_type":"Flow","value":"',
            flow,
            '"}]'
        );
    }

    /// @dev Metadata copy resolves to the RenderAssets override when set, else
    ///      the baked default. Lets the collection owner/admin edit the copy
    ///      post-deploy via RenderAssets.setText, keyed by collection, with no
    ///      redeploy. "" in RenderAssets means unset, so the default stands.
    function _resolveTokenDescription(address collection) internal view override returns (string memory) {
        if (address(renderAssets) != address(0)) {
            string memory t = renderAssets.tokenDescriptionOf(collection);
            if (bytes(t).length > 0) return t;
        }
        return super._resolveTokenDescription(collection);
    }

    function _resolveCollectionDescription(address collection) internal view override returns (string memory) {
        if (address(renderAssets) != address(0)) {
            string memory t = renderAssets.collectionDescriptionOf(collection);
            if (bytes(t).length > 0) return t;
        }
        return super._resolveCollectionDescription(collection);
    }

    function _resolveExternalUrl(address collection) internal view override returns (string memory) {
        if (address(renderAssets) != address(0)) {
            string memory t = renderAssets.externalUrlOf(collection);
            if (bytes(t).length > 0) return t;
        }
        return super._resolveExternalUrl(collection);
    }

    function _ownerOrZero(address collection, uint256 tokenId) private view returns (address) {
        try IERC721(collection).ownerOf(tokenId) returns (address o) {
            return o;
        } catch {
            return address(0);
        }
    }
}
