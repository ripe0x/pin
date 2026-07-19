// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ISurfaceCore} from "./ISurfaceCore.sol";

/// @title ISurface
/// @notice Sequential-id ERC721 collection.
interface ISurface is ISurfaceCore {
    /// @notice Authorized minters only. Non-payable; the calling minter
    ///         handles all economics. Mints `quantity` tokens with ids
    ///         `firstTokenId .. firstTokenId + quantity - 1` in one call, one
    ///         Minted event. Reverts ZeroQuantity on a zero quantity.
    function mintTo(address to, uint256 quantity) external returns (uint256 firstTokenId);
}
