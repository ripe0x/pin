// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IMintHook} from "../interfaces/IMintHook.sol";
import {ICollectionAuth} from "../interfaces/ICollectionAuth.sol";

/// @title HookChain
/// @notice Composes mint hooks: a collection has one hook slot, and this is
///         how one slot holds several gates. Point the collection's mintHook
///         at a chain and every mint runs the whole list, in order — an
///         allowlist AND a per-wallet cap, not one or the other.
///
///         A chain is born final: the collection and the hook list are fixed
///         in the constructor, no setters, no owner. To change the gates,
///         deploy a new chain (cheap) and point the slot at it — same
///         deploy-and-swap move as everything else in the slot architecture.
///
///         The chain is the caller the sub-hooks see (their config is keyed
///         by msg.sender), so configure each stock hook AGAINST THE CHAIN's
///         address: `allowlist.setRoot(address(chain), root)`,
///         `cap.setCap(address(chain), 2)`. Their admin checks still land on
///         the right people — the chain answers ICollectionAuth by
///         forwarding owner()/isAdmin() to its collection.
///
///         One `hookData` payload travels to every hook in the chain. Stock
///         hooks that ignore it (per-wallet cap, holds-collection) compose
///         freely with one that decodes it (allowlist); two hooks that both
///         decode it must agree on its shape.
contract HookChain is IMintHook, ICollectionAuth {
    /// @notice The collection this chain serves; the only address allowed to
    ///         call the mint callbacks.
    address public immutable collection;

    /// @dev Fixed in the constructor, never mutated (no setter exists).
    address[] private _hooks;

    error CollectionRequired();
    error NotCollection();
    error ZeroHook();
    error HookNotContract(address hook);
    error ChainedHookRejected(address hook);

    constructor(address collection_, address[] memory hooks_) {
        if (collection_ == address(0) || collection_.code.length == 0) {
            revert CollectionRequired();
        }
        collection = collection_;
        for (uint256 i = 0; i < hooks_.length; i++) {
            if (hooks_[i] == address(0)) revert ZeroHook();
            if (hooks_[i].code.length == 0) revert HookNotContract(hooks_[i]);
            _hooks.push(hooks_[i]);
        }
    }

    /// @notice The chained hooks, in run order. Fixed for life.
    function hooks() external view returns (address[] memory) {
        return _hooks;
    }

    // ── ICollectionAuth (forwarded, so sub-hook config lands on the right
    //    people even though their storage is keyed by this chain) ───────────

    function owner() external view override returns (address) {
        return ICollectionAuth(collection).owner();
    }

    function isAdmin(address account) external view override returns (bool) {
        return ICollectionAuth(collection).isAdmin(account);
    }

    // ── IMintHook (fan-out) ──────────────────────────────────────────────────

    /// @notice Every hook must answer yes; the first refusal stops the mint.
    ///         A sub-hook's own revert bubbles up with its reason; a wrong
    ///         selector reverts here naming the hook that said no.
    function beforeMint(address minter, uint256 quantity, uint256 firstTokenId, address referrer, bytes calldata data)
        external
        override
        returns (bytes4)
    {
        if (msg.sender != collection) revert NotCollection();
        for (uint256 i = 0; i < _hooks.length; i++) {
            bytes4 answer = IMintHook(_hooks[i]).beforeMint(minter, quantity, firstTokenId, referrer, data);
            if (answer != IMintHook.beforeMint.selector) revert ChainedHookRejected(_hooks[i]);
        }
        return IMintHook.beforeMint.selector;
    }

    function afterMint(address minter, uint256 quantity, uint256 firstTokenId, address referrer, bytes calldata data)
        external
        override
    {
        if (msg.sender != collection) revert NotCollection();
        for (uint256 i = 0; i < _hooks.length; i++) {
            IMintHook(_hooks[i]).afterMint(minter, quantity, firstTokenId, referrer, data);
        }
    }
}
