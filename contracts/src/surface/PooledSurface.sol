// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceCore} from "./SurfaceCore.sol";
import {IPooledSurface} from "./interfaces/IPooledSurface.sol";
import {ISurfaceCore} from "./interfaces/ISurfaceCore.sol";
import {IdMode} from "./SurfaceTypes.sol";

/// @title PooledSurface
/// @notice ERC721 collection with minter-assigned ids (tokenId == sourceId):
///         one authorized minter at a time chooses every id and is the only
///         address that can burn; lockMinter freezes it permanently. A burned
///         id can be minted again as a new instance with a fresh seed. No
///         built-in mint economics; minting goes through the minter.
contract PooledSurface is SurfaceCore, IPooledSurface {
    function idMode() public pure override(SurfaceCore, ISurfaceCore) returns (IdMode) {
        return IdMode.Pooled;
    }

    /// @dev Cap bounds live supply; a burn frees capacity. The structural bound
    ///      is the pool itself, enforced by the minter.
    function _capUsage() internal view override returns (uint256) {
        return totalSupply();
    }

    /// @dev Minters only. The core enforces a single minter at a time for the
    ///      pooled id mode, freezable via lockMinter. The minter mints and
    ///      burns; holders redeem through it.
    function _burnAuthorized(address, uint256) internal view override returns (bool) {
        return _minters[msg.sender];
    }

    /// @notice Authorized minters only: mint a specific id (id 0 is valid).
    ///         Non-payable: the calling minter handles all economics.
    function mintToId(address to, uint256 tokenId) external override nonReentrant {
        if (!_minters[msg.sender]) revert NotMinter();
        _checkCap(1);
        uint256 mintIndex = _mintedEver;
        _mintOne(to, tokenId);
        emit Minted(msg.sender, to, tokenId, 1, mintIndex);
    }
}
