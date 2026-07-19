// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceCore} from "./SurfaceCore.sol";
import {IPooledSurface} from "./interfaces/IPooledSurface.sol";
import {ISurfaceCore} from "./interfaces/ISurfaceCore.sol";
import {SurfaceStatus, IdMode} from "./SurfaceTypes.sol";

/// @title PooledSurface
/// @notice Pooled ERC721 collection where the token id has meaning outside this
///         contract (tokenId == sourceId). The authorized minter chooses every
///         id and is the only address that can burn. Holds one minter at a time
///         and can freeze it via lockMinter, so another minter cannot affect
///         these tokens. A burned id may be minted again as a new instance with
///         a fresh seed; the prior instance's history remains in the event log.
///
///         No built-in paid mint entrypoint; mints go through the minter.
contract PooledSurface is SurfaceCore, IPooledSurface {
    function idMode() public pure override(SurfaceCore, ISurfaceCore) returns (IdMode) {
        return IdMode.Pooled;
    }

    /// @dev Cap bounds live supply; a burn frees capacity. The structural bound
    ///      is the pool itself, enforced by the minter.
    function _capUsage() internal view override returns (uint256) {
        return totalSupply();
    }

    /// @dev A filled pooled cap never closes the collection; the next burn frees
    ///      capacity again.
    function _capFilled() internal pure override returns (bool) {
        return false;
    }

    /// @dev Minters only. The core enforces a single minter at a time for the
    ///      pooled id mode, freezable via lockMinter. The minter mints and
    ///      burns; holders redeem through it.
    function _burnAuthorized(address, uint256) internal view override returns (bool) {
        return _minters[msg.sender];
    }

    /// @notice Authorized minters only: mint a specific id (id 0 is valid).
    ///         Hooks and the cap apply; the sale window does not, since the
    ///         minter controls its own schedule.
    function mintToId(address to, uint256 tokenId, address referrer, bytes calldata hookData)
        external
        override
        nonReentrant
    {
        if (!_minters[msg.sender]) revert NotMinter();
        _checkCap(1);
        _runBeforeHook(to, 1, tokenId, referrer, hookData);
        SurfaceStatus statusAtMint = _lifecycleStatus();
        uint256 mintIndex = _mintedEver;
        _mintOne(to, tokenId);
        _runAfterHook(to, 1, tokenId, referrer, hookData);
        emit Minted(to, referrer, tokenId, 1, mintIndex, statusAtMint);
    }
}
