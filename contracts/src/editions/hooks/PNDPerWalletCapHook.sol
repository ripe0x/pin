// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {PNDHookBase} from "./PNDHookBase.sol";
import {IPNDMintHook} from "../interfaces/IPNDMintHook.sol";

/// @title PNDPerWalletCapHook
/// @notice Caps how many tokens any one wallet can mint from an edition, so a
///         capped drop cannot be bought out by a single address in one tx. The
///         edition owner sets the cap; the hook counts per (edition, minter).
contract PNDPerWalletCapHook is PNDHookBase {
    mapping(address => uint256) public capOf; // edition => per-wallet cap (0 = unlimited)
    mapping(address => mapping(address => uint256)) public mintedBy; // edition => minter => count

    event CapSet(address indexed edition, uint256 cap);

    function setCap(address edition, uint256 cap) external onlyEditionOwner(edition) {
        capOf[edition] = cap;
        emit CapSet(edition, cap);
    }

    function beforeMint(address minter, uint256 quantity, uint256, address, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        uint256 cap = capOf[msg.sender];
        if (cap != 0) {
            require(mintedBy[msg.sender][minter] + quantity <= cap, "PND: wallet cap");
        }
        return IPNDMintHook.beforeMint.selector;
    }

    /// @dev Count only after the mint succeeds (afterMint runs post-payment).
    function afterMint(address minter, uint256 quantity, uint256, address, bytes calldata)
        external
        override
    {
        mintedBy[msg.sender][minter] += quantity;
    }
}
