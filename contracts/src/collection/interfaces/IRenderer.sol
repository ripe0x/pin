// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {CollectionConfig, CollectionStatus, IdMode} from "../CollectionTypes.sol";

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

    /// @notice Whether `account` holds an explicit admin grant (owner is an
    ///         implicit admin). Renderer-side registries (work config,
    ///         RenderAssets) borrow this as their write authority.
    function isAdmin(address account) external view returns (bool);

    function totalSupply() external view returns (uint256);

    /// @notice Mint-time entropy for a token, stamped in the mint tx.
    ///         Reverts NeverMinted for an id with no mint; a nonzero seed is
    ///         the was-ever-minted sentinel.
    function tokenSeed(uint256 tokenId) external view returns (bytes32);

    /// @notice Live config + derived lifecycle status + mints-ever. A
    ///         renderer derives provenance from these: in Sequential mode the
    ///         token id IS the mint order (first = id 1; final = Closed and
    ///         id == minted). Pooled works record their own mint-time data
    ///         via a hook/minter if their art needs it.
    function config()
        external
        view
        returns (CollectionConfig memory cfg, CollectionStatus status, uint256 minted);





    function idMode() external view returns (IdMode);
}
