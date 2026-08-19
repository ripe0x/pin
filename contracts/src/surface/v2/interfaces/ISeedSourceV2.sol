// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title ISeedSourceV2
/// @notice External seed provider a SurfaceV2 collection falls back to for a
///         token with no stored seed: seedSource set at init and no minter-
///         supplied seed written for that token id. May revert, for example a
///         reveal-based source queried before its epoch resolves.
interface ISeedSourceV2 {
    /// @notice Seed for `tokenId` of `collection`. Reverts instead of
    ///         returning a value when the source has none yet.
    function seedOf(address collection, uint256 tokenId) external view returns (bytes32);
}
