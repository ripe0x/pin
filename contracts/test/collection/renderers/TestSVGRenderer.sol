// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {LibString} from "solady/utils/LibString.sol";

import {SVGRenderer} from "../../../src/collection/renderers/SVGRenderer.sol";
import {ICollectionView} from "../../../src/collection/interfaces/IRenderer.sol";

/// @title TestSVGRenderer
/// @notice Minimal concrete SVGRenderer used only by the renderer test suite.
///         Renders a single `<rect>` whose fill color is derived from the
///         token's tokenSeed, so tests can assert the seed actually reaches
///         the art (the whole point of an onchain-SVG work: the render is a
///         pure function of collection state, not an offchain pointer).
contract TestSVGRenderer is SVGRenderer {
    using LibString for uint256;

    function svg(address collection, uint256 tokenId)
        internal
        view
        override
        returns (string memory)
    {
        bytes32 seed = ICollectionView(collection).tokenSeed(tokenId);
        // Derive a 6-hex-digit fill straight from the seed.
        string memory fill = LibString.toHexStringNoPrefix(uint256(seed) & 0xffffff, 3);
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
            '<rect width="100" height="100" fill="#',
            fill,
            '"/></svg>'
        );
    }
}
