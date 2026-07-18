// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IMintHook} from "../interfaces/IMintHook.sol";
import {ISurfaceAuth} from "../interfaces/ISurfaceAuth.sol";

/// @title HookBase
/// @notice Shared base for the reference mint hooks. One deployed instance
///         serves many collections, keyed by msg.sender (the calling
///         collection) in the mint callbacks. Configuring a hook for a
///         collection requires the same key as that collection's own setters:
///         its owner or an admin. Hooks only gate or record; they never touch
///         funds.
abstract contract HookBase is IMintHook {
    error NotSurfaceAdmin();

    /// @dev Same authority root as the collection's own setters: owner or admin.
    modifier onlySurfaceAdmin(address collection) {
        if (msg.sender != ISurfaceAuth(collection).owner() && !ISurfaceAuth(collection).isAdmin(msg.sender)) {
            revert NotSurfaceAdmin();
        }
        _;
    }

    /// @dev Default afterMint is a no-op. Hooks that record state override it.
    function afterMint(address, uint256, uint256, address, bytes calldata) external virtual {}
}
