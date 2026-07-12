// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {LibString} from "solady/utils/LibString.sol";

import {IRenderer, ICollectionView} from "../interfaces/IRenderer.sol";
import {MetadataJson} from "./MetadataJson.sol";
import {RenderAssets} from "./RenderAssets.sol";

/// @title DefaultRenderer
/// @notice The renderer every collection starts with. One immutable,
///         ownerless instance serves them all: it reads the collection's own
///         views (the collection is a parameter, never msg.sender), fetches
///         the image from RenderAssets, and answers with a base64 JSON data
///         URI — the artwork plus derived provenance traits. A collection
///         that wants per-token or generative art points its renderer slot
///         somewhere else.
contract DefaultRenderer is IRenderer {
    using LibString for uint256;

    error AssetsRequired();

    /// @notice Where the cover and per-token captures live; the collection
    ///         core stores no presentation data at all.
    RenderAssets public immutable renderAssets;

    constructor(address renderAssets_) {
        if (renderAssets_ == address(0)) revert AssetsRequired();
        renderAssets = RenderAssets(renderAssets_);
    }

    string private constant DESCRIPTION = "A Collection token. Its entry into the collection is recorded onchain.";

    function tokenURI(address collection, uint256 tokenId) external view override returns (string memory) {
        ICollectionView cv = ICollectionView(collection);

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

    function contractURI(address collection) external view override returns (string memory) {
        string memory json = string.concat('{"name":"', MetadataJson.escape(ICollectionView(collection).name()), '"}');
        return MetadataJson.jsonDataURI(json);
    }
}
