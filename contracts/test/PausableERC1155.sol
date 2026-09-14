// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC1155} from "openzeppelin-contracts/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Pausable} from "openzeppelin-contracts/contracts/token/ERC1155/extensions/ERC1155Pausable.sol";

/// @notice ERC1155 mock that can pause transfers. Used to exercise
///         SovereignAuctionHouseV2's settle/claim split against a collection
///         that refuses delivery (issue #289).
contract PausableERC1155 is ERC1155Pausable {
    constructor() ERC1155("") {}

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }

    function pause() external {
        _pause();
    }

    function unpause() external {
        _unpause();
    }
}
