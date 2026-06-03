// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";

import {PNDHookBase} from "./PNDHookBase.sol";
import {IPNDMintHook} from "../interfaces/IPNDMintHook.sol";

/// @title PNDHoldsEditionHook
/// @notice The continuity primitive: gate a mint on the minter holding a token
///         from another collection (typically an earlier edition). This rewards
///         conviction, the people who took provenance risk on edition A get
///         access to edition B, without financializing anything. The edition
///         owner sets the required collection; any ERC721 (incl. a PND edition)
///         works.
contract PNDHoldsEditionHook is PNDHookBase {
    mapping(address => address) public requiredOf; // edition => required collection (0 = no gate)

    event RequiredSet(address indexed edition, address required);

    function setRequired(address edition, address required) external onlyEditionOwner(edition) {
        requiredOf[edition] = required;
        emit RequiredSet(edition, required);
    }

    function beforeMint(address minter, uint256, uint256, address, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        address required = requiredOf[msg.sender];
        if (required != address(0)) {
            require(IERC721(required).balanceOf(minter) > 0, "PND: must hold required edition");
        }
        return IPNDMintHook.beforeMint.selector;
    }
}
