// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceCore} from "./SurfaceCore.sol";
import {ISurface} from "./interfaces/ISurface.sol";
import {ISurfaceCore} from "./interfaces/ISurfaceCore.sol";
import {IdMode} from "./SurfaceTypes.sol";

/// @title Surface
/// @notice Sequential-id ERC721 collection.
contract Surface is SurfaceCore, ISurface {
    function idMode() public pure override(SurfaceCore, ISurfaceCore) returns (IdMode) {
        return IdMode.Sequential;
    }

    /// @dev Cap bounds total mints ever; burning a token does not free capacity.
    function _capUsage() internal view override returns (uint256) {
        return _mintedEver;
    }

    /// @dev Burn allowed for the token holder or an address the holder approved.
    function _burnAuthorized(address tokenOwner, uint256 tokenId) internal view override returns (bool) {
        return _isAuthorized(tokenOwner, msg.sender, tokenId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint: authorized minters only (economics live in the minter)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Authorized minters only. Non-payable: the calling minter
    ///         handles all economics. Mints `quantity` tokens with ids
    ///         `firstTokenId .. firstTokenId + quantity - 1` in one call, one
    ///         Minted event.
    function mintTo(address to, uint256 quantity) external override nonReentrant returns (uint256 firstTokenId) {
        if (!_minters[msg.sender]) revert NotMinter();
        if (quantity == 0) revert ZeroQuantity();
        _checkCap(quantity);
        uint256 firstMintIndex = _mintedEver;
        firstTokenId = firstMintIndex + 1;
        for (uint256 i = 0; i < quantity; i++) {
            _mintOne(to, firstTokenId + i, firstMintIndex + i);
        }
        // Written once per call regardless of quantity: every iteration's
        // order is already fixed by firstMintIndex + i above.
        _mintedEver = firstMintIndex + quantity;
        emit Minted(msg.sender, to, firstTokenId, quantity, firstMintIndex);
    }
}
