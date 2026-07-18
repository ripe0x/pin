// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";

import {HookBase} from "./HookBase.sol";
import {IMintHook} from "../interfaces/IMintHook.sol";

/// @title HoldsSurfaceHook
/// @notice Gates minting from collection B on holding a token from a required
///         collection A: the minter must have a nonzero balance in the
///         required collection. Any ERC721 can be the required collection.
contract HoldsSurfaceHook is HookBase {
    mapping(address => address) public requiredOf; // collection => required collection (0 = no gate)

    error MustHoldRequired(address required);

    event RequiredSet(address indexed collection, address required);

    function setRequired(address collection, address required) external onlySurfaceAdmin(collection) {
        requiredOf[collection] = required;
        emit RequiredSet(collection, required);
    }

    function beforeMint(address minter, uint256, uint256, address, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        address required = requiredOf[msg.sender];
        if (required != address(0)) {
            if (IERC721(required).balanceOf(minter) == 0) revert MustHoldRequired(required);
        }
        return IMintHook.beforeMint.selector;
    }
}
