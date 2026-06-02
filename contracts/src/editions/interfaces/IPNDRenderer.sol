// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {MintMark} from "../PNDEditionsTypes.sol";

/// @title IPNDRenderer
/// @notice Zora-style swappable metadata renderer. A PNDEditions project's
///         tokenURI/contractURI delegate to the resolved renderer (per-release
///         override, else project renderer, else the built-in default). A
///         renderer reads project state back from `msg.sender` (the calling
///         project) via IPNDEditionsView, so one default renderer instance is
///         shared by every project.
interface IPNDRenderer {
    function tokenURI(uint256 tokenId) external view returns (string memory);

    function contractURI() external view returns (string memory);
}

/// @title IPNDEditionsView
/// @notice The read surface a renderer uses to build metadata for the project
///         that called it (msg.sender).
interface IPNDEditionsView {
    function name() external view returns (string memory);

    function symbol() external view returns (string memory);

    function owner() external view returns (address);

    function totalSupply() external view returns (uint256);

    /// @notice Derived Mint Mark for a token (provenance).
    function mintMarkOf(uint256 tokenId) external view returns (MintMark memory);

    /// @notice The release a token belongs to.
    function releaseOf(uint256 tokenId) external view returns (uint256);

    /// @notice The shared default artwork URI for a release.
    function releaseArtwork(uint256 releaseId) external view returns (string memory);

    /// @notice Per-token artwork override ("" if none set).
    function tokenArtwork(uint256 tokenId) external view returns (string memory);
}
