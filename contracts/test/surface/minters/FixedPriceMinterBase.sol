// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {SurfaceBase} from "../SurfaceBase.sol";
import {Surface} from "../../../src/surface/Surface.sol";
import {FixedPriceMinter, FixedPriceMinterInitParams} from "../../../src/surface/minters/FixedPriceMinter.sol";

/// @dev Shared deployment + helpers for the FixedPriceMinter test suite.
///      Extends SurfaceBase so collection deployment (artist/collector/
///      referrer/stranger, MockRenderer, SurfaceFactory) is not duplicated.
contract FixedPriceMinterBase is SurfaceBase {
    /// @dev A fresh, uninitialized EIP-1167 clone of the minter implementation.
    function _freshMinterClone() internal returns (FixedPriceMinter) {
        return FixedPriceMinter(Clones.clone(address(minterImpl)));
    }

    /// @dev Full init params with every optional field at its open/unlimited
    ///      default and payoutRecipient defaulted to `artist` (initialize()
    ///      requires it nonzero). Override individual fields on the returned
    ///      struct before calling initialize().
    function _minterParams(address collection_, uint256 price_)
        internal
        view
        returns (FixedPriceMinterInitParams memory p)
    {
        p.collection = collection_;
        p.price = price_;
        p.payoutRecipient = artist;
    }

    /// @dev Deploy a collection, deploy and initialize a minter clone for it
    ///      with the given fixed price and no other config, and grant the
    ///      minter on the collection. The common happy-path setup. The
    ///      collection is already live (owned by `artist`) by the time the
    ///      minter initializes, so standalone init requires the collection's
    ///      owner/admin authority (FixedPriceMinter.initialize's caller gate).
    function _collectionWithMinter(uint256 price_) internal returns (Surface c, FixedPriceMinter m) {
        c = _collection(_freeConfig());
        m = _freshMinterClone();
        vm.prank(artist);
        m.initialize(_minterParams(address(c), price_));
        vm.prank(artist);
        c.setMinter(address(m), true);
    }

    /// @dev Same as _collectionWithMinter but the caller supplies full init
    ///      params (for window/cap/allowlist/strategy/payout scenarios).
    function _collectionWithConfiguredMinter(FixedPriceMinterInitParams memory p)
        internal
        returns (Surface c, FixedPriceMinter m)
    {
        c = _collection(_freeConfig());
        m = _freshMinterClone();
        p.collection = address(c);
        vm.prank(artist);
        m.initialize(p);
        vm.prank(artist);
        c.setMinter(address(m), true);
    }

    // ── Merkle helpers (OZ standard-merkle-tree leaf format, sorted-pair hash) ──

    function _leaf(address account) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account))));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev A 2-leaf tree over (allowed1, allowed2). Returns the root and
    ///      each leaf's single-element proof.
    function _twoLeafTree(address allowed1, address allowed2)
        internal
        pure
        returns (bytes32 root, bytes32[] memory proof1, bytes32[] memory proof2)
    {
        bytes32 leaf1 = _leaf(allowed1);
        bytes32 leaf2 = _leaf(allowed2);
        root = _hashPair(leaf1, leaf2);
        proof1 = new bytes32[](1);
        proof1[0] = leaf2;
        proof2 = new bytes32[](1);
        proof2[0] = leaf1;
    }
}
