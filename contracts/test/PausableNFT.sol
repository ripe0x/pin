// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {Pausable} from "openzeppelin-contracts/contracts/utils/Pausable.sol";

/// @notice ERC721 mock that can pause transfers and burn tokens. Used to
///         exercise SovereignAuctionHouseV2's settle/claim split against a
///         collection that refuses delivery (issue #289).
contract PausableNFT is ERC721, Pausable {
    constructor() ERC721("Pausable", "PAUSE") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function burn(uint256 tokenId) external {
        _burn(tokenId);
    }

    function pause() external {
        _pause();
    }

    function unpause() external {
        _unpause();
    }

    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override whenNotPaused returns (address) {
        return super._update(to, tokenId, auth);
    }
}
