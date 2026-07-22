// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ISurfaceCore} from "./ISurfaceCore.sol";

/// @title IPooledSurface
/// @notice ERC721 collection with minter-assigned ids, for collections whose
///         token id mirrors an external source id: one authorized minter
///         chooses every id and is the only address that can burn. No built-in
///         mint economics; minting goes through the minter.
interface IPooledSurface is ISurfaceCore {
    /// @notice Authorized minters only. Mints a specific id (id 0 is valid).
    ///         An authorized minter can mint a burned id again as a new
    ///         instance with fresh entropy; the previous instance's history
    ///         stays in the event log.
    function mintToId(address to, uint256 tokenId) external;
}
