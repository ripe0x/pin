// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {MintMark, WorkConfig, IdMode} from "../CollectionTypes.sol";

/// @title IRenderer
/// @notice Swappable metadata renderer. A collection's tokenURI/contractURI
///         delegate to its renderer. The collection is an explicit parameter
///         (not msg.sender) so one renderer instance serves every collection,
///         offchain callers can eth_call it directly for any collection, and
///         any contract can adopt it by implementing ICollectionView.
///
///         Renderers are onchain views with full EVM read access: seed,
///         owner, sibling tokens, companion state, foreign contracts, block
///         state. That is what makes network-based works expressible.
interface IRenderer {
    function tokenURI(address collection, uint256 tokenId)
        external
        view
        returns (string memory);

    function contractURI(address collection) external view returns (string memory);
}

/// @title ICollectionView
/// @notice The read surface a renderer uses to build metadata. Implemented in
///         full by Collection; any adopting contract implements
///         whatever subset its chosen renderer actually reads.
interface ICollectionView {
    function name() external view returns (string memory);

    function symbol() external view returns (string memory);

    function owner() external view returns (address);

    function totalSupply() external view returns (uint256);

    /// @notice Mint-time entropy for a token, stamped in the mint tx.
    function tokenSeed(uint256 tokenId) external view returns (bytes32);

    /// @notice Derived Mint Mark for a token (provenance).
    function mintMarkOf(uint256 tokenId) external view returns (MintMark memory);

    /// @notice The collection's shared/cover artwork URI.
    function artwork() external view returns (string memory);

    /// @notice Per-token artwork override ("" if none set).
    function tokenArtwork(uint256 tokenId) external view returns (string memory);

    /// @notice What the work is, executably (empty for renderer-native works).
    function workConfig() external view returns (WorkConfig memory);

    function isWorkLocked() external view returns (bool);

    function idMode() external view returns (IdMode);
}
