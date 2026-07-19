// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ISurfaceCore} from "./ISurfaceCore.sol";

/// @title IPooledSurface
/// @notice Pooled ERC721 collection (tokenId == sourceId): the authorized
///         minter chooses every id and is the only caller that can burn. No
///         built-in paid mint entrypoint; mints go through the minter.
interface IPooledSurface is ISurfaceCore {
    /// @notice Authorized minters only. Mints a specific id (id 0 is valid).
    ///         A burned id can be minted again as a new instance with fresh
    ///         entropy; the prior instance's history remains in the event log.
    ///         Runs hooks.
    function mintToId(address to, uint256 tokenId, address referrer, bytes calldata hookData) external;
}
