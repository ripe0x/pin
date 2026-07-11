// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";

import {HookBase} from "./HookBase.sol";
import {IMintHook} from "../interfaces/IMintHook.sol";

/// @title HoldsCollectionHook
/// @notice The continuity primitive: to mint from collection B, hold a token
///         from collection A. The people who took provenance risk early get
///         the door held open later, and nothing is financialized to do it.
///         Any ERC721 can be the required collection.
contract HoldsCollectionHook is HookBase {
    mapping(address => address) public requiredOf; // collection => required collection (0 = no gate)

    error MustHoldRequired(address required);

    event RequiredSet(address indexed collection, address required);

    function setRequired(address collection, address required) external onlyCollectionAdmin(collection) {
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
