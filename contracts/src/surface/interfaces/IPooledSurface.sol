// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ISurfaceCore} from "./ISurfaceCore.sol";

/// @title IPooledSurface
/// @notice The pooled collection — for backed and sourced forms (tokenId ==
///         sourceId). Its authorized minter owns the id pool: it chooses
///         every id, and it alone can burn, so nothing outside the pool's
///         economics can strand a token's backing. There is no public sale
///         entrypoint here at all; a pooled work sells through its minter.
interface IPooledSurface is ISurfaceCore {
    /// @notice Authorized minters only: mint a specific id (id 0 is legal).
    ///         A burned id mints again as a NEW instance with fresh entropy;
    ///         the prior instance's history stays in the log. Hooks run.
    function mintToId(address to, uint256 tokenId, address referrer, bytes calldata hookData) external;
}
