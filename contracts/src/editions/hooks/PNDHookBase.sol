// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IPNDMintHook} from "../interfaces/IPNDMintHook.sol";

interface IEditionOwner {
    function owner() external view returns (address);
}

/// @title PNDHookBase
/// @notice Shared base for the PND reference mint hooks. A hook is attached to an
///         edition with setMintHook (owner-only) and configured per-edition by
///         that edition's current owner. These hooks are public goods: one
///         deployed instance serves many editions, keyed by msg.sender (the
///         calling edition) in the mint callbacks, and any edition on or off PND
///         can point at it. They only gate or record; they never touch funds
///         (non-payable, and the core computes the split from msg.value).
abstract contract PNDHookBase is IPNDMintHook {
    /// @dev Per-edition configuration is restricted to that edition's owner.
    modifier onlyEditionOwner(address edition) {
        require(msg.sender == IEditionOwner(edition).owner(), "PND: not edition owner");
        _;
    }

    /// @dev Default afterMint is a no-op. Hooks that record state override it.
    function afterMint(address, uint256, uint256, address, bytes calldata) external virtual {}
}
