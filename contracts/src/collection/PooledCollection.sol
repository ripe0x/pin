// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {CollectionCore} from "./CollectionCore.sol";
import {IPooledCollection} from "./interfaces/IPooledCollection.sol";
import {ICollectionCore} from "./interfaces/ICollectionCore.sol";
import {CollectionStatus, IdMode} from "./CollectionTypes.sol";

/// @title PooledCollection
/// @notice The pooled collection — for backed and sourced forms where the
///         token id means something outside this contract (tokenId ==
///         sourceId). The authorized minter owns the id pool: it chooses
///         every id, and it alone can burn, so a token's backing can never be
///         stranded from outside the pool's own economics. A burned id may
///         mint again as a new instance with a fresh seed; the old instance's
///         history stays in the log.
///
///         There is no public sale entrypoint anywhere in this contract — a
///         pooled work sells through its minter. The absence is the rule.
contract PooledCollection is CollectionCore, IPooledCollection {
    function idMode() public pure override(CollectionCore, ICollectionCore) returns (IdMode) {
        return IdMode.Pooled;
    }

    /// @dev The cap bounds LIVE supply: a burn frees room. The structural
    ///      bound is the pool itself, enforced by the minter.
    function _capUsage() internal view override returns (uint256) {
        return totalSupply();
    }

    /// @dev A full pooled cap never closes the collection — the next burn
    ///      opens it again.
    function _capFilled() internal pure override returns (bool) {
        return false;
    }

    /// @dev Minters only. The minter issues and retires; holders redeem
    ///      through it, never around it.
    function _burnAuthorized(address, uint256) internal view override returns (bool) {
        return _minters[msg.sender];
    }

    /// @notice Authorized minters only: mint a specific id (id 0 is legal).
    ///         Hooks and the cap apply; the sale window does not — the minter
    ///         owns its own schedule.
    function mintToId(address to, uint256 tokenId, address referrer, bytes calldata hookData)
        external
        override
        nonReentrant
    {
        if (!_minters[msg.sender]) revert NotMinter();
        _checkCap(1);
        _runBeforeHook(to, 1, tokenId, referrer, hookData);
        CollectionStatus statusAtMint = _lifecycleStatus();
        uint256 mintIndex = _mintedEver;
        _mintOne(to, tokenId);
        _runAfterHook(to, 1, tokenId, referrer, hookData);
        emit Minted(to, referrer, tokenId, 1, mintIndex, statusAtMint);
    }
}
