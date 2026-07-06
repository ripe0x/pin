// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IMintHook} from "../interfaces/IMintHook.sol";

interface ICollectionOwner {
    function owner() external view returns (address);
}

/// @title HookBase
/// @notice Shared base for the reference mint hooks. A hook is attached to a
///         collection with setMintHook (owner-only) and configured per-collection by
///         that collection's current owner. These hooks are public goods: one
///         deployed instance serves many collections, keyed by msg.sender (the
///         calling collection) in the mint callbacks, and any collection on or off PND
///         can point at it. They only gate or record; they never touch funds
///         (non-payable, and the core computes the split from msg.value).
abstract contract HookBase is IMintHook {
    /// @dev Per-collection configuration is restricted to that collection's owner.
    modifier onlyCollectionOwner(address collection) {
        require(msg.sender == ICollectionOwner(collection).owner(), "SC: not collection owner");
        _;
    }

    /// @dev Default afterMint is a no-op. Hooks that record state override it.
    function afterMint(address, uint256, uint256, address, bytes calldata) external virtual {}
}
