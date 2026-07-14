// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceConfig, SurfaceStatus, IdMode} from "../SurfaceTypes.sol";

/// @title IRenderer
/// @notice Swappable metadata renderer. A collection's tokenURI/contractURI
///         delegate here. The collection is an explicit parameter — never
///         msg.sender — so one renderer instance serves every collection,
///         offchain callers can eth_call it directly, and any contract can
///         adopt it by implementing ISurfaceView.
///
///         A renderer is an onchain view with full EVM read access: seeds,
///         owners, sibling tokens, foreign contracts, block state. That reach
///         is what makes network-based works expressible.
interface IRenderer {
    function tokenURI(address collection, uint256 tokenId) external view returns (string memory);

    function contractURI(address collection) external view returns (string memory);
}

/// @title ISurfaceView
/// @notice The read surface a renderer builds metadata from. Surface
///         implements all of it; an adopting contract implements whatever
///         subset its chosen renderer actually reads.
interface ISurfaceView {
    function name() external view returns (string memory);

    function symbol() external view returns (string memory);

    function owner() external view returns (address);

    function totalSupply() external view returns (uint256);

    /// @notice Mint-time entropy, stamped in the mint tx. Reverts NeverMinted
    ///         for an id with no mint; a nonzero seed IS the record.
    function tokenSeed(uint256 tokenId) external view returns (bytes32);

    /// @notice Live config + derived lifecycle status + mints-ever. Enough to
    ///         derive provenance: in Sequential mode the token id IS the mint
    ///         order (first = id 1; final = Closed and id == minted).
    function config() external view returns (SurfaceConfig memory cfg, SurfaceStatus status, uint256 minted);

    function idMode() external view returns (IdMode);
}
