// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {IRenderer, ICollectionView} from "../interfaces/IRenderer.sol";
import {MetadataJson} from "./MetadataJson.sol";

/// @title SVGRenderer
/// @notice Abstract base for fully onchain Solidity-SVG works. It handles the
///         whole metadata envelope and leaves exactly one function for the
///         art: `svg(collection, tokenId)`. A concrete work inherits this,
///         draws, and optionally overrides the name/description/attributes
///         hooks. The collection is a parameter, not msg.sender, so one
///         deployed instance can serve every collection that shares the
///         algorithm.
abstract contract SVGRenderer is IRenderer {
    using LibString for uint256;

    /// @notice The art itself. Must return a complete `<svg ...>...</svg>`
    ///         document — not encoded, not wrapped. The base handles the
    ///         envelope.
    function svg(address collection, uint256 tokenId) internal view virtual returns (string memory);

    /// @notice Token name hook. Default: "{collection name} #{tokenId}".
    function tokenName(address collection, uint256 tokenId) internal view virtual returns (string memory) {
        return string.concat(MetadataJson.escape(ICollectionView(collection).name()), " #", tokenId.toString());
    }

    /// @notice Token description hook. Default: empty (field omitted).
    function tokenDescription(
        address,
        /* collection */
        uint256 /* tokenId */
    )
        internal
        view
        virtual
        returns (string memory)
    {
        return "";
    }

    /// @notice Attributes hook. Default: the derived provenance traits.
    ///         Override to add work-specific traits alongside or instead.
    function attributes(address collection, uint256 tokenId) internal view virtual returns (string memory) {
        return MetadataJson.provenanceAttributes(ICollectionView(collection), tokenId);
    }

    // ── IRenderer ──────────────────────────────────────────────────────────

    function tokenURI(address collection, uint256 tokenId) external view override returns (string memory) {
        string memory image =
            string.concat("data:image/svg+xml;base64,", Base64.encode(bytes(svg(collection, tokenId))));

        string memory desc = tokenDescription(collection, tokenId);
        string memory json = string.concat(
            '{"name":"',
            tokenName(collection, tokenId),
            '"',
            bytes(desc).length > 0 ? string.concat(',"description":"', MetadataJson.escape(desc), '"') : "",
            ',"image":"',
            image,
            '","attributes":',
            attributes(collection, tokenId),
            "}"
        );
        return MetadataJson.jsonDataURI(json);
    }

    function contractURI(address collection) external view override returns (string memory) {
        string memory json = string.concat('{"name":"', MetadataJson.escape(ICollectionView(collection).name()), '"}');
        return MetadataJson.jsonDataURI(json);
    }
}
