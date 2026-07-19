// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {HookBase} from "./HookBase.sol";
import {IMintHook} from "../interfaces/IMintHook.sol";

/// @title PerWalletCapHook
/// @notice Caps how many tokens one wallet can mint from a collection. The
///         collection sets the cap; the hook counts per (collection, minter).
contract PerWalletCapHook is HookBase {
    mapping(address => uint256) public capOf; // collection => per-wallet cap (0 = unlimited)
    mapping(address => mapping(address => uint256)) public mintedBy; // collection => minter => count

    error WalletCapExceeded(uint256 cap, uint256 attempted);

    event CapSet(address indexed collection, uint256 cap);

    function setCap(address collection, uint256 cap) external onlySurfaceAdmin(collection) {
        capOf[collection] = cap;
        emit CapSet(collection, cap);
    }

    function beforeMint(address minter, uint256 quantity, uint256, address, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        uint256 cap = capOf[msg.sender];
        if (cap != 0) {
            uint256 attempted = mintedBy[msg.sender][minter] + quantity;
            if (attempted > cap) revert WalletCapExceeded(cap, attempted);
        }
        return IMintHook.beforeMint.selector;
    }

    /// @dev Counts only after the mint succeeds (afterMint runs post-payment).
    function afterMint(address minter, uint256 quantity, uint256, address, bytes calldata) external override {
        mintedBy[msg.sender][minter] += quantity;
    }
}
