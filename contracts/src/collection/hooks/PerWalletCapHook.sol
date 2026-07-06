// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {HookBase} from "./HookBase.sol";
import {IMintHook} from "../interfaces/IMintHook.sol";

/// @title PerWalletCapHook
/// @notice Caps how many tokens any one wallet can mint from a collection, so a
///         capped drop cannot be bought out by a single address in one tx. The
///         collection owner sets the cap; the hook counts per (collection, minter).
contract PerWalletCapHook is HookBase {
    mapping(address => uint256) public capOf; // collection => per-wallet cap (0 = unlimited)
    mapping(address => mapping(address => uint256)) public mintedBy; // collection => minter => count

    event CapSet(address indexed collection, uint256 cap);

    function setCap(address collection, uint256 cap) external onlyCollectionOwner(collection) {
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
            require(mintedBy[msg.sender][minter] + quantity <= cap, "SC: wallet cap");
        }
        return IMintHook.beforeMint.selector;
    }

    /// @dev Count only after the mint succeeds (afterMint runs post-payment).
    function afterMint(address minter, uint256 quantity, uint256, address, bytes calldata)
        external
        override
    {
        mintedBy[msg.sender][minter] += quantity;
    }
}
