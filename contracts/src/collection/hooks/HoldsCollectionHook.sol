// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";

import {HookBase} from "./HookBase.sol";
import {IMintHook} from "../interfaces/IMintHook.sol";

/// @title HoldsCollectionHook
/// @notice The continuity primitive: gate a mint on the minter holding a token
///         from another collection (typically an earlier collection). This rewards
///         conviction, the people who took provenance risk on collection A get
///         access to collection B, without financializing anything. The collection
///         owner sets the required collection; any ERC721 (incl. a PND collection)
///         works.
contract HoldsCollectionHook is HookBase {
    mapping(address => address) public requiredOf; // collection => required collection (0 = no gate)

    event RequiredSet(address indexed collection, address required);

    function setRequired(address collection, address required) external onlyCollectionOwner(collection) {
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
            require(IERC721(required).balanceOf(minter) > 0, "SC: must hold required collection");
        }
        return IMintHook.beforeMint.selector;
    }
}
