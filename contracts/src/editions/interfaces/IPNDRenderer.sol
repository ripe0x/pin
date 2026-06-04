// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {MintMark} from "../PNDEditionsTypes.sol";

/// @title IPNDRenderer
/// @notice Zora-style swappable metadata renderer. An edition's
///         tokenURI/contractURI delegate to the resolved renderer (the
///         edition's own renderer, else the built-in default). A renderer
///         reads edition state back from `msg.sender` (the calling edition)
///         via IPNDEditionsView, so one default renderer instance is shared by
///         every edition.
interface IPNDRenderer {
    function tokenURI(uint256 tokenId) external view returns (string memory);

    function contractURI() external view returns (string memory);
}

/// @title IPNDEditionsView
/// @notice The read surface a renderer uses to build metadata for the edition
///         that called it (msg.sender).
interface IPNDEditionsView {
    function name() external view returns (string memory);

    function symbol() external view returns (string memory);

    function owner() external view returns (address);

    function totalSupply() external view returns (uint256);

    /// @notice Derived Mint Mark for a token (provenance).
    function mintMarkOf(uint256 tokenId) external view returns (MintMark memory);

    /// @notice The edition's shared default artwork URI.
    function artwork() external view returns (string memory);

    /// @notice Per-token artwork override ("" if none set).
    function tokenArtwork(uint256 tokenId) external view returns (string memory);
}
