// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {LibString} from "solady/utils/LibString.sol";

import {IRenderer, ISurfaceView} from "../interfaces/IRenderer.sol";
import {MetadataJson} from "./MetadataJson.sol";
import {RenderAssets} from "./RenderAssets.sol";

/// @title DefaultRenderer
/// @notice Default tokenURI renderer wired into new collections by the
///         factory. Immutable, ownerless, and shared across collections: reads
///         the collection's views (the collection is passed as a parameter,
///         never msg.sender), fetches the image from RenderAssets, and returns
///         a base64-encoded JSON data URI with the image and derived
///         provenance traits. A collection can point its renderer slot
///         elsewhere for per-token or generative output.
contract DefaultRenderer is IRenderer {
    using LibString for uint256;

    error AssetsRequired();

    /// @notice RenderAssets instance holding the cover and per-token captures.
    ///         The collection core stores no presentation data.
    RenderAssets public immutable renderAssets;

    constructor(address renderAssets_) {
        if (renderAssets_ == address(0)) revert AssetsRequired();
        renderAssets = RenderAssets(renderAssets_);
    }

    string private constant DESCRIPTION = "A Surface token. Its entry into the collection is recorded onchain.";

    function tokenURI(address collection, uint256 tokenId) external view override returns (string memory) {
        ISurfaceView cv = ISurfaceView(collection);

        string memory art = renderAssets.imageFor(collection, tokenId);

        string memory json = string.concat(
            '{"name":"',
            MetadataJson.escape(cv.name()),
            " #",
            tokenId.toString(),
            '","description":"',
            DESCRIPTION,
            '","image":"',
            MetadataJson.escape(art),
            '","attributes":',
            MetadataJson.provenanceAttributes(cv, tokenId),
            "}"
        );
        return MetadataJson.jsonDataURI(json);
    }

    /// @dev Contract-level metadata for the marketplace collection page.
    ///      Includes the cover image when one is set.
    function contractURI(address collection) external view override returns (string memory) {
        string memory cover = renderAssets.coverOf(collection);
        string memory json = string.concat(
            '{"name":"',
            MetadataJson.escape(ISurfaceView(collection).name()),
            '"',
            bytes(cover).length > 0 ? string.concat(',"image":"', MetadataJson.escape(cover), '"') : "",
            "}"
        );
        return MetadataJson.jsonDataURI(json);
    }
}
