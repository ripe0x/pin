// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IMintHook} from "../interfaces/IMintHook.sol";
import {ICollectionAuth} from "../interfaces/ICollectionAuth.sol";

/// @title HookBase
/// @notice Shared base for the reference mint hooks. These hooks are public
///         goods: one deployed instance serves many collections, keyed by
///         msg.sender (the calling collection) in the mint callbacks.
///         Configuring a hook for a collection needs the same key as that
///         collection's own setters — its owner or an admin. Hooks only gate
///         or record; they never touch funds.
abstract contract HookBase is IMintHook {
    error NotCollectionAdmin();

    /// @dev Same authority root as the collection's own setters.
    modifier onlyCollectionAdmin(address collection) {
        if (msg.sender != ICollectionAuth(collection).owner() && !ICollectionAuth(collection).isAdmin(msg.sender)) {
            revert NotCollectionAdmin();
        }
        _;
    }

    /// @dev Default afterMint is a no-op. Hooks that record state override it.
    function afterMint(address, uint256, uint256, address, bytes calldata) external virtual {}
}
